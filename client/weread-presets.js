const WEREAD_THEMES = [
  { id: 'white', label: '纯白', bg: '#f4f5f7', paperBg: '#ffffff', fg: '#212832', muted: '#5d646e', swatch: '#ffffff', border: '#e4e6eb', dark: false },
  { id: 'paper', label: '羊皮纸', bg: '#efeade', paperBg: '#f7f4ed', fg: '#2c2620', muted: '#7a7062', swatch: '#f3ead8', border: '#dfdacd', dark: false },
  { id: 'kraft', label: '牛皮纸', bg: '#e2d3be', paperBg: '#eadcc9', fg: '#382c1e', muted: '#786651', swatch: '#e2cfb4', border: '#cfb999', dark: false },
  { id: 'green', label: '护眼绿', bg: '#cce2ce', paperBg: '#d8ebd9', fg: '#1e3022', muted: '#56705b', swatch: '#cce5ce', border: '#b6d5b8', dark: false },
  { id: 'cyan', label: '海天蓝', bg: '#d0e1ec', paperBg: '#dceaf2', fg: '#1d2d38', muted: '#576f7e', swatch: '#cce0ec', border: '#b5cfdf', dark: false },
  { id: 'rose', label: '胭脂粉', bg: '#edd8db', paperBg: '#f5e4e6', fg: '#362225', muted: '#7d5b61', swatch: '#efd5d8', border: '#dec0c4', dark: false },
  { id: 'gray', label: '极简灰', bg: '#e1e4ea', paperBg: '#eaecf0', fg: '#212832', muted: '#68707c', swatch: '#dfe2e8', border: '#cfd4dc', dark: false },
  { id: 'dark', label: '暗夜灰', bg: '#0e0e10', paperBg: '#1c1c1e', fg: '#f0f0f2', muted: '#8c8c8e', swatch: '#262628', border: '#2e2e36', dark: true },
  { id: 'night', label: '纯黑', bg: '#000000', paperBg: '#121213', fg: '#dcdcde', muted: '#646466', swatch: '#0e0e10', border: '#222229', dark: true },
  { id: 'eink', label: '水墨屏', bg: '#ffffff', paperBg: '#ffffff', fg: '#000000', muted: '#222222', swatch: '#ffffff', border: '#000000', dark: false, eink: true },
]

