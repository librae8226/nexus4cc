// walkie/paths.ts — 判断"这段文字是不是一个文件路径"
//
// 从 replyLinks.tsx 里抽出来的：渲染 Markdown 的孩子也要用它（代码块里的路径、
// 链接里的相对路径、正文里的裸路径，三处都要同一个判据）。
//
// **白名单是必须的**：没有它 `v4.9.1` 会被当成文件名。宁可漏认，不可错认。

/** 只有这些后缀才当文件认。加新类型随时补，但别用通配 —— 版本号会中招。 */
const EXT = 'md|markdown|txt|json|jsonl|ya?ml|toml|ini|conf|cfg|env|'
  + 'js|mjs|cjs|jsx|ts|tsx|vue|svelte|'
  + 'py|rb|go|rs|java|kt|swift|php|pl|sh|bash|zsh|fish|ps1|sql|'
  + 'css|scss|less|html|htm|xml|svg|csv|tsv|log|lock|gradle|properties|patch|diff'

export const EXT_RE = new RegExp(`\\.(${EXT})$`, 'i')

/** 路径本身：允许 . 与 .. 前缀、中文、点横线；不接受空格（带空格的路径本就歧义） */
const PATH_BODY = '(?:\\.{1,2}\\/)?(?:[\\w.\\-\\u4e00-\\u9fa5]+\\/)*[\\w.\\-\\u4e00-\\u9fa5]+'

/** 裸路径（文本节点里那种）。前后必须是非路径字符，否则 `a.ts` 会被从 `xa.ts` 中截出来。 */
export const BARE_PATH_RE = new RegExp(
  `(^|[\\s(（【「"'\`*>])((?:${PATH_BODY}\\.(?:${EXT}))(?::\\d+(?:-\\d+)?)?)`,
  'gi',
)

/** 行号后缀（:12 / :12-15）—— 文件浏览器还不能跳行，留在路径里只会让它打不开 */
export const stripLine = (p: string): string => p.replace(/:\d+(?:-\d+)?$/, '')

export function isPathLike(s: string): boolean {
  const p = stripLine(s.trim())
  if (!p || /\s/.test(p)) return false
  if (/^https?:\/\//i.test(p) || p.startsWith('mailto:')) return false
  return EXT_RE.test(p) || p.startsWith('/') || p.startsWith('./') || p.startsWith('../')
}
