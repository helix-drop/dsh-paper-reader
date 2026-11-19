import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fontsRoot = path.resolve(__dirname, '../www/fonts')

async function downloadText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

async function downloadFile(url, dest) {
  try {
    const st = await fs.stat(dest)
    if (st.size > 0) return false
  } catch {}
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(dest, buf)
  return true
}

async function syncCssFontPack({ name, cssUrl, baseUrl, outDir, cssFilename, stripWoff = false }) {
  await fs.mkdir(path.join(outDir, 'files'), { recursive: true })
  let css = await downloadText(cssUrl)
  if (stripWoff) {
    css = css.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, '')
  }
  const refs = new Set()
  for (const m of css.matchAll(/url\(['"]?\.\/files\/([^'"\)]+\.woff2)['"]?\)/g)) {
    refs.add(m[1])
  }
  await fs.writeFile(path.join(outDir, cssFilename), css, 'utf8')
  const queue = [...refs]
  let downloaded = 0
  const workers = Array.from({ length: 12 }, async () => {
    while (queue.length > 0) {
      const file = queue.shift()
      if (!file) break
      const did = await downloadFile(`${baseUrl}/files/${file}`, path.join(outDir, 'files', file))
      if (did) downloaded++
    }
  })
  await Promise.all(workers)
  console.log(`[fonts] ${name}: ${refs.size} chunks ready (${downloaded} downloaded) -> ${outDir}`)
}

await syncCssFontPack({
  name: 'LXGW WenKai Lite Regular',
  cssUrl: 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-lite-webfont@1.7.0/lxgwwenkailite-regular.css',
  baseUrl: 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-lite-webfont@1.7.0',
  outDir: path.join(fontsRoot, 'wenkai'),
  cssFilename: 'lxgwwenkailite-regular.css',
})

await syncCssFontPack({
  name: 'Noto Serif SC 400',
  cssUrl: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.1.0/400.css',
  baseUrl: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.1.0',
  outDir: path.join(fontsRoot, 'serif'),
  cssFilename: '400.css',
  stripWoff: true,
})
