// walkie/Markdown.tsx — 把 AI 的回复按 Markdown 渲染
//
// 【为什么要它】AI 的回复本来就是 Markdown。以前这里有一个手写的小渲染器
// （只认粗体、标题、反引号、链接），够用但一直在漏：表格、有序/无序列表、引用、
// 代码块、分隔线全是**原样打出来的星号和井号** —— 满屏符号是最伤"精致感"的一处。
// 现在直接用 marked 解析，跟文件预览走同一套。
//
// 【两件非标准的事，都是这一屏特有的】
//   1. **文件引用可点**：`docs/WALKIE.md`、[README](./README.md) 点一下直接开文件
//      （原来那个手写渲染器的核心价值，不能丢）。
//   2. **裸路径也认**：Claude 经常不加反引号直接写路径，靠后缀白名单兜住。
//
// 【安全】先 DOMPurify 消毒，再在**已消毒的 DOM** 上做那两处改写 ——
// 顺序反了就等于把没消毒的 HTML 挂上去。

import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { BARE_PATH_RE, isPathLike, stripLine } from './paths'

/**
 * 折起来时要显示的那点文字：**把 Markdown 语法去掉**，留纯文本。
 *
 * 为什么不直接拿原文截断：`## 标题`、`**粗体**`、``` 代码块 ``` 截出来是满屏符号，
 * 而且一个代码块会把三行预览整个吃掉 —— 扫一眼什么都得不到。
 * 代码块换成「〔代码〕」，读者知道"这里有一段代码，点开看"。
 */
export function plainPreview(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' 〔代码〕 ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '〔图〕')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '· ')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '· ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * 折起来时的那三行。**路径仍然可点** —— 你要点开一个文件，不该先展开一条消息。
 * 它不做 Markdown，只把裸路径挑出来做按钮。
 */
export function Preview({ text, onOpen, max = 150 }: {
  text: string
  onOpen?: (p: string) => void
  max?: number
}) {
  const nodes = useMemo(() => {
    const full = plainPreview(text)
    // 这里自己截断、不用 CSS 的 line-clamp：预览里有可点的路径按钮，
    // 行盒里有内联按钮时 line-clamp 的表现并不一致，而且"三行"在手机上量不出来。
    const plain = full.length > max ? `${full.slice(0, max)}…` : full
    const out: React.ReactNode[] = []
    let last = 0
    let key = 0
    BARE_PATH_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BARE_PATH_RE.exec(plain)) !== null) {
      const path = m[2]
      const at = m.index + m[1].length
      if (!isPathLike(path)) continue
      if (at > last) out.push(plain.slice(last, at))
      out.push(
        <button key={key++} type="button" className="walkie-filelink"
          data-file={stripLine(path)}
          onClick={(e) => { e.stopPropagation(); onOpen?.(stripLine(path)) }}>
          <code>{stripLine(path)}</code>
        </button>,
      )
      last = at + path.length
    }
    if (last < plain.length) out.push(plain.slice(last))
    return out
  }, [text, onOpen])

  return <p className="walkie-preview">{nodes}</p>
}

marked.setOptions({ gfm: true, breaks: true })

/** 造一个可点的文件引用（样式和原来的 .walkie-filelink 一致） */
function fileButton(path: string, label?: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'walkie-filelink'
  b.dataset.file = path
  const code = document.createElement('code')
  code.textContent = label ?? path
  b.appendChild(code)
  return b
}

/** 把纯文本里的裸路径挑出来。文本节点没有结构，只能切着走。 */
function linkifyBarePaths(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  let last = 0
  BARE_PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BARE_PATH_RE.exec(text)) !== null) {
    const lead = m[1]
    const path = m[2]
    const at = m.index + lead.length
    if (!isPathLike(path)) continue          // 白名单没过的（版本号之类）留在原文里
    if (at > last) frag.appendChild(document.createTextNode(text.slice(last, at)))
    frag.appendChild(fileButton(stripLine(path)))
    last = at + path.length
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
  return frag
}

function transform(html: string): string {
  const host = document.createElement('div')
  host.innerHTML = html

  // 1) 行内代码 / 代码块里的路径 → 可点。整个 code 恰好就是一个路径才算，
  //    多一行的代码块不动（那多半是贴的命令，点开文件反而莫名其妙）。
  for (const code of Array.from(host.querySelectorAll('code'))) {
    const raw = code.textContent || ''
    if (!raw || raw !== raw.trim() || raw.includes('\n')) continue
    if (!isPathLike(raw)) continue
    code.replaceWith(fileButton(stripLine(raw)))
  }

  // 2) 链接：http(s) 交给系统，其余当路径
  for (const a of Array.from(host.querySelectorAll('a'))) {
    const href = a.getAttribute('href') || ''
    if (/^https?:/i.test(href) || href.startsWith('mailto:')) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
      continue
    }
    if (!href) continue
    const b = fileButton(stripLine(href), a.textContent || undefined)
    a.replaceWith(b)
  }

  // 3) 正文里的裸路径
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    const parent = n.parentElement
    // 已经在链接/按钮/代码里的不再动
    if (parent && parent.closest('a,button,code,pre')) continue
    if (n.nodeValue && BARE_PATH_RE.test(n.nodeValue)) texts.push(n)
    BARE_PATH_RE.lastIndex = 0
  }
  for (const n of texts) n.replaceWith(linkifyBarePaths(n.nodeValue || ''))

  return host.innerHTML
}

export default function Markdown({ text, className, onOpen }: {
  text: string
  className?: string
  onOpen?: (path: string) => void
}) {
  // 每次轮询都会重渲染一遍；不缓存的话十几条消息每 5 秒重新解析一次 Markdown
  const html = useMemo(() => {
    if (!text) return ''
    const raw = marked.parse(text, { async: false }) as string
    // data-* 是给下面那次改写留的（DOMPurify 默认放行 data-*，这里显式写出来免得将来被收紧）
    const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'], ALLOW_DATA_ATTR: true })
    return transform(clean)
  }, [text])

  return (
    <div
      className={`walkie-md${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        const el = (e.target as HTMLElement | null)?.closest('[data-file]') as HTMLElement | null
        const p = el?.dataset.file
        if (p && onOpen) { e.preventDefault(); e.stopPropagation(); onOpen(p) }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
