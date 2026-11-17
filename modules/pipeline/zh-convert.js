import { execFile } from 'node:child_process'
import { checkMarkdownPair } from './markdown.js'

const ZH_HANT_CHAR_RE = /[這個們為說時會國學體經發現實對應問題關於從與無開機業書長當來過進見樣種頭動點認識話語讀寫論義態鬱憂灣還請兩週環沒謂達聲習慣詞異鑑裏麼讓給將並處親愛東門問間聞聽視變產統紀續組織結構聯繫舉辦區準備標記號碼數據資訊歷傳錄選擇斷專廣眾邊際總導師範圍階層級類質價錢買賣費負責務報紙雜誌網絡電腦軟設規畫踐驗證顯隱轉僅優傷寫創剛劇勞勝勸醫協單壓參雙劃]/g
const ZH_HANS_CHAR_RE = /[这个们为说时会国学体经发现实对应问题关于从与无开机业书长当来过进见样种头动点认识话语读写论义态郁忧湾还请两环没谓达声习惯词异鉴让给将处亲爱东门问间闻听视变产统纪续组织结构联系举办区准备标记号码数据资讯历传录选择断专广众边际总导师范围阶层级类质价钱买卖费负责务报纸杂网络电脑软设规划践验证显隐转仅优伤创刚剧劳胜劝医协单压参双]/g

const SWIFT_HANT_TO_HANS = [
  'import Foundation',
  'let data = FileHandle.standardInput.readDataToEndOfFile()',
  'let input = String(data: data, encoding: .utf8) ?? ""',
  'let output = (input as NSString).applyingTransform(StringTransform("Hant-Hans"), reverse: false) ?? input',
  'FileHandle.standardOutput.write(output.data(using: .utf8) ?? Data())',
].join('\n')

/**
 * Detect whether a Chinese text is predominantly Traditional ('hant') or Simplified ('hans').
 */
export function detectZhScript(text, fallback = 'hans') {
  if (typeof text !== 'string' || !text) return fallback
  const sample = text.length > 80000 ? text.slice(0, 80000) : text
  const hant = sample.match(ZH_HANT_CHAR_RE)?.length ?? 0
  const hans = sample.match(ZH_HANS_CHAR_RE)?.length ?? 0
  if (hant > hans && hant >= 2) return 'hant'
  if (hans > hant && hans >= 2) return 'hans'
  return fallback
}

export function isTraditionalChinese(text) {
  return detectZhScript(text, 'hans') === 'hant'
}

/**
 * Protect Markdown code, links, images, and footnote markers from text transformation.
 */
export function protectMarkdownTokens(markdown) {
  const tokens = []
  let prefix = '\uE000ZHC'
  while (markdown.includes(prefix)) prefix += '_'
  const hold = value => {
    const id = tokens.length
    tokens.push(value)
    return `${prefix}_${id}\uE001`
  }
  const masked = markdown
    .replace(/(^|\n)(```[\s\S]*?\n```|~~~[\s\S]*?\n~~~)(?=\n|$)/g, (_m, nl, block) => nl + hold(block))
    .replace(/`[^`\n]+`/g, m => hold(m))
    .replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (_m, a, url, c) => a + hold(url) + c)
    .replace(/(\[[^\]]+\]\()((?:https?:\/\/|mailto:|\/|\.\.?\/)[^)]+)(\))/gi, (_m, a, url, c) => a + hold(url) + c)
    .replace(/(^|\n)(\[\^[^\]]+\]:[ \t]*)/g, (_m, nl, tok) => nl + hold(tok))
    .replace(/\[\^[^\]]+\]/g, m => hold(m))
    .replace(/\[footnote-\d+\]\\[^\s]+/g, m => hold(m))
    .replace(/https?:\/\/[^\s)>"'\]，。；：、]+/gi, m => hold(m))
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const placeholderRe = new RegExp(`${escaped}_(\\d+)\\uE001`, 'g')
  const restore = text => text.replace(placeholderRe, (_m, index) => tokens[Number(index)] ?? _m)
  return { masked, restore }
}

/**
 * Convert Traditional Chinese plain text to Simplified Chinese via macOS Foundation ICU transform.
 */
export function convertHantToHans(text) {
  if (typeof text !== 'string' || !text) return ''
  return new Promise((resolve, reject) => {
    const child = execFile(
      'swift',
      ['-e', SWIFT_HANT_TO_HANS],
      { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`繁简转换失败：${(stderr || error.message).trim()}`))
          return
        }
        resolve(stdout)
      },
    )
    child.stdin.end(text, 'utf8')
  })
}

/**
 * Convert Traditional Chinese Markdown into structurally aligned Simplified Chinese Markdown.
 */
export async function convertHantToHansMarkdown(markdown, convertText = convertHantToHans) {
  const normalized = String(markdown ?? '').replace(/\r\n/g, '\n')
  if (!normalized.trim()) return normalized
  const { masked, restore } = protectMarkdownTokens(normalized)
  const converted = restore(await convertText(masked))
  const check = checkMarkdownPair(normalized, converted)
  if (!check.passed) {
    throw new Error(`繁简转换后段落结构不一致：${check.errors[0]?.message ?? '段落数不匹配'}`)
  }
  return converted
}
