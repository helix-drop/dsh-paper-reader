const WEREAD_THEMES = [
  { id: 'white', label: '纯白', bg: '#f5f6f8', paperBg: '#ffffff', fg: '#1f2329', muted: '#717682', swatch: '#ffffff', border: '#e4e6eb', dark: false },
  { id: 'paper', label: '羊皮纸', bg: '#efeade', paperBg: '#f7f4ed', fg: '#2c2620', muted: '#7a7062', swatch: '#f3ead8', border: '#dfdacd', dark: false },
  { id: 'kraft', label: '牛皮纸', bg: '#e2d3be', paperBg: '#eadcc9', fg: '#382c1e', muted: '#786651', swatch: '#e2cfb4', border: '#cfb999', dark: false },
  { id: 'green', label: '护眼绿', bg: '#cce2ce', paperBg: '#d8ebd9', fg: '#1e3022', muted: '#56705b', swatch: '#cce5ce', border: '#b6d5b8', dark: false },
  { id: 'cyan', label: '海天蓝', bg: '#d0e1ec', paperBg: '#dceaf2', fg: '#1d2d38', muted: '#576f7e', swatch: '#cce0ec', border: '#b5cfdf', dark: false },
  { id: 'rose', label: '胭脂粉', bg: '#edd8db', paperBg: '#f5e4e6', fg: '#362225', muted: '#7d5b61', swatch: '#efd5d8', border: '#dec0c4', dark: false },
  { id: 'gray', label: '极简灰', bg: '#e1e4ea', paperBg: '#eaecf0', fg: '#1f2329', muted: '#68707c', swatch: '#dfe2e8', border: '#cfd4dc', dark: false },
  { id: 'dark', label: '暗夜灰', bg: '#121215', paperBg: '#1b1b1f', fg: '#c4c4ce', muted: '#7a7a88', swatch: '#242429', border: '#2e2e36', dark: true },
  { id: 'night', label: '纯黑', bg: '#000000', paperBg: '#0a0a0c', fg: '#a6a6b2', muted: '#686874', swatch: '#0a0a0c', border: '#222229', dark: true },
  { id: 'eink', label: '水墨屏', bg: '#ffffff', paperBg: '#ffffff', fg: '#000000', muted: '#222222', swatch: '#ffffff', border: '#000000', dark: false, eink: true },
]

