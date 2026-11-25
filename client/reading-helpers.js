function matchQuoteRanges(raw, quote) {
  const needle = String(quote ?? '')
  if (!needle || !raw) return []
  const items = []
  for (let i = 0; i < raw.length; i++) items.push({ ch: raw[i], start: i, end: i + 1 })
  const apply = (re, build) => {
    const source = items.map(item => item.ch).join('')
    const next = []
    let last = 0
    for (const match of source.matchAll(re)) {
      next.push(...items.slice(last, match.index))
      next.push(...build(match, items.slice(match.index, match.index + match[0].length)))
      last = match.index + match[0].length
    }
    next.push(...items.slice(last))
    items.length = 0
    items.push(...next)
  }
  apply(/^#{1,6}\s+/gm, () => [])
  apply(/!\[([^\]]*)\]\([^)]+\)/g, (match, slice) => slice.slice(2, 2 + match[1].length))
  apply(/\[([^\]]+)\]\([^)]+\)/g, (match, slice) => slice.slice(1, 1 + match[1].length))
  apply(/\[\^([^\]]+)\](?::\s*)?/g, () => [])
  apply(/\[footnote-\d+\]\\[^\s]+\s*/g, () => [])
  apply(/[*`_]/g, () => [])
  apply(/\s+/g, (_match, slice) => [{ ch: ' ', start: slice[0].start, end: slice[slice.length - 1].end }])
  while (items[0]?.ch === ' ') items.shift()
  while (items.at(-1)?.ch === ' ') items.pop()
  const plain = items.map(item => item.ch).join('')
  const ranges = []
  for (let index = plain.indexOf(needle); index >= 0; index = plain.indexOf(needle, index + needle.length)) ranges.push([items[index].start, items[index + needle.length - 1].end])
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (!last || range[0] > last[1]) merged.push(range)
    else last[1] = Math.max(last[1], range[1])
  }
  return merged
}
function clampPopupToBounds(bounds, anchor, box, options = {}) {
  const preferAbove = options.preferAbove !== false
  const gap = options.gap ?? 10
  const margin = options.margin ?? 12
  const hostLeft = bounds.left ?? 0
  const hostTop = bounds.top ?? 0
  const hostWidth = Math.max(1, bounds.width ?? 0)
  const hostHeight = Math.max(1, bounds.height ?? 0)
  const boxWidth = Math.min(box.width || 0, Math.max(0, hostWidth - margin * 2))
  const boxHeight = Math.min(box.height || 0, Math.max(0, hostHeight - margin * 2))
  const relCenterX = (anchor.centerX ?? (((anchor.left ?? 0) + (anchor.right ?? anchor.left ?? 0)) / 2)) - hostLeft
  const relTop = (anchor.top ?? 0) - hostTop
  const relBottom = (anchor.bottom ?? anchor.top ?? 0) - hostTop
  const maxLeft = Math.max(margin, hostWidth - boxWidth - margin)
  const left = Math.max(margin, Math.min(relCenterX - boxWidth / 2, maxLeft))
  const aboveTop = relTop - boxHeight - gap
  const belowTop = relBottom + gap
  const fitsAbove = aboveTop >= margin
  const fitsBelow = belowTop + boxHeight <= hostHeight - margin
  const maxTop = Math.max(margin, hostHeight - boxHeight - margin)
  let top
  let below = false
  if (preferAbove) {
    if (fitsAbove) { top = aboveTop; below = false }
    else if (fitsBelow) { top = belowTop; below = true }
    else {
      below = (hostHeight - margin - relBottom) >= (relTop - margin)
      top = Math.max(margin, Math.min(below ? belowTop : aboveTop, maxTop))
    }
  } else {
    if (fitsBelow) { top = belowTop; below = true }
    else if (fitsAbove) { top = aboveTop; below = false }
    else {
      below = (hostHeight - margin - relBottom) >= (relTop - margin)
      top = Math.max(margin, Math.min(below ? belowTop : aboveTop, maxTop))
    }
  }
  return { left: Math.round(hostLeft + left), top: Math.round(hostTop + top), below }
}
function measurePopupPosition(node, anchorRect, options = {}) {
  const shell = node?.closest?.('.rr-shell')
  const shellRect = shell?.getBoundingClientRect?.()
  const scaleX = shell && shell.offsetWidth ? (shellRect.width / shell.offsetWidth) || 1 : 1
  const scaleY = shell && shell.offsetHeight ? (shellRect.height / shell.offsetHeight) || 1 : 1
  const hostOriginLeft = shellRect ? shellRect.left : 0
  const hostOriginTop = shellRect ? shellRect.top : 0
  const visLeft = shellRect ? Math.max(shellRect.left, 0) : 0
  const visTop = shellRect ? Math.max(shellRect.top, 0) : 0
  const visRight = shellRect ? Math.min(shellRect.right, window.innerWidth) : window.innerWidth
  const visBottom = shellRect ? Math.min(shellRect.bottom, window.innerHeight) : window.innerHeight
  const bounds = {
    left: (visLeft - hostOriginLeft) / scaleX,
    top: (visTop - hostOriginTop) / scaleY,
    width: Math.max(1, (visRight - visLeft) / scaleX),
    height: Math.max(1, (visBottom - visTop) / scaleY),
  }
  const anchor = {
    left: (anchorRect.left - hostOriginLeft) / scaleX,
    right: ((anchorRect.right ?? anchorRect.left) - hostOriginLeft) / scaleX,
    top: (anchorRect.top - hostOriginTop) / scaleY,
    bottom: ((anchorRect.bottom ?? anchorRect.top) - hostOriginTop) / scaleY,
  }
  const box = {
    width: node?.offsetWidth || options.fallbackWidth || 320,
    height: node?.offsetHeight || options.fallbackHeight || 82,
  }
  return clampPopupToBounds(bounds, anchor, box, options)
}
function SelectionBookmark({ source, view='original', scope, title, disabled=false, savedMarks=[], onSaved, onExplain, onCite }) {
  const [selection,setSelection]=useState(null),[editing,setEditing]=useState(false),[comment,setComment]=useState(''),[tags,setTags]=useState(''),[style,setStyle]=useState('highlight'),[color,setColor]=useState('gold'),[error,setError]=useState(''),[saving,setSaving]=useState(false),[notice,setNotice]=useState(''),[capsulePos,setCapsulePos]=useState(null)
  const capsuleRef=useRef(null)
  useEffect(()=>{if(disabled)setSelection(null);const pick=()=>{if(editing||disabled)return;const selected=window.getSelection();
    if(!selected||selected.isCollapsed||!selected.rangeCount){setSelection(null);return}const range=selected.getRangeAt(0),element=n=>n.nodeType===1?n:n.parentElement,start=element(range.startContainer)?.closest('[data-bookmark-block]'),end=element(range.endContainer)?.closest('[data-bookmark-block]');
    if(!start||!end||!start.closest(scope)||!end.closest(scope)){setSelection(null);return}const selectionView=start.dataset.bookmarkView??view;
    if(selectionView!==(end.dataset.bookmarkView??view)){setSelection(null);return}const clean=r=>{const box=document.createElement('div');
    box.append(r.cloneContents());box.querySelectorAll('.rr-originalButton,.rr-blockBookmark,.rr-chapterNo,.rr-blockLabel,.rr-readingBlockActions,.rr-footnoteLink,.rr-footnoteAccordion,.rr-noteBubble').forEach(n=>n.remove());
    box.querySelectorAll('p,h2,h3,blockquote').forEach(n=>n.append(document.createTextNode(' ')));return box.textContent.replace(/\s+/g,' ').trim()};
    const exact=clean(range);if(!exact||exact.length>20000){setSelection(null);return}const prefixRange=range.cloneRange();
    prefixRange.selectNodeContents(start);prefixRange.setEnd(range.startContainer,range.startOffset);const suffixRange=range.cloneRange();
    suffixRange.selectNodeContents(end);suffixRange.setStart(range.endContainer,range.endOffset);const rect=range.getBoundingClientRect();
    const anchorRect={left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}
    const initPos=measurePopupPosition(start,anchorRect,{preferAbove:true,gap:10,margin:12,fallbackWidth:360,fallbackHeight:84})
    setSelection({exact,prefix:clean(prefixRange).slice(-80),suffix:clean(suffixRange).slice(0,80),startBlockId:start.dataset.bookmarkBlock,endBlockId:end.dataset.bookmarkBlock,view:selectionView,anchorRect,left:initPos.left,top:initPos.top,below:initPos.below});
    setCapsulePos(initPos);setError('')};document.addEventListener('mouseup',pick);document.addEventListener('keyup',pick);return()=>{document.removeEventListener('mouseup',pick);
    document.removeEventListener('keyup',pick)}},[editing,source?.id,source?.kind,view,scope,disabled])
  useEffect(()=>{
    if(!selection||editing)return
    const sync=()=>{
      const node=capsuleRef.current
      if(!node)return
      let anchor=selection.anchorRect
      const sel=window.getSelection()
      if(sel&&!sel.isCollapsed&&sel.rangeCount){
        const r=sel.getRangeAt(0).getBoundingClientRect()
        if(r.width||r.height)anchor={left:r.left,right:r.right,top:r.top,bottom:r.bottom}
      }
      setCapsulePos(measurePopupPosition(node,anchor,{preferAbove:true,gap:10,margin:12}))
    }
    sync()
    window.addEventListener('resize',sync)
    window.addEventListener('scroll',sync,true)
    return()=>{window.removeEventListener('resize',sync);window.removeEventListener('scroll',sync,true)}
  },[selection,editing])
  const save=async()=>{if(saving)return;setSaving(true);try{const response=await fetch('/api/paper-reader/pipeline/bookmarks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,selection,comment,style,color,tags:tags.split(/[，,]/).map(x=>x.trim()).filter(Boolean)})});const value=await response.json();if(!response.ok)throw new Error(value.error??'保存失败');setEditing(false);setSelection(null);setComment('');setTags('');setNotice('想法已保存');window.getSelection()?.removeAllRanges();await onSaved?.()}catch(e){setError(e.message)}finally{setSaving(false)}}
  const sameHighlight=[...new Set((savedMarks??[]).filter(m=>m.kind==='highlight'&&m.view===selection?.view&&m.exact===selection?.exact&&(m.blockId===selection?.startBlockId||m.blockId===selection?.endBlockId)).map(m=>m.id))]
  const highlight=async(pickStyle,pickColor=color)=>{if(saving||!selection)return;setSaving(true);setNotice('');setStyle(pickStyle);setColor(pickColor);try{const existing=savedMarks.find(m=>sameHighlight.includes(m.id));if(existing&&(!pickStyle||existing.style===pickStyle&&existing.color===pickColor)){for(const id of sameHighlight){const response=await fetch('/api/paper-reader/pipeline/bookmarks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,removeHighlight:id})});const value=await response.json();if(!response.ok)throw new Error(value.error??'取消高亮失败')};setNotice('已取消划线')}else{const response=await fetch('/api/paper-reader/pipeline/bookmarks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,selection,style:pickStyle,color:pickColor,highlightOnly:true})});const value=await response.json();if(!response.ok)throw new Error(value.error??'划线失败');setNotice('已'+((HIGHLIGHT_STYLES.find(s=>s.id===pickStyle)?.label)||'划线'))}setSelection(null);
    window.getSelection()?.removeAllRanges();await onSaved?.()}catch(e){setNotice(e.message)}finally{setSaving(false)}}
  const copySel=async()=>{if(!selection)return;try{await navigator.clipboard.writeText(selection.exact);setNotice('已复制选中内容')}catch{setNotice('复制失败')}setSelection(null);window.getSelection()?.removeAllRanges()}
  const pos=capsulePos??selection
  return h(React.Fragment,null,selection&&!editing?h('div',{ref:capsuleRef,className:`rr-wrCapsule ${pos?.below?'below':'above'}`,style:{left:pos?.left??12,top:pos?.top??12},onMouseDown:e=>e.preventDefault()},
    h('div',{className:'rr-wrCapRow'},
      button('复制',copySel,'rr-wrCapBtn',{disabled:saving}),
      HIGHLIGHT_STYLES.map(st=>button(st.label,()=>highlight(st.id,color),'rr-wrCapBtn',{key:st.id,disabled:saving})),
      button('写想法',()=>{setEditing(true);setNotice('')},'rr-wrCapBtn',{disabled:saving}),
      onCite?button('引用',()=>{const s=selection;setSelection(null);window.getSelection()?.removeAllRanges();onCite(s)},'rr-wrCapBtn',{disabled:saving,title:'为当前选中文字生成学术引用'}):null,
      onExplain?button('AI 释义',()=>{const s=selection;setSelection(null);window.getSelection()?.removeAllRanges();onExplain(s)},'rr-wrCapBtn rr-wrCapAi',{disabled:saving}):null
    ),
    h('div',{className:'rr-wrCapColors'},
      HIGHLIGHT_COLORS.map(c=>h('button',{key:c.id,type:'button',className:`rr-wrCapDot ${color===c.id?'active':''}`,style:{background:c.hex},title:c.label,onClick:()=>setColor(c.id)}))
    )
  ):null,notice?h('div',{className:'rr-bookmarkToast',role:'status'},notice):null,editing?h('div',{className:'rr-centeredOverlay',onKeyDown:e=>{if(e.key==='Escape')setEditing(false)}},
    h('section',{className:'rr-centeredDialog',role:'dialog','aria-modal':true,'aria-label':'写想法与笔记'},h('div',{className:'rr-sectionHead'},
    h('h3',null,'写想法与笔记'),button('关闭',()=>setEditing(false),'rr-buttonQuiet')),h('p',{className:'rr-pipelineNote'},title),
    h('blockquote',{...zhScriptAttrs(detectZhScript(selection?.exact))},selection?.exact),
    h('div',{style:{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',margin:'4px 0 8px'}},
      h('div',{className:'rr-viewToggle'},HIGHLIGHT_STYLES.map(st=>button(st.label,()=>setStyle(st.id),style===st.id?'rr-buttonPrimary':'rr-buttonQuiet',{key:st.id}))),
      h('div',{style:{display:'flex',gap:5,alignItems:'center'}},HIGHLIGHT_COLORS.map(c=>h('button',{key:c.id,type:'button',className:`rr-wrColorSwatch ${color===c.id?'active':''}`,style:{background:c.hex},title:c.label,onClick:()=>setColor(c.id)})))
    ),
    h('label',null,'想法批注',
    h('textarea',{value:comment,onChange:e=>setComment(e.target.value),placeholder:'写下阅读想法或批注...',autoFocus:true,rows:4})),
    h('label',null,'标签',h('input',{value:tags,onChange:e=>setTags(e.target.value),placeholder:'用逗号分隔，可留空'})),error?h('p',{role:'alert',className:'rr-error'},error):null,
    h('div',{className:'rr-rowActions'},button(saving?'保存中':'保存想法',save,'rr-buttonPrimary',{disabled:saving}),
    button('取消',()=>setEditing(false),'rr-buttonQuiet')))):null)
}
function UnpairedSource({reading,onOriginal,onEdit,renderOriginal}){
  const [chapter,setChapter]=useState(''),[page,setPage]=useState(0),blocks=reading.originalBlocks??reading.blocks,outline=(reading.originalOutline?.outline??[]).filter(x=>x.level===1)
  const start=blocks.findIndex(x=>x.id===chapter),next=outline.findIndex(x=>x.id===chapter)+1,end=next>0&&outline[next]?blocks.findIndex(x=>x.id===outline[next].id):blocks.length,shown=start>=0?blocks.slice(start,end):[]
  return h('div',null,h('p',{className:'rr-pipelineNote'},'此段尚未确认对应位置。可选择原文章节，人工对照。'),h('select',{'aria-label':'选择原文章节',value:chapter,onChange:e=>{setChapter(e.target.value);
    setPage(0)}},h('option',{value:''},'选择原文章节'),outline.map(x=>h('option',{key:x.id,value:x.id},x.label))),shown.slice(page*6,(page+1)*6).map(b=>h('div',{key:b.id},
    h('div',{'data-bookmark-block':b.id,'data-bookmark-view':'original',...zhScriptAttrs(detectZhScript(b.text)),style:{whiteSpace:'pre-wrap'}},renderOriginal?renderOriginal(b):h('p',null,b.text)))),shown.length?h('div',{className:'rr-rowActions'},
    button('前段',()=>setPage(p=>Math.max(0,p-1)),'rr-buttonQuiet',{disabled:page===0}),button('后段',()=>setPage(p=>p+1),'rr-buttonQuiet',{disabled:(page+1)*6>=shown.length})):null,
    button('打开完整原文',onOriginal,'rr-buttonQuiet'))
}
function serializeCorrectionNode(root,raw,type){
  const read=node=>{if(node.nodeType===3)return node.nodeValue??'';if(node.getAttribute?.('data-editor-ignore')!==null&&node.hasAttribute?.('data-editor-ignore'))return '';const token=node.getAttribute?.('data-note-token');if(token)return token;const tag=node.tagName?.toLowerCase(),text=[...(node.childNodes??[])].map(read).join('');if(tag==='br')return '\n';if(tag==='strong'||tag==='b')return '**'+text+'**';if(tag==='em'||tag==='i')return '*'+text+'*';if(tag==='code')return '`'+text+'`';if(tag==='p'||/^h[1-6]$/.test(tag??'')||tag==='div')return text+'\n';return text};
  let text=[...root.childNodes].map(read).join('').replace(/\n+$/,'');if(type==='heading')text=(raw.match(/^#+\s*/)?.[0]??'')+text;if(type==='quote')text=text.split('\n').map(line=>'> '+line).join('\n');if(type==='footnote'){const def=raw.match(/^(\[\^([^\]]+)\]:\s*)([\s\S]*)/);if(def){const body=footnoteBody(def[3],def[2]);text=def[1]+def[3].slice(0,def[3].length-body.length)+text}}
  const refs=value=>[...value.matchAll(/\[\^[^\]]+\]/g)].map(m=>m[0]).join('|');if(refs(raw)!==refs(text))throw new Error('注号须保留，请撤销对注号的删除');return text
}
function InlineCorrection({children,raw,type,view,onSave,onCancel,busy,onContextMenu}){
  const editor=useRef(null),initial=useRef(children),[error,setError]=useState('');useEffect(()=>{editor.current?.querySelectorAll('[data-note-token]').forEach(n=>n.setAttribute('disabled',''));editor.current?.focus()},[])
  return h('div',{className:'rr-inlineCorrection',onContextMenu},h('div',{ref:editor,className:'rr-liveEditor',role:'textbox','aria-label':view==='original'?'修改原文':'修改译文',contentEditable:!busy,suppressContentEditableWarning:true,onPaste:e=>{e.preventDefault();
    document.execCommand('insertText',false,e.clipboardData.getData('text/plain'))},onKeyDown:e=>{if(e.key==='Escape'){e.stopPropagation();
    onCancel()}if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();try{onSave(serializeCorrectionNode(editor.current,raw,type))}catch(error){setError(error.message)}}}},initial.current),error?h('p',{className:'rr-pipelineNote',role:'alert'},error):null,
    h('div',{className:'rr-inlineEditActions'},button('保存',()=>{try{onSave(serializeCorrectionNode(editor.current,raw,type))}catch(error){setError(error.message)}},'rr-buttonQuiet',{disabled:busy}),
    button('取消',onCancel,'rr-buttonQuiet',{disabled:busy})))
}
function buildFootnoteIndex(blocks,translated=false){
  const entries=new Map(),custom=new Map();const add=(map,key,value)=>{if(map.has(key)){map.set(key,null)}else map.set(key,value)}
  for(const block of blocks){const value=translated?(block.translation??block.text):block.text
    const defs=[...value.matchAll(/(?:^|\n)\[\^([^\]]+)\]:[ \t]*|(?:^|\n)\[footnote-(\d+)\]\\([^\s]+)[ \t]*/g)]
    for(let i=0;i<defs.length;i++){const m=defs[i],text=value.slice(m.index+m[0].length,defs[i+1]?.index??value.length).trim(),entry={blockId:block.id,text,id:m[1]??'p'+Number(m[2])+'_'+m[3]};if(m[1])add(entries,m[1],entry);else add(custom,Number(m[2])+'_'+m[3],entry)}
  }
  return {entries,custom}
}
function resolveFootnote(index,id){if(index.entries.has(id))return index.entries.get(id);const m=id.match(/(?:^|[-_])p0*(\d+)_([^\s]+)$/);return m?index.custom.get(Number(m[1])+'_'+m[2]):undefined}
function footnoteDisplayNumbers(blocks,outline=[],translated=false){
  const index=buildFootnoteIndex(blocks,translated),labels=new Map(),counts=new Map(),chapters=new Set(outline.filter(x=>x.level===1).map(x=>x.id));let chapter='front'
  const assign=(id,scope)=>{if(labels.has(id))return;const alias=resolveFootnote(index,id)?.id;if(alias&&labels.has(alias)){labels.set(id,labels.get(alias));return}const key=id.match(/^(c\d+)[-_]/i)?.[1]??scope,n=(counts.get(key)??0)+1;counts.set(key,n);labels.set(id,String(n));if(alias)labels.set(alias,String(n))}
  const deferred=[];for(const b of blocks){if(chapters.has(b.id))chapter=b.id;const text=translated?(b.translation??b.text):b.text;
    if(/^\[\^([^\]]+)\]:|^\[footnote-\d+\]\\/.test(text)){for(const m of text.matchAll(/(?:^|\n)\[\^([^\]]+)\]:|(?:^|\n)\[footnote-(\d+)\]\\([^\s]+)/g))deferred.push([m[1]??'p'+Number(m[2])+'_'+m[3],chapter]);continue}
    if(b.type==='code')continue;for(const m of text.matchAll(/\[\^([^\]]+)\]/g))assign(m[1],chapter)
  }
  for(const [id,scope] of deferred)assign(id,scope);return labels
}
function footnoteLabel(labels,id){return labels.get(id)??id.match(/(?:^|[-_])(\d+)$/)?.[1]??'·'}
function footnoteBody(text,id){const actual=id.match(/(?:^|[-_])(\d+)$/)?.[1],prefix=text.match(/^(\d+)[.)]\s+/);return actual&&prefix&&Number(actual)===Number(prefix[1])?text.slice(prefix[0].length):text}
function parseFootnoteDefs(text){
  if(typeof text!=='string')return null
  const defs=[...text.matchAll(/(?:^|\n)\[footnote-(\d+)\]\\([^\s]+)[ \t]*/g)]
  if(!defs.length)return null
  const firstIndex=defs[0].index+(defs[0][0].startsWith('\n')?1:0)
  const bodyText=text.slice(0,firstIndex).trim()
  const items=defs.map((m,i)=>{
    const id='p'+Number(m[1])+'_'+m[2]
    const body=text.slice(m.index+m[0].length,defs[i+1]?.index??text.length).trim()
    return {id,page:Number(m[1]),mark:m[2],body}
  })
  return {bodyText,items}
}
function footnotePreviewPosition(anchor,width,height,viewport){return {left:Math.max(12,Math.min(anchor.left,viewport.width-width-12)),top:anchor.bottom+height+12<=viewport.height?anchor.bottom+8:Math.max(12,anchor.top-height-8)}}
function paginateReadingBlocks(blocks,currentView){
  if(!blocks||!blocks.length)return [[]]
  const pages=[]
  let currentPage=[]
  let currentChars=0
  for(let i=0;i<blocks.length;i++){
    const b=blocks[i]
    const raw=currentView==='translation'?(b.translation??b.text):(b.sourceText??b.text)
    const text=typeof raw==='string'?raw:''
    const isHeading=b.type==='heading'||(typeof b.text==='string'&&/^#{1,6}\s+/.test(b.text))
    const headingClean=text.replace(/^#{1,6}\s*/,'').trim()
    const fn=parseFootnoteDefs(text)
    const charCount=(fn?fn.bodyText:text).replace(/\s+/g,'').length+(fn?40:0)
    const isNotesHeading=isHeading&&/^(?:注释|notes|footnotes)$/i.test(headingClean)
    const isMajorChapter=isHeading&&(b.level===1||(b.level===2&&/^(?:第[一二三四五六七八九十百\d]+[章节部篇编]|[ivxlcdm]+[.、\s]|\d+[.、\s]|chapter|part)/i.test(headingClean))||/\(部扉页\)|\(篇扉页\)/.test(headingClean))
    const hasBodyContent=currentPage.some(x=>x.type!=='heading'&&x.text!=='---')
    const shouldBreak=hasBodyContent&&(isMajorChapter||(isHeading&&currentChars>1000&&!isNotesHeading))
    if(shouldBreak){
      pages.push(currentPage)
      currentPage=[b]
      currentChars=charCount
    }else{
      currentPage.push(b)
      currentChars+=charCount
    }
  }
  if(currentPage.length>0)pages.push(currentPage)
  return pages.length?pages:[[]]
}

function stripMarkdownForSearch(raw){
  return String(raw??'')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
    .replace(/\[\^[^\]]+\]/g,'')
    .replace(/^\s{0,3}(?:#{1,6}\s*|>\s?)/gm,'')
    .replace(/(\*\*|__|\*|_|`)/g,'')
    .replace(/\s+/g,' ')
    .trim()
}

