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
function SelectionBookmark({ source, view='original', scope, title, disabled=false, savedMarks=[], onSaved }) {
  const [selection,setSelection]=useState(null),[editing,setEditing]=useState(false),[comment,setComment]=useState(''),[tags,setTags]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false),[notice,setNotice]=useState('')
  useEffect(()=>{if(disabled)setSelection(null);const pick=()=>{if(editing||disabled)return;const selected=window.getSelection();
    if(!selected||selected.isCollapsed||!selected.rangeCount){setSelection(null);return}const range=selected.getRangeAt(0),element=n=>n.nodeType===1?n:n.parentElement,start=element(range.startContainer)?.closest('[data-bookmark-block]'),end=element(range.endContainer)?.closest('[data-bookmark-block]');
    if(!start||!end||!start.closest(scope)||!end.closest(scope)){setSelection(null);return}const selectionView=start.dataset.bookmarkView??view;
    if(selectionView!==(end.dataset.bookmarkView??view)){setSelection(null);return}const clean=r=>{const box=document.createElement('div');
    box.append(r.cloneContents());box.querySelectorAll('.rr-originalButton,.rr-blockBookmark,.rr-chapterNo,.rr-blockLabel,.rr-readingBlockActions,.rr-footnoteLink,.rr-footnoteAccordion').forEach(n=>n.remove());
    box.querySelectorAll('p,h2,h3,blockquote').forEach(n=>n.append(document.createTextNode(' ')));return box.textContent.replace(/\s+/g,' ').trim()};
    const exact=clean(range);if(!exact||exact.length>20000){setSelection(null);return}const prefixRange=range.cloneRange();
    prefixRange.selectNodeContents(start);prefixRange.setEnd(range.startContainer,range.startOffset);const suffixRange=range.cloneRange();
    suffixRange.selectNodeContents(end);suffixRange.setStart(range.endContainer,range.endOffset);const rect=range.getBoundingClientRect();
    setSelection({exact,prefix:clean(prefixRange).slice(-80),suffix:clean(suffixRange).slice(0,80),startBlockId:start.dataset.bookmarkBlock,endBlockId:end.dataset.bookmarkBlock,view:selectionView,left:Math.max(8,Math.min(rect.left,window.innerWidth-220)),top:Math.max(8,Math.min(rect.bottom+6,window.innerHeight-46))});
    setError('')};document.addEventListener('mouseup',pick);document.addEventListener('keyup',pick);return()=>{document.removeEventListener('mouseup',pick);
    document.removeEventListener('keyup',pick)}},[editing,source?.id,source?.kind,view,scope,disabled])
  const save=async()=>{if(saving)return;setSaving(true);try{const response=await fetch('/api/paper-reader/pipeline/bookmarks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,selection,comment,tags:tags.split(/[，,]/).map(x=>x.trim()).filter(Boolean)})});const value=await response.json();if(!response.ok)throw new Error(value.error??'保存失败');setEditing(false);setSelection(null);setComment('');setTags('');setNotice('书签已保存');window.getSelection()?.removeAllRanges();await onSaved?.()}catch(e){setError(e.message)}finally{setSaving(false)}}
  const sameHighlight=[...new Set((savedMarks??[]).filter(m=>m.kind==='highlight'&&m.view===selection?.view&&m.exact===selection?.exact&&(m.blockId===selection?.startBlockId||m.blockId===selection?.endBlockId)).map(m=>m.id))]
  const highlight=async()=>{if(saving||!selection)return;setSaving(true);setNotice('');try{if(sameHighlight.length){for(const id of sameHighlight){const response=await fetch('/api/paper-reader/pipeline/bookmarks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,removeHighlight:id})});
    const value=await response.json();if(!response.ok)throw new Error(value.error??'取消高亮失败')};setNotice('已取消高亮')}else{const response=await fetch('/api/paper-reader/pipeline/bookmarks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,selection,highlightOnly:true})});
    const value=await response.json();if(!response.ok)throw new Error(value.error??'高亮失败');setNotice(value.already&&value.kind==='bookmark'?'这句话已在书签中高亮':'已高亮')}setSelection(null);
    window.getSelection()?.removeAllRanges();await onSaved?.()}catch(e){setNotice(e.message)}finally{setSaving(false)}}
  return h(React.Fragment,null,selection&&!editing?h('div',{className:'rr-selectionTools',style:{left:selection.left,top:selection.top},onMouseDown:e=>e.preventDefault()},
    button(sameHighlight.length?'取消高亮':'仅高亮',highlight,'',{disabled:saving}),button('导入书签',()=>{setEditing(true);
    setNotice('')},'',{disabled:saving})):null,notice?h('div',{className:'rr-bookmarkToast',role:'status'},notice):null,editing?h('div',{className:'rr-centeredOverlay',onKeyDown:e=>{if(e.key==='Escape')setEditing(false)}},
    h('section',{className:'rr-centeredDialog',role:'dialog','aria-modal':true,'aria-label':'导入书签'},h('div',{className:'rr-sectionHead'},
    h('h3',null,'导入书签'),button('关闭',()=>setEditing(false),'rr-buttonQuiet')),h('p',{className:'rr-pipelineNote'},title),
    h('blockquote',{...zhScriptAttrs(detectZhScript(selection?.exact))},selection?.exact),h('label',null,'评注',
    h('textarea',{value:comment,onChange:e=>setComment(e.target.value),placeholder:'写下评注',autoFocus:true,rows:4})),
    h('label',null,'标签',h('input',{value:tags,onChange:e=>setTags(e.target.value),placeholder:'用逗号分隔，可留空'})),error?h('p',{role:'alert',className:'rr-error'},error):null,
    h('div',{className:'rr-rowActions'},button(saving?'保存中':'保存书签',save,'rr-buttonPrimary',{disabled:saving}),
    button('取消',()=>setEditing(false),'rr-buttonQuiet')))):null)
}
function BookmarkLibrary({onOpenPaper,onOpenTask}){
  const [marks,setMarks]=useState([]),[query,setQuery]=useState(''),[documentId,setDocumentId]=useState(''),[error,setError]=useState('')
  const load=()=>fetch('/api/paper-reader/pipeline/bookmarks').then(r=>r.json()).then(v=>setMarks(v.bookmarks??[])).catch(()=>setError('书签加载失败'))
  useEffect(()=>{load()},[])
  const docs=Array.from(new Map(marks.map(b=>[b.documentId,b.document])).entries()),shown=marks.filter(b=>(!documentId||b.documentId===documentId)&&(!query||[b.quote,b.comment,...(b.tags??[]),b.document?.title].join(' ').toLowerCase().includes(query.toLowerCase())))
  const exportFile=async format=>{try{const response=await fetch('/api/paper-reader/pipeline/bookmarks/export?format='+format+'&documentId='+encodeURIComponent(documentId)+'&q='+encodeURIComponent(query));if(!response.ok)throw new Error();const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='书签.'+(format==='json'?'json':'md');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch{setError('导出失败')}}
  const remove=async id=>{const r=await fetch('/api/paper-reader/pipeline/bookmarks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({remove:id})});if(r.ok)load();else setError('删除失败')}
  return h('div',{className:'rr-bookmarkLibrary'},h('div',{className:'rr-sectionHead'},h('h2',null,'书签'),h('div',{className:'rr-rowActions'},
    button('导出 JSON',()=>exportFile('json'),'rr-buttonQuiet'),button('导出 Markdown',()=>exportFile('markdown'),'rr-buttonQuiet'))),
    h('div',{className:'rr-bookmarkFilters'},h('select',{'aria-label':'按书籍或论文筛选',value:documentId,onChange:e=>setDocumentId(e.target.value)},
    h('option',{value:''},'全部书籍与论文'),docs.map(([id,doc])=>h('option',{key:id,value:id},doc?.title??id))),h('input',{type:'search',value:query,onChange:e=>setQuery(e.target.value),placeholder:'搜索摘录、评注或标签','aria-label':'搜索书签'})),error?h('p',{role:'alert'},error):null,shown.length?shown.map(b=>h('section',{className:'rr-bookmarkEntry',key:b.id},
    h('h3',null,b.document?.title),h('blockquote',{...zhScriptAttrs(detectZhScript(b.quote))},b.quote),b.comment?h('p',null,b.comment):null,
    h('small',null,(b.tags??[]).join(' · ')),h('div',{className:'rr-rowActions'},button('返回原文',()=>b.source.kind==='paper'?onOpenPaper(b.source.id,b.selector.startBlockId,b.selector.view):onOpenTask(b.source.id,b.selector.startBlockId,b.selector.view),'rr-buttonQuiet'),
    button('删除',()=>remove(b.id),'rr-buttonQuiet')))):h('p',{className:'rr-pipelineNote'},'暂无书签'))
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
