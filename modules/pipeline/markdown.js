import { createHash } from 'node:crypto'
export const hash = value => createHash('sha256').update(value).digest('hex')
// Conservative block reader. Raw Markdown remains authoritative; no HTML is executed.
export function markdownBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), blocks = [], seen = new Map()
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue }
    const start = i, line = lines[i], fence = line.match(/^\s*(`{3,}|~{3,})/)
    let type = /^#{1,6}\s/.test(line) ? 'heading' : /^\[\^[^\]]+\]:/.test(line) ? 'footnote' : /^>/.test(line) ? 'quote' : /^\s*(?:[-+*]|\d+[.)])\s/.test(line) ? 'list' : 'paragraph'
    if (fence) { type = 'code'; i++; while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) i++; if(i < lines.length) i++ }
    else if (type === 'heading') i++
    else { i++; while (i < lines.length && lines[i].trim() && !/^#{1,6}\s|^\[\^[^\]]+\]:|^\s*(`{3,}|~{3,})/.test(lines[i])) i++; if (i < lines.length && /^\s{2,}\S/.test(lines[i])) { while(i < lines.length && (/^\s{2,}/.test(lines[i]) || !lines[i].trim())) i++ } }
    const raw = lines.slice(start, i).join('\n'), signature = hash(type + '\n' + raw), occurrence = (seen.get(signature) ?? 0) + 1
    seen.set(signature, occurrence)
    if (type === 'paragraph' && /\n\s*\|?\s*:?-{3,}/.test(raw)) type = 'table'
    blocks.push({ id: `${signature.slice(0,20)}-${occurrence}`, type, text: raw, line: start + 1, level: type === 'heading' ? line.match(/^#+/)[0].length : undefined })
  }
  return blocks
}
export function checkMarkdownPair(source, target) {
  const src = markdownBlocks(source), dst = markdownBlocks(target), errors = []
  const markers = s => [...s.matchAll(/\[\^[^\]]+\]/g)].map(m => m[0]).sort().join('|')
  const assets = s => [...s.matchAll(/!\[[^\]]*\]\(([^)]+)\)|!\[\[([^\]]+)\]\]/g)].map(m => m[1] ?? m[2]).sort().join('|')
  if (src.length !== dst.length) errors.push(`原文 ${src.length} 块，译文 ${dst.length} 块，不能按位置配对`)
  for (let i=0; i < Math.min(src.length,dst.length); i++) {
    if (src[i].type !== dst[i].type || src[i].level !== dst[i].level) errors.push(`第 ${i+1} 块结构变化`)
    if (markers(src[i].text) !== markers(dst[i].text)) errors.push(`第 ${i+1} 块脚注标记变化`)
    if (assets(src[i].text) !== assets(dst[i].text)) errors.push(`第 ${i+1} 块附件路径变化`)
  }
  for (const [label,text] of [['原文',source],['译文',target]]) {
    const defs=[...text.matchAll(/^\[\^([^\]]+)\]:/gm)].map(m=>m[1]), refs=[...text.replace(/^\[\^[^\]]+\]:/gm,'').matchAll(/\[\^([^\]]+)\]/g)].map(m=>m[1])
    if(new Set(defs).size!==defs.length) errors.push(`${label}脚注定义重复`)
    const custom=[...text.matchAll(/^\[footnote-(\d+)\]\\(\S+)/gm)].map(m=>`${Number(m[1])}_${m[2]}`)
    if(refs.some(r=>!defs.includes(r)&&!custom.some(c=>r.endsWith(`p${c}`)||r.replace(/p0+(\d+)_/,'p$1_').endsWith(`p${c}`)))) errors.push(`${label}脚注缺定义`)
  }
  return { passed: errors.length === 0, errors, blocks: src.length, semanticVerified: false }
}