function parseDesktopSearchQuery(query){
  const lower=String(query??'').trim().replace(/\s+/g,' ').toLowerCase()
  if(!lower)return {lower:'',tokens:[]}
  return {lower,tokens:[...new Set(lower.split(' ').filter(Boolean))]}
}

function matchDesktopSearchPlain(plain,parsed){
  if(!plain||!parsed.lower)return null
  const hay=plain.toLowerCase()
  const idx=hay.indexOf(parsed.lower)
  if(idx>=0){
    let count=0,pos=0,step=Math.max(1,parsed.lower.length)
    while((pos=hay.indexOf(parsed.lower,pos))>=0){count++;pos+=step}
    return {firstIdx:idx,matchLen:parsed.lower.length,count}
  }
  if(parsed.tokens.length<=1)return null
  let firstIdx=-1,matchLen=0,count=0
  for(const tok of parsed.tokens){
    const hit=hay.indexOf(tok)
    if(hit<0)return null
    if(firstIdx<0||hit<firstIdx){firstIdx=hit;matchLen=tok.length}
    let pos=0
    while((pos=hay.indexOf(tok,pos))>=0){count++;pos+=Math.max(1,tok.length)}
  }
  return {firstIdx,matchLen,count:Math.max(1,count)}
}

function splitSearchSnippetParts(snippet,matchOffset,matchLen){
  const text=String(snippet??'')
  if(!(matchLen>0)||matchOffset<0||matchOffset>=text.length)return [text,'','']
  return [text.slice(0,matchOffset),text.slice(matchOffset,matchOffset+matchLen),text.slice(matchOffset+matchLen)]
}

