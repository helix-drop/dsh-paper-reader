function insideDesktopWindow() {
  return (globalThis.navigator?.userAgent ?? '').includes('Electron')
    || typeof globalThis.process?.versions?.electron === 'string'
    || (globalThis.location?.protocol ?? '') === 'dsh-app:'
}

const zh = {
  panel: '阅读', library: '文献库', libraryEyebrow: 'DOCUMENT LIBRARY', libraryTitle: '文档阅读',
  libraryLead: '书籍、论文与章节共用统一流水线：视觉转写优先，最多两个兜底模型，全部失败才 OCR 抄写；LinguaGacha 段落翻译与对照阅读。',
  workspaceFailed: '文档工作区不可用', sessionFailed: '无法在文档工作区创建会话',
  source: '原文', original: '查看原文', sourceDialog: '逐段对照', translation: '中文译文', page: '第 {page} 页',
  fontSmaller: '缩小字号', fontLarger: '放大字号', close: '关闭', showNote: '查看尾注', backToCite: '返回引用处',
}
const en = {
  panel: 'Reader', library: 'Library', libraryEyebrow: 'DOCUMENT LIBRARY', libraryTitle: 'Unified Document Reader',
  libraryLead: 'Books, papers, and chapters share one pipeline: vision first, up to two fallback models, OCR only after every model fails, then paragraph translation and bilingual reading.',
  workspaceFailed: 'Document workspace unavailable', sessionFailed: 'Could not create a session in the document workspace',
  source: 'Source', original: 'View original', sourceDialog: 'Paragraph comparison', translation: 'Translation', page: 'Page {page}',
  fontSmaller: 'Smaller text', fontLarger: 'Larger text', close: 'Close', showNote: 'View note', backToCite: 'Back to citation',
}
