import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

const RENDER_SCRIPT = `
import sys, os
pdf_path, page_num, dpi, out_path = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
try:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf_path)
    if page_num < 1 or page_num > len(doc):
        sys.stderr.write(f"PAGE_OUT_OF_RANGE:{len(doc)}")
        sys.exit(2)
    page = doc[page_num - 1]
    bitmap = page.render(scale=dpi / 72.0)
    pil_image = bitmap.to_pil()
    pil_image.save(out_path, format="PNG")
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
    pix.save(out_path)
    sys.stdout.write(str(len(doc)))
    sys.exit(0)
except ImportError:
    sys.stderr.write("NO_PDF_RENDERER")
    sys.exit(3)
`

export async function renderPdfPage({ pdfFile, cacheDir, page, dpi = 180, pythonBin = 'python3' }) {
  const pageNum = Math.max(1, Math.round(Number(page) || 1))
  const clampedDpi = Math.max(72, Math.min(300, Math.round(Number(dpi) || 180)))
  await fs.mkdir(cacheDir, { recursive: true })
  const outFile = path.join(cacheDir, `page_${pageNum}_dpi${clampedDpi}.png`)

  try {
    const bytes = await fs.readFile(outFile)
    return { supported: true, bytes, cached: true, page: pageNum }
  } catch {}

  return new Promise((resolve, reject) => {
    execFile(
      pythonBin,
      ['-c', RENDER_SCRIPT, pdfFile, String(pageNum), String(clampedDpi), outFile],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      async (err, stdout, stderr) => {
        if (!err) {
          try {
            const bytes = await fs.readFile(outFile)
            return resolve({
              supported: true,
              bytes,
              cached: false,
              page: pageNum,
              pageCount: Number(stdout.trim()) || null,
            })
          } catch (readErr) {
            return reject(readErr)
          }
        }
        const detail = String(stderr || err.message || '')
        if (detail.includes('NO_PDF_RENDERER') || err.code === 'ENOENT') {
          return resolve({ supported: false, reason: '云端未安装 pypdfium2 或 pymupdf，可下载原 PDF 查看' })
        }
        if (detail.includes('PAGE_OUT_OF_RANGE')) {
          return reject(new Error('请求的 PDF 页码超出范围'))
        }
        return reject(new Error('PDF 单页渲染失败: ' + detail))
      },
    )
  })
}