const WEREAD_FONTS = [
  {
    id: 'serif',
    cat: 'serif',
    label: '思源宋体',
    sub: '经典书宋',
    stack: 'Georgia, "方正屏显雅宋简体", "FZPingXianYaSongS-R-GB", "Source Han Serif SC VF", "思源宋体 VF", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", "STSong", serif',
  },
  {
    id: 'fzsong',
    cat: 'serif',
    label: '方正新书宋',
    sub: '人文雅宋',
    stack: '"FZNewShuSong-Z10", "FZShuSong-Z01", "FZXiaoBiaoSong-B05S", "Songti SC", "Source Han Serif SC", "Noto Serif SC", Georgia, serif',
  },
  {
    id: 'kaiti',
    cat: 'kaiti',
    label: '霞鹜文楷',
    sub: '温润手写楷',
    stack: '"LXGW WenKai", "Kaiti SC", "STKaiti", "FZKai-Z03", "KaiTi", "DFKai-SB", "Noto Serif SC", serif',
  },
  {
    id: 'cangjin',
    cat: 'kaiti',
    label: '今楷古韵',
    sub: '手书雅楷',
    stack: '"CangErJinKai03", "Kaiti SC", "STKaiti", "LXGW WenKai", "Songti SC", serif',
  },
  {
    id: 'fangsong',
    cat: 'kaiti',
    label: '书刻仿宋',
    sub: '古籍清朗',
    stack: '"FangSong", "STFangsong", "FZFangSong-Z02", "Kaiti SC", "Noto Serif SC", serif',
  },
  {
    id: 'hyqihei',
    cat: 'sans',
    label: '旗黑明晰',
    sub: '微信经典无衬线',
    stack: '"HYQiHei 50S", "汉仪旗黑50S", -apple-system, "PingFang SC", "SF UI Text", "Microsoft YaHei", sans-serif',
  },
  {
    id: 'sans',
    cat: 'sans',
    label: '系统黑体',
    sub: '现代清晰',
    stack: '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  },
  {
    id: 'yuan',
    cat: 'sans',
    label: '雅致圆体',
    sub: '柔和舒缓',
    stack: '"STYuanti-SC-Regular", "YouYuan", "FZY3JW--GB1-0", "PingFang SC", "HarmonyOS Sans SC", sans-serif',
  },
  {
    id: 'literary',
    cat: 'western',
    label: '西文衬线',
    sub: '外文双语优享',
    stack: 'Georgia, "Baskerville", "Palatino Linotype", "Book Antiqua", "Times New Roman", "Source Han Serif SC", "Noto Serif SC", serif',
  },
  {
    id: 'mono',
    cat: 'western',
    label: '等宽字体',
    sub: '严谨对齐',
    stack: '"JetBrains Mono", "SFMono-Regular", Consolas, "PingFang SC", monospace',
  },
]

const WEREAD_SPACING_PRESETS = [
  { id: 'compact', label: '紧凑', lineHeight: 1.56, paraSpacing: 0.25, letterSpacing: 0 },
  { id: 'normal', label: '适中', lineHeight: 1.82, paraSpacing: 0.45, letterSpacing: 0.01 },
  { id: 'weread', label: '微信默认', lineHeight: 1.9, paraSpacing: 0.6, letterSpacing: 0.015 },
  { id: 'loose', label: '宽松', lineHeight: 2.15, paraSpacing: 0.9, letterSpacing: 0.025 },
]

const HIGHLIGHT_STYLES = [
  { id: 'highlight', label: '马克笔' },
  { id: 'wave', label: '波浪线' },
  { id: 'line', label: '直线' },
]

const HIGHLIGHT_COLORS = [
  { id: 'gold', label: '暖金', hex: '#d97706' },
  { id: 'blue', label: '海蓝', hex: '#2563eb' },
  { id: 'green', label: '青草', hex: '#16a34a' },
  { id: 'pink', label: '桃粉', hex: '#db2777' },
  { id: 'purple', label: '暮紫', hex: '#7c3aed' },
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

const EDITORIAL_COVER_TINTS = [
  { paper: '#faf7f0', ink: '#1d2228', sub: '#4c5460', accent: '#2b4c6f' },
  { paper: '#f9f4f2', ink: '#221c1d', sub: '#5c4b4d', accent: '#7c3438' },
  { paper: '#f3f7f4', ink: '#1a231e', sub: '#46584d', accent: '#2a5746' },
  { paper: '#f5f4f9', ink: '#1f1d27', sub: '#504c61', accent: '#4c3e6e' },
  { paper: '#f9f6ee', ink: '#25211a', sub: '#5b5244', accent: '#6d5432' },
  { paper: '#f2f6f9', ink: '#18222a', sub: '#465764', accent: '#255364' },
]

function editorialCoverSpec(doc) {
  const name = String(doc?.name ?? '未命名文献').trim() || '未命名文献'
  const kindMap = { paper: '学术论文', chapter: '文献选章', collection: '论文合集', book: '研究专著' }
  const kicker = kindMap[doc?.kind] || 'DSH 文献'
  let units = 0
  for (const ch of name) units += ch.charCodeAt(0) > 127 ? 1 : 0.55
  const sizeClass = units <= 11 ? 'is-short' : units <= 21 ? 'is-medium' : 'is-long'
  let mainTitle = name
  let subTitle = ''
  const sepMatch = name.match(/^(.{3,20}?)(?:：|——)(.{3,})$/)
  if (sepMatch) {
    mainTitle = sepMatch[1] + (name.includes('：') ? '：' : '——')
    subTitle = sepMatch[2].trim()
  }
  let hashVal = 0
  for (let i = 0; i < name.length; i++) hashVal = ((hashVal << 5) - hashVal + name.charCodeAt(i)) | 0
  const tint = EDITORIAL_COVER_TINTS[Math.abs(hashVal) % EDITORIAL_COVER_TINTS.length]
  return { kicker, mainTitle, subTitle, sizeClass, tint, author: String(doc?.author || doc?.titleSource || '').trim() }
}

function renderDesktopBookCover(doc, size = 'normal', badgeText = '') {
  const sizeCls = size === 'large' ? 'rr-wrBookCoverLarge' : size === 'grid' ? 'rr-wrBookCoverGrid' : ''
  if (doc?.id && doc?.hasCover === true) {
    const pal = bookCoverPalette(doc?.name)
    const kindLabel = { book: '整书', paper: '论文', chapter: '章节', collection: '合集' }
    const coverUrl = `/api/paper-reader/pipeline/tasks/${encodeURIComponent(doc.id)}/cover${doc.coverSha256 ? `?v=${encodeURIComponent(doc.coverSha256)}` : ''}`
    return h('div', {
      className: `rr-wrBookCover ${sizeCls}`.trim(),
      style: { background: pal.bg, color: pal.fg }
    },
      h('img', {
        className: 'rr-wrBookCoverImg',
        src: coverUrl,
        loading: 'lazy',
        alt: '',
        ref: el => { if (el && el.complete && el.naturalWidth > 0) el.classList.add('loaded') },
        onLoad: e => { e.currentTarget.classList.add('loaded') },
        onError: e => { e.currentTarget.style.display = 'none' },
      }),
      badgeText ? h('span', { className: 'rr-wrBookCoverBadge' }, badgeText) : null,
      h('div', { className: 'rr-wrBookCoverTitle' }, doc?.name || '未命名文献'),
      h('div', { className: 'rr-wrBookCoverAuthor' }, doc?.author || kindLabel[doc?.kind] || 'DSH 文献')
    )
  }

  const spec = editorialCoverSpec(doc)
  const fallbackFoot = doc?.kind === 'paper' ? '文献译本' : 'DSH 文献'
  return h('div', {
    className: `rr-wrBookCover is-generated ${spec.sizeClass} ${sizeCls}`.trim(),
    style: { background: spec.tint.paper, color: spec.tint.ink, '--rr-cov-accent': spec.tint.accent, '--rr-cov-sub': spec.tint.sub }
  },
    h('div', { className: 'rr-covHead' },
      h('span', { className: 'rr-covKicker' }, spec.kicker),
      badgeText ? h('span', { className: 'rr-covBadge' }, badgeText) : null
    ),
    h('div', { className: 'rr-covRule' }),
    h('div', { className: 'rr-covTitle', title: doc?.name || '' },
      h('span', { className: 'rr-covTitleMain' }, spec.mainTitle),
      spec.subTitle ? h('span', { className: 'rr-covTitleSub' }, spec.subTitle) : null
    ),
    h('div', { className: 'rr-covFoot' },
      h('span', { className: 'rr-covAuthor' }, spec.author || fallbackFoot)
    )
  )
}

const DEFAULT_DESKTOP_READER_SETTINGS = {
  theme: 'paper',
  fontFamily: 'serif',
  fontSize: 17.5,
  fontWeight: 470,
  lineHeight: 1.82,
  letterSpacing: 0.01,
  paraSpacing: 0.45,
  textIndent: true,
  textAlign: 'justify',
  brightness: 100,
  bilingualLayout: 'parallel',
  desktopLayout: 'scroll',
  showFlyleaf: true,
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