function highlightInlineSearchParts(str,query,keyPrefix){
  const parsed=parseDesktopSearchQuery(query)
  if(!parsed.lower||!str)return [str]
  const terms=str.toLowerCase().includes(parsed.lower)?[parsed.lower]:parsed.tokens
  const sortedTerms=[...terms].filter(Boolean).sort((a,b)=>b.length-a.length)
  if(!sortedTerms.length)return [str]
  const lower=str.toLowerCase()
  const ranges=[]
  for(const term of sortedTerms){
    let pos=0
    while((pos=lower.indexOf(term,pos))>=0){
      ranges.push([pos,pos+term.length])
      pos+=Math.max(1,term.length)
    }
  }
  if(!ranges.length)return [str]
  ranges.sort((a,b)=>a[0]-b[0]||a[1]-b[1])
  const merged=[]
  for(const r of ranges){
    const prev=merged.at(-1)
    if(!prev||r[0]>prev[1])merged.push([r[0],r[1]])
    else prev[1]=Math.max(prev[1],r[1])
  }
  const out=[];let cur=0
  merged.forEach(([s,e],idx)=>{
    if(s>cur)out.push(str.slice(cur,s))
    out.push(h('mark',{key:`${keyPrefix}-sh-${idx}`,className:'rr-searchHit'},str.slice(s,e)))
    cur=e
  })
  if(cur<str.length)out.push(str.slice(cur))
  return out
}

