import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fontsRoot = path.resolve(__dirname, '../www/fonts')

async function withRetry(fn, attempts = 4) {
  let err
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      err = e
      await new Promise(r => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw err
}

async function downloadText(url) {
  return withRetry(async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return res.text()
  })
}

async function downloadFile(url, dest) {
  try {
    const st = await fs.stat(dest)
    if (st.size > 0) return false
  } catch {}
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const buf = await withRetry(async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return Buffer.from(await res.arrayBuffer())
  })
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
  name: 'LXGW WenKai Screen Regular',
  cssUrl: 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/lxgwwenkaiscreen.css',
  baseUrl: 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0',
  outDir: path.join(fontsRoot, 'wenkai'),
  cssFilename: 'lxgwwenkaiscreen.css',
})

for (const w of ['400', '500', '600']) {
  await syncCssFontPack({
    name: `Noto Serif SC ${w}`,
    cssUrl: `https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.1.0/${w}.css`,
    baseUrl: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.1.0',
    outDir: path.join(fontsRoot, 'serif'),
    cssFilename: `${w}.css`,
    stripWoff: true,
  })
}