const WEREAD_FONTS = [
  {
    id: 'serif',
    label: '思源宋体',
    sub: '经典书宋',
    stack: 'Georgia, "方正屏显雅宋简体", "FZPingXianYaSongS-R-GB", "Source Han Serif SC VF", "思源宋体 VF", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", "STSong", serif',
  },
  {
    id: 'fzsong',
    label: '方正新书宋',
    sub: '人文雅宋',
    stack: '"FZNewShuSong-Z10", "FZShuSong-Z01", "FZXiaoBiaoSong-B05S", "Songti SC", "Source Han Serif SC", "Noto Serif SC", Georgia, serif',
  },
  {
    id: 'kaiti',
    label: '霞鹜文楷',
    sub: '温润手写楷',
    stack: '"LXGW WenKai", "Kaiti SC", "STKaiti", "FZKai-Z03", "KaiTi", "DFKai-SB", "Noto Serif SC", serif',
  },
  {
    id: 'fangsong',
    label: '书刻仿宋',
    sub: '古籍清朗',
    stack: '"FangSong", "STFangsong", "FZFangSong-Z02", "Kaiti SC", "Noto Serif SC", serif',
  },
  {
    id: 'sans',
    label: '系统黑体',
    sub: '现代清晰',
    stack: '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  },
  {
    id: 'yuan',
    label: '雅致圆体',
    sub: '柔和舒缓',
    stack: '"STYuanti-SC-Regular", "YouYuan", "FZY3JW--GB1-0", "PingFang SC", "HarmonyOS Sans SC", sans-serif',
  },
  {
    id: 'literary',
    label: '西文衬线',
    sub: '外文双语优享',
    stack: 'Georgia, "Palatino Linotype", "Book Antiqua", "Times New Roman", "Source Han Serif SC", "Noto Serif SC", serif',
  },
  {
    id: 'mono',
    label: '等宽字体',
    sub: '严谨对齐',
    stack: '"JetBrains Mono", "SFMono-Regular", Consolas, "PingFang SC", monospace',
  },
]

const WEREAD_SPACING_PRESETS = [
  { id: 'compact', label: '紧凑', lineHeight: 1.6, paraSpacing: 0.25 },
  { id: 'normal', label: '适中', lineHeight: 1.82, paraSpacing: 0.45 },
  { id: 'loose', label: '宽松', lineHeight: 2.08, paraSpacing: 0.85 },
]

function resolveDesktopFontStack(fontId) {
  const hit = WEREAD_FONTS.find(f => f.id === fontId)
  return hit ? hit.stack : WEREAD_FONTS[0].stack
}

const DESKTOP_COVER_PALETTES = [
  { bg: 'linear-gradient(145deg, #2b3a4a 0%, #1d2833 100%)', fg: '#f4efe6', accent: '#d4b483' },
  { bg: 'linear-gradient(145deg, #4a3531 0%, #2f201d 100%)', fg: '#f7efe8', accent: '#e0a96d' },
  { bg: 'linear-gradient(145deg, #2d4239 0%, #1c2b24 100%)', fg: '#eef3ef', accent: '#a3c9a8' },
  { bg: 'linear-gradient(145deg, #3d354b 0%, #251f30 100%)', fg: '#f2eef7', accent: '#c8b6e2' },
  { bg: 'linear-gradient(145deg, #4b4234 0%, #30291f 100%)', fg: '#f7f3eb', accent: '#d8c39e' },
  { bg: 'linear-gradient(145deg, #263f4d 0%, #172730 100%)', fg: '#edf4f7', accent: '#90bfd6' },
]

function bookCoverPalette(title = '') {
  const str = String(title || 'book')
  let hashVal = 0
  for (let i = 0; i < str.length; i++) {
    hashVal = ((hashVal << 5) - hashVal + str.charCodeAt(i)) | 0
  }
  return DESKTOP_COVER_PALETTES[Math.abs(hashVal) % DESKTOP_COVER_PALETTES.length]
}

function renderDesktopBookCover(doc, size = 'normal', badgeText = '') {
  const pal = bookCoverPalette(doc?.name)
  const kindLabel = { book: '整书', paper: '论文', chapter: '章节', collection: '合集' }
  return h('div', {
    className: `rr-wrBookCover ${size === 'large' ? 'rr-wrBookCoverLarge' : size === 'grid' ? 'rr-wrBookCoverGrid' : ''}`.trim(),
    style: { background: pal.bg, color: pal.fg }
  },
    badgeText ? h('span', { className: 'rr-wrBookCoverBadge' }, badgeText) : null,
    h('div', { className: 'rr-wrBookCoverTitle' }, doc?.name || '未命名文献'),
    h('div', { className: 'rr-wrBookCoverAuthor' }, doc?.author || kindLabel[doc?.kind] || 'DSH 文献')
  )
}

const DEFAULT_DESKTOP_READER_SETTINGS = {
  theme: 'paper',
  fontFamily: 'serif',
  fontSize: 17.5,
  fontWeight: 470,
  lineHeight: 1.82,
  paraSpacing: 0.45,
  textIndent: true,
  textAlign: 'justify',
  brightness: 100,
  bilingualLayout: 'parallel',
  shelfLayout: 'list',
}

function readDesktopReaderSettings() {
  try {
    const raw = localStorage.getItem('paper-reader:weread-settings')
    if (raw) {
      return { ...DEFAULT_DESKTOP_READER_SETTINGS, ...JSON.parse(raw) }
    }
  } catch {}
  return { ...DEFAULT_DESKTOP_READER_SETTINGS }
}

function saveDesktopReaderSettings(patch) {
  const next = { ...readDesktopReaderSettings(), ...patch }
  try {
    localStorage.setItem('paper-reader:weread-settings', JSON.stringify(next))
  } catch {}
  return next
}