function searchInReadingBlocks(reading,query,options={}){
  const parsed=parseDesktopSearchQuery(query)
  if(!reading||!parsed.lower)return {totalMatches:0,matches:[]}
  const maxMatches=Math.max(1,Number(options.maxMatches)||200)
  const chapterLookupFor=(outline,blocks)=>{
    const idxMap=new Map((blocks||[]).map((b,i)=>[b.id,i]))
    return (outline||[]).map(it=>({idx:idxMap.get(it.id),label:String(it.label||'').replace(/\s*\((?:部扉页|篇扉页|扉页)\)/g,'').trim()})).filter(x=>x.idx!==undefined).sort((a,b)=>a.idx-b.idx)
  }
  const labelAt=(entries,i)=>{let lbl='';for(const e of entries){if(e.idx>i)break;if(e.label)lbl=e.label}return lbl}
  const matches=[];let totalMatches=0
  const scan=(blocks,outline,hiddenSet,view,getRaw,getBlockId)=>{
    const chapters=chapterLookupFor(outline,blocks)
    ;(blocks||[]).forEach((b,idx)=>{
      if(!b||hiddenSet.has(b.id))return
      const plain=stripMarkdownForSearch(getRaw(b))
      if(!plain)return
      const hit=matchDesktopSearchPlain(plain,parsed)
      if(!hit)return
      totalMatches+=hit.count
      if(matches.length<maxMatches){
        const radius=34,s0=Math.max(0,hit.firstIdx-radius),s1=Math.min(plain.length,hit.firstIdx+hit.matchLen+radius)
        const prefix=s0>0?'…':'',suffix=s1<plain.length?'…':''
        matches.push({blockId:getBlockId(b),view,chapterLabel:labelAt(chapters,idx),snippet:prefix+plain.slice(s0,s1)+suffix,matchOffset:prefix.length+(hit.firstIdx-s0),matchLen:hit.matchLen,matchCount:hit.count})
      }
    })
  }
  const hiddenMain=new Set(reading.hiddenBlocks??[]),hiddenOrig=new Set(reading.originalOutline?.hiddenBlocks??[])
  const hasStandalone=reading.standaloneView==='translation'&&Array.isArray(reading.originalBlocks)
  const hasTranslation=hasStandalone||Boolean(reading.comparisonAvailable)||(reading.blocks||[]).some(b=>typeof b?.translation==='string'&&b.translation.trim())
  if(hasStandalone){
    scan(reading.blocks,reading.outline,hiddenMain,'translation',b=>b.text,b=>b.id)
    scan(reading.originalBlocks,reading.originalOutline?.outline??reading.outline,hiddenOrig,'original',b=>b.text,b=>b.id)
  }else if(hasTranslation){
    scan(reading.blocks,reading.outline,hiddenMain,'translation',b=>b.translation??b.text,b=>b.id)
    scan(reading.blocks,reading.originalOutline?.outline??reading.outline,hiddenOrig,'original',b=>b.sourceText??b.text,b=>b.sourceBlockId??b.id)
  }else{
    scan(reading.blocks,reading.originalOutline?.outline??reading.outline,hiddenOrig,'original',b=>b.sourceText??b.text,b=>b.id)
  }
  return {totalMatches,matches}
}

