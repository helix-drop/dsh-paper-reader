import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {loadSourceMap,taskSourcePdf,translationMapMatches} from './source-map.js'
import {markdownBlocks} from './markdown.js'
import {pruneDirByLru} from './hygiene.js'
import {mapWorkspacePath} from '../../shared/workspace.js'

const RENDER_PDF_PAGE_SCRIPT = `
import sys
pdf_path, page_num, dpi, out_path = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
max_w = int(sys.argv[5]) if len(sys.argv) > 5 else 0
out_fmt = (sys.argv[6] if len(sys.argv) > 6 else "PNG").upper()

def save_pil(img):
    if max_w > 0 and getattr(img, "width", 0) > max_w:
        from PIL import Image
        h = max(1, int(round(img.height * (max_w / img.width))))
        resample = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
        img = img.resize((max_w, h), resample)
    if out_fmt == "JPEG":
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.save(out_path, format="JPEG", quality=82, optimize=True)
    else:
        img.save(out_path, format="PNG", optimize=True)

try:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf_path)
    if page_num < 1 or page_num > len(doc):
        sys.stderr.write(f"PAGE_OUT_OF_RANGE:{len(doc)}")
        sys.exit(2)
    page = doc[page_num - 1]
    bitmap = page.render(scale=dpi / 72.0)
    save_pil(bitmap.to_pil())
    sys.stdout.write(str(len(doc)))
    sys.exit(0)
except ImportError:
    pass
try:
    import fitz
    doc = fitz.open(pdf_path)
    if page_num < 1 or page_num > len(doc):
        sys.stderr.write(f"PAGE_OUT_OF_RANGE:{len(doc)}")
        sys.exit(2)
    page = doc[page_num - 1]
    pix = page.get_pixmap(dpi=dpi)
    if max_w > 0 or out_fmt == "JPEG":
        from PIL import Image
        mode = "RGBA" if pix.alpha else "RGB"
        img = Image.frombytes(mode, [pix.width, pix.height], pix.samples)
        save_pil(img)
    else:
        pix.save(out_path)
    sys.stdout.write(str(len(doc)))
    sys.exit(0)
except ImportError:
    sys.stderr.write("NO_PDF_RENDERER")
    sys.exit(3)
`

const CACHE_FILE_RE = /^page_\d+_dpi\d+(?:_w\d+)?\.(?:png|jpe?g)$/i

function execWithPython(bin, args) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr })
    })
  })
}

export async function renderPdfPage({ pdfFile, cacheDir, page, dpi = 180, format = 'png', maxWidth = 0, pythonBin = 'python3', maxBytes = 80 * 1024 * 1024, maxAgeMs = 30 * 24 * 60 * 60 * 1000 }) {
  const pageNum = Math.max(1, Math.round(Number(page) || 1))
  const clampedDpi = Math.max(48, Math.min(300, Math.round(Number(dpi) || 180)))
  const wantsJpeg = format === 'jpeg' || format === 'jpg'
  const outFmt = wantsJpeg ? 'JPEG' : 'PNG'
  const ext = wantsJpeg ? 'jpg' : 'png'
  const mimeType = wantsJpeg ? 'image/jpeg' : 'image/png'
  const clampedW = Math.max(0, Math.min(2400, Math.round(Number(maxWidth) || 0)))
  await fs.mkdir(cacheDir, { recursive: true })
  const outFile = path.join(cacheDir, `page_${pageNum}_dpi${clampedDpi}${clampedW > 0 ? `_w${clampedW}` : ''}.${ext}`)

  try {
    const bytes = await fs.readFile(outFile)
    const now = new Date()
    void fs.utimes(outFile, now, now).catch(() => {})
    return { supported: true, bytes, mimeType, cached: true, page: pageNum }
  } catch {}

  const candidates = [...new Set([pythonBin, '/opt/homebrew/bin/python3', 'python3'].filter(Boolean))]
  let lastDetail = ''
  for (const bin of candidates) {
    const { err, stdout, stderr } = await execWithPython(bin, [
      '-c',
      RENDER_PDF_PAGE_SCRIPT,
      pdfFile,
      String(pageNum),
      String(clampedDpi),
      outFile,
      String(clampedW),
      outFmt,
    ])
    if (!err) {
      const bytes = await fs.readFile(outFile)
      await pruneDirByLru(cacheDir, { maxBytes, maxAgeMs, filePattern: CACHE_FILE_RE }).catch(() => {})
      return {
        supported: true,
        bytes,
        mimeType,
        cached: false,
        page: pageNum,
        pageCount: Number(String(stdout).trim()) || null,
      }
    }
    const detail = String(stderr || err.message || '')
    if (detail.includes('PAGE_OUT_OF_RANGE')) {
      throw new Error('请求的 PDF 页码超出范围')
    }
    lastDetail = detail
    if (!detail.includes('NO_PDF_RENDERER') && err.code !== 'ENOENT') {
      throw new Error('PDF 单页渲染失败: ' + detail)
    }
  }

  // Fallback to pdftoppm if installed
  const ppmFile = outFile.replace(/\.(?:png|jpe?g)$/i, '')
  const ppm = await execWithPython('pdftoppm', [
    wantsJpeg ? '-jpeg' : '-png',
    '-f', String(pageNum),
    '-l', String(pageNum),
    '-r', String(clampedDpi),
    ...(clampedW > 0 ? ['-scale-to-x', String(clampedW), '-scale-to-y', '-1'] : []),
    '-singlefile',
    pdfFile,
    ppmFile,
  ])
  if (!ppm.err) {
    try {
      const produced = `${ppmFile}.${wantsJpeg ? 'jpg' : 'png'}`
      const bytes = await fs.readFile(produced)
      await pruneDirByLru(cacheDir, { maxBytes, maxAgeMs, filePattern: CACHE_FILE_RE }).catch(() => {})
      return { supported: true, bytes, mimeType, cached: false, page: pageNum, pageCount: null }
    } catch {}
  }

  return {
    supported: false,
    reason: '未安装 pypdfium2、pymupdf 或 pdftoppm，可下载原 PDF 查看',
    detail: lastDetail,
  }
}