function SavedMarkPopover({markPopover,onUpdateMark,onDeleteMark,onCiteMark,onClose}){
  const first=markPopover?.marks?.[0]
  const [draft,setDraft]=useState(first?.comment||'')
  const [saving,setSaving]=useState(false)
  const [pos,setPos]=useState(null)
  const popRef=useRef(null)
  useEffect(()=>{setDraft(markPopover?.marks?.[0]?.comment||'')},[markPopover?.marks?.[0]?.id])
  useEffect(()=>{
    if(!markPopover?.marks?.length)return
    const sync=()=>{
      const node=popRef.current
      if(!node)return
      const anchor={left:markPopover.x,right:markPopover.x,top:markPopover.top,bottom:markPopover.bottom}
      setPos(measurePopupPosition(node,anchor,{preferAbove:false,gap:8,margin:12,fallbackWidth:300,fallbackHeight:240}))
    }
    sync()
    window.addEventListener('resize',sync)
    return()=>window.removeEventListener('resize',sync)
  },[markPopover])
  if(!markPopover?.marks?.length)return null
  const left=pos?.left??12
  const top=pos?.top??12
  return h('section',{ref:popRef,className:'rr-savedMarkPopover',role:'dialog','aria-label':'划线与想法',style:{left,top,visibility:pos?'visible':'hidden'},onPointerDown:e=>e.stopPropagation()},
    h('div',{className:'rr-sectionHead',style:{marginBottom:8}},
      h('strong',null,'划线与想法'),
      button('关闭',onClose,'rr-buttonQuiet',{style:{minHeight:24,padding:'0 8px',fontSize:11}})
    ),
    markPopover.marks.map((m,idx)=>h('div',{key:m.id+':'+(m.kind||'highlight'),className:'rr-savedMarkItem'},
      h('blockquote',{className:'rr-savedMarkQuote'},m.quote||m.exact||''),
      onUpdateMark?h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:6,marginTop:8,flexWrap:'wrap'}},
        h('div',{className:'rr-viewToggle'},
          HIGHLIGHT_STYLES.map(st=>button(st.label,()=>onUpdateMark(m,{style:st.id}),(m.style||'highlight')===st.id?'rr-buttonPrimary':'rr-buttonQuiet',{key:st.id,style:{minHeight:22,padding:'0 6px',fontSize:11}}))
        ),
        h('div',{style:{display:'flex',gap:4,alignItems:'center'}},
          HIGHLIGHT_COLORS.map(c=>h('button',{key:c.id,type:'button',className:`rr-wrColorSwatch ${(m.color||'gold')===c.id?'active':''}`,style:{background:c.hex,width:16,height:16},title:c.label,onClick:()=>onUpdateMark(m,{color:c.id})}))
        )
      ):null,
      idx===0&&onUpdateMark?h('div',{style:{marginTop:8}},
        h('textarea',{value:draft,onChange:e=>setDraft(e.target.value),rows:2,placeholder:'点击此处添加或修改想法...',style:{width:'100%',boxSizing:'border-box',fontSize:12.5,padding:'6px 8px',borderRadius:6,border:'1px solid #d4d4d8',resize:'vertical'}}),
        h('div',{className:'rr-rowActions',style:{justifyContent:'space-between',marginTop:6}},
          h('div',{style:{display:'flex',gap:4,alignItems:'center'}},
            button(m.kind==='bookmark'?'取消划线':'删除',()=>onDeleteMark(m),'rr-buttonQuiet',{style:{minHeight:26,padding:'2px 10px',fontSize:12,color:'#dc2626'}}),
            onCiteMark?button('引用',()=>onCiteMark(m),'rr-buttonQuiet',{style:{minHeight:26,padding:'2px 10px',fontSize:12}}):null
          ),
          button(saving?'保存中…':'保存想法',async()=>{setSaving(true);try{await onUpdateMark(m,{comment:draft})}finally{setSaving(false)}},'rr-buttonPrimary',{disabled:saving,style:{minHeight:26,padding:'2px 12px',fontSize:12}})
        )
      ):(
        h(React.Fragment,null,
          m.comment?h('p',{className:'rr-savedMarkComment'},'💭 '+m.comment):null,
          h('div',{className:'rr-rowActions',style:{justifyContent:'flex-end',marginTop:6}},
            onCiteMark?button('引用',()=>onCiteMark(m),'rr-buttonQuiet',{style:{minHeight:26,padding:'2px 10px',fontSize:12}}):null,
            button(m.kind==='bookmark'?'取消划线':'删除高亮',()=>onDeleteMark(m),'rr-buttonQuiet',{style:{minHeight:26,padding:'2px 10px',fontSize:12,color:'#dc2626'}})
          )
        )
      )
    ))
  )
}

function AiContextPopover({explain,onSendDsh,onClose}){
  const [copied,setCopied]=useState(false)
  if(!explain)return null
  const promptText=`我正在精读《${explain.title||''}》，请结合上下文为我深度解析以下选段的概念含义、哲学/学术背景与原文措辞 nuance：\n\n【选段】${explain.exact}\n${explain.translation&&explain.translation!==explain.exact?`\n【所在段译文】${explain.translation}`:''}${explain.original?`\n【对应原文】${explain.original}`:''}`
  return h('div',{className:'rr-centeredOverlay',onClick:e=>{if(e.target===e.currentTarget)onClose()}},
    h('section',{className:'rr-centeredDialog rr-aiDialog',role:'dialog','aria-modal':true,'aria-label':'AI 语境释义'},
      h('div',{className:'rr-sectionHead'},h('strong',null,'✨ AI 双语语境释义'),button('关闭',onClose,'rr-buttonQuiet')),
      h('blockquote',{className:'rr-savedMarkQuote',style:{marginBottom:10}},explain.exact),
      explain.original?h('div',{className:'rr-aiContextBox'},h('strong',null,'对应原文上下文：'),h('p',null,explain.original)):null,
      explain.translation?h('div',{className:'rr-aiContextBox'},h('strong',null,'对应译文上下文：'),h('p',null,explain.translation)):null,
      h('div',{className:'rr-rowActions',style:{marginTop:10}},
        button(copied?'已复制提问模板':'复制上下文提问',async()=>{try{await navigator.clipboard.writeText(promptText);setCopied(true)}catch{}},'rr-buttonQuiet'),
        onSendDsh?button('在 DSH 对话深入解析 ›',()=>onSendDsh(promptText),'rr-buttonPrimary'):null
      )
    )
  )
}