const normalize=text=>String(text??'').replace(/\[\^[^\]]+\](?::)?/g,'').replace(/<[^>]*>/g,'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')
const cache=new Map()
export function locateSourceBlocks(blocks,pages){
  const indexed=pages.map(p=>({...p,text:normalize(p.text)}))
  return new Map(blocks.map(block=>{
    const text=normalize(block.text),minimum=block.type==='heading'?12:32
    if(text.length<minimum)return [block.id,null]
    const needle=text.slice(0,96),hits=indexed.filter(p=>p.text.includes(needle))
    const unique=[...new Set(hits.map(p=>p.page))]
    return [block.id,unique.length===1?unique[0]:null]
  }))
}
export async function attachPdfLocations(manager,t,doc){
  // A present but stale sidecar must never fall back to heuristic matching.
  if(manager.original){
    const file=t.legacy?(t.legacy.artifacts.original??t.legacy.artifacts.readingPath):await manager.original(t),text=await fs.readFile(file,'utf8')
    let map
    try{map=await loadSourceMap(manager,file,text)}catch(e){return {...doc,pdfLocationAvailable:false,pdfLocationWarning:e.message,blocks:doc.blocks.map(b=>({...b,pdfPage:null}))}}
    if(map){
      const originalText=doc.standaloneView==='translation'?doc.originalBlocks:doc.blocks
      const originalValid=originalText?.length===map.blocks.length&&originalText.every((b,i)=>b.id===map.blocks[i].markdownBlockId)
      let activeMap=map,translated=doc.standaloneView==='translation'||doc.blocks.some(b=>b.translation)
      if(translated){
        const targetFile=t.legacy?.artifacts?.translation??t.translationPath
        try{
          const targetText=targetFile?await fs.readFile(targetFile,'utf8'):null
          activeMap=targetText?await loadSourceMap(manager,targetFile,targetText):null
          const current=doc.blocks.map(b=>doc.standaloneView==='translation'?b.text:b.translation);if(targetText&&markdownBlocks(targetText).some((b,i)=>b.text!==current[i]))activeMap=null
          if(!translationMapMatches(map,activeMap))activeMap=null
        }catch{activeMap=null}
      }
      const activeIds=new Set(activeMap?.blocks.map(b=>b.blockId)??[]),sourceIndex=new Map(map.blocks.map(b=>[b.markdownBlockId,b])),targetIndex=new Map(activeMap?.blocks.map(b=>[b.markdownBlockId,b])??[])
      const located=b=>{
        const location=originalValid?(doc.standaloneView==='translation'?targetIndex.get(b.id):translated&&activeMap?(activeIds.has(sourceIndex.get(b.id)?.blockId)?sourceIndex.get(b.id):null):!translated?sourceIndex.get(b.id):null):null
        return {...b,originalPdfPage:originalValid?sourceIndex.get(b.id)?.pdfPages[0]??null:null,pdfPage:location?.pdfPages[0]??null,pdfPages:location?.pdfPages??[],sourceParagraphId:location?.blockId}
      }
      const blocks=doc.blocks.map(located)
      return {...doc,blocks,originalBlocks:doc.originalBlocks?.map(b=>({...b,pdfPage:originalValid?sourceIndex.get(b.id)?.pdfPages[0]??null:null})),sourceMapAvailable:true,pdfAvailable:true,sourceMapViews:{original:originalValid,translation:translated&&!!activeMap},pdfLocationAvailable:blocks.some(b=>b.pdfPage),pdfLocationWarning:!originalValid?'正文修订后来源映射需要重新核验':translated&&!activeMap?'译文尚无有效段落来源映射':null}
    }
  }
  const hasDirectPdf=Boolean(t.legacy?.artifacts?.sourcePdf||t.input?.type==='pdf')
  const fallbackPdf=hasDirectPdf?null:await taskSourcePdf(manager,t).catch(()=>null)
  if(!hasDirectPdf&&!fallbackPdf)return doc
  const source=doc.standaloneView==='translation'?doc.originalBlocks??[]:doc.blocks
  let sourcePages=new Map()
  if(t.paperImport){sourcePages=new Map(source.map((b,i)=>[b.id,Number.isInteger((t.paperImport.pages??[])[i])&&(t.paperImport.pages??[])[i]>0?(t.paperImport.pages??[])[i]:null]))}
  else{
    const base=t.legacy?mapWorkspacePath(manager.root,t.legacy.directory):(t.sourceHistory?.directory?mapWorkspacePath(manager.root,t.sourceHistory.directory):manager.docDir(t)),dir=path.join(base,'ai_convert/edits/body')
    const files=(await fs.readdir(dir).catch(()=>[])).filter(f=>/^page_\d+\.json$/.test(f)).sort()
    const stats=await Promise.all(files.map(async file=>{const st=await fs.stat(path.join(dir,file)).catch(()=>null);return file+':'+(st?st.size+':'+st.mtimeMs:'missing')}))
    const stamp=stats.join('|'),cached=cache.get(dir)
    let pages=cached?.stamp===stamp?cached.pages:null
    if(!pages){
      pages=await Promise.all(files.map(async file=>{
        let data;try{data=JSON.parse(await fs.readFile(path.join(dir,file),'utf8'))}catch{return null}
        const page=data.book_page??Number(file.match(/\d+/)[0])
        const texts=[...(Array.isArray(data.paragraphs)?data.paragraphs:[]),...(Array.isArray(data.notes_definitions)?data.notes_definitions:[])].map(p=>p.text??'').join('\n')
        return {page,text:normalize(texts)}
      }));pages=pages.filter(Boolean);cache.set(dir,{stamp,pages});if(cache.size>16)cache.delete(cache.keys().next().value)
    }
    sourcePages=locateSourceBlocks(source,pages)
    if(!t.legacy&&!t.sourceHistory?.directory){
      const profile=await fs.readFile(path.join(base,'document_profile.json'),'utf8').then(JSON.parse).catch(()=>({}))
      const mapping=new Map((profile.source_page_map??[]).map(p=>[p.logical_page,p.source_page]))
      // Without a scope map a normalized page cannot establish the original PDF page.
      sourcePages=new Map([...sourcePages].map(([id,page])=>[id,mapping.get(page)??null]))
    }
  }
  const clean=page=>Number.isInteger(page)&&page>0?page:null
  return {...doc,pdfAvailable:true,pdfLocationAvailable:[...sourcePages.values()].some(p=>clean(p)),
    originalBlocks:doc.originalBlocks?.map(b=>({...b,pdfPage:clean(sourcePages.get(b.id))})),
    blocks:doc.blocks.map(b=>({...b,pdfPage:clean(sourcePages.get(doc.standaloneView==='translation'?b.sourceBlockId:b.id))}))}
}