function AcademicFlyleafCard({reading,task,readerPage,totalPages,onStartReading,onDismiss}){
  if(!reading)return null
  const meta=reading.metadata
  const totalChars=(reading.blocks||[]).reduce((s,b)=>s+String((b.translation??b.text)||'').replace(/\s+/g,'').length,0)
  const wordLabel=totalChars>=10000?`${(totalChars/10000).toFixed(1)} 万字`:`${totalChars} 字`
  const chapterCount=(reading.outline||[]).filter(x=>x.level<=1).length||(reading.outline||[]).length
  const metaLine=meta?[meta.author?.zh??meta.author?.source,meta.publication?.journal?.zh??meta.publication?.journal?.source??meta.publication?.book?.zh,meta.publication?.year].filter(Boolean).join(' · '):''
  return h('section',{className:'rr-flyleafCard','aria-label':'书籍扉页'},
    h('div',{className:'rr-flyleafLeft'},renderDesktopBookCover({id:task?.id||'',name:reading.title,author:meta?.author?.zh??meta?.author?.source,kind:reading.kind,hasPdf:reading.pdfAvailable!==false,hasCover:Boolean(task?.cover?.file&&!task?.cover?.none),coverSha256:task?.cover?.sha256??null},'large')),
    h('div',{className:'rr-flyleafRight'},
      h('span',{className:'rr-flyleafTag'},({book:'双语专著',paper:'学术论文',chapter:'精选章节',collection:'文章合集'})[reading.kind]||'双语精读文献'),
      h('h1',{className:'rr-flyleafTitle'},reading.title),
      meta?.title?.source?h('p',{className:'rr-flyleafOrig'},meta.title.source):null,
      metaLine?h('p',{className:'rr-flyleafMeta'},metaLine):null,
      h('div',{className:'rr-flyleafStats'},
        h('span',null,`约 ${wordLabel}`),
        chapterCount?h('span',null,`${chapterCount} 个主要章节`):null,
        h('span',null,`共 ${totalPages} 页 · 当前第 ${readerPage+1} 页`),
        reading.comparisonAvailable?h('span',null,'支持双语逐段对照'):null
      ),
      h('div',{className:'rr-rowActions',style:{marginTop:'auto'}},
        onStartReading?button('进入正文阅读 ›',onStartReading,'rr-buttonPrimary'):null,
        onDismiss?button('隐藏扉页',onDismiss,'rr-buttonQuiet'):null
      )
    )
  )
}

function ReadingDownloadMenu({taskId,title,currentView,comparisonAvailable,wrSettings,setMessage,sourceMapUrl}){
  const [exporting,setExporting]=useState('')
  const menuRef=useRef(null)
  useEffect(()=>{
    const close=e=>{if(menuRef.current?.open&&!menuRef.current.contains(e.target))menuRef.current.open=false}
    document.addEventListener('pointerdown',close)
    return()=>document.removeEventListener('pointerdown',close)
  },[])
  const runDownload=async(kind,format,label)=>{
    if(menuRef.current)menuRef.current.open=false
    if(exporting)return
    setExporting(label)
    if(format==='pdf')setMessage?.(`正在按当前排版导出${label}，请稍候…`)
    try{
      const params=new URLSearchParams({kind,format})
      if(format==='pdf'&&wrSettings){
        if(wrSettings.fontSize)params.set('fontSize',String(wrSettings.fontSize))
        if(wrSettings.lineHeight)params.set('lineHeight',String(wrSettings.lineHeight))
        if(wrSettings.fontFamily)params.set('fontFamily',String(wrSettings.fontFamily))
        if(wrSettings.letterSpacing!==undefined)params.set('letterSpacing',String(wrSettings.letterSpacing))
        if(wrSettings.paraSpacing!==undefined)params.set('paraSpacing',String(wrSettings.paraSpacing))
      }
      const url='/api/paper-reader/pipeline/tasks/'+encodeURIComponent(taskId)+'/download?'+params.toString()
      const res=await fetch(url)
      if(!res.ok){
        let err='导出失败'
        try{const j=await res.json();if(j?.error)err=j.error}catch{}
        throw new Error(err)
      }
      const disp=res.headers.get('content-disposition')||''
      const utfMatch=disp.match(/filename\*=UTF-8''([^;\s]+)/i)
      const asciiMatch=disp.match(/filename="([^"]+)"/i)
      const suffix=kind==='bilingual'?'双语对照':kind==='original'?'原文':'译文'
      const fallback=(title||'document').replace(/[\\/:*?"<>|]+/g,'_')+'-'+suffix+'.'+format
      const filename=utfMatch?decodeURIComponent(utfMatch[1]):(asciiMatch?asciiMatch[1]:fallback)
      const blob=await res.blob()
      const blobUrl=URL.createObjectURL(blob),a=document.createElement('a')
      a.href=blobUrl;a.download=filename;a.click()
      setTimeout(()=>URL.revokeObjectURL(blobUrl),1500)
      setMessage?.('已导出：'+filename)
    }catch(e){
      setMessage?.(e?.message||'导出失败')
    }finally{
      setExporting('')
    }
  }
  const baseLabel=currentView==='translation'?'下载译文':'下载原文'
  return h('details',{
    ref:menuRef,
    className:'rr-itemMenu rr-downloadMenu',
    onKeyDown:e=>{if(e.key==='Escape'&&menuRef.current){menuRef.current.open=false;menuRef.current.querySelector('summary')?.focus()}}
  },
    h('summary',{className:'rr-button rr-buttonQuiet'},exporting?`导出中(${exporting})…`:baseLabel+' ▾'),
    h('div',{className:'rr-itemMenuContent rr-downloadMenuContent'},
      button(currentView==='translation'?'下载译文 (.md)':'下载原文 (.md)',()=>runDownload(currentView,'md','Markdown'),'rr-buttonQuiet rr-buttonCompact',{disabled:!!exporting}),
      button(currentView==='translation'?'导出为译文 PDF (.pdf)':'导出为原文 PDF (.pdf)',()=>runDownload(currentView,'pdf',currentView==='translation'?'译文 PDF':'原文 PDF'),'rr-buttonQuiet rr-buttonCompact',{disabled:!!exporting}),
      comparisonAvailable?h(React.Fragment,null,
        h('div',{className:'rr-menuDivider'}),
        button('导出为双语对照 PDF (.pdf)',()=>runDownload('bilingual','pdf','双语对照 PDF'),'rr-buttonQuiet rr-buttonCompact',{disabled:!!exporting}),
        button('下载双语对照 (.md)',()=>runDownload('bilingual','md','双语对照 Markdown'),'rr-buttonQuiet rr-buttonCompact',{disabled:!!exporting})
      ):null,
      sourceMapUrl?h(React.Fragment,null,
        h('div',{className:'rr-menuDivider'}),
        h('a',{className:'rr-button rr-buttonQuiet rr-buttonCompact',href:sourceMapUrl,onClick:()=>{if(menuRef.current)menuRef.current.open=false}},'下载来源映射 (.json)')
      ):null
    )
  )
}
