// walkie/replyLinks.tsx — 把 AI 回复里的文件引用变成可点开的入口
//
// 为什么要做：在对讲机上你听到的是摘要，但"结果在哪"这件事只有文件说得清。
// Claude 的回复里本来就会带路径（`src/walkie/api.ts`、[README](./README.md)…），
// 让它直接可点，就省掉了"记住路径 → 开浏览器 → 一层层找"那三步。
//
// 认三种写法，按可靠性排序：
//   1. markdown 链接 [文字](目标)  —— 最明确，http(s) 的走外链，其余当路径
//   2. 反引号 `path/to/file.ts`    —— 代码里最常这么写，几乎不会误判
//   3. 裸路径 src/a.ts             —— 靠"含斜杠 或 后缀在白名单里"兜住；
//      白名单是必须的：没有它 v4.9.1 这种版本号会被当成文件名
//
// 路径后面跟的 `:12` / `:12-15`（行号）会被剥掉 —— 文件浏览器还不能跳行，
// 留在里面只会让路径打不开。

import type React from 'react'

/** 只有这些后缀才当文件认。加新类型随时补，但别用通配 —— 版本号会中招。 */
const EXT = 'md|markdown|txt|json|jsonl|ya?ml|toml|ini|conf|cfg|env|'
  + 'js|mjs|cjs|jsx|ts|tsx|vue|svelte|'
  + 'py|rb|go|rs|java|kt|swift|php|pl|sh|bash|zsh|fish|ps1|sql|'
  + 'css|scss|less|html|htm|xml|svg|csv|tsv|log|lock|gradle|properties|patch|diff'

const EXT_RE = new RegExp(`\\.(${EXT})$`, 'i')
/** 路径本身：允许 . 与 .. 前缀、中文、点横线；不接受空格（回复里带空格的路径本就歧义） */
const PATH_BODY = '(?:\\.{1,2}\\/)?(?:[\\w.\\-\\u4e00-\\u9fa5]+\\/)*[\\w.\\-\\u4e00-\\u9fa5]+'
const LINE_SUFFIX = '(?::\\d+(?:-\\d+)?)?'

const TOKEN_RE = new RegExp(
  [
    '(\\[[^\\]\\n]{1,60}\\]\\([^)\\s]{1,300}\\))',                    // 1 markdown 链接
    '(`[^`\\n]{1,300}`)',                                            // 2 反引号
    `(^|[\\s(（【「"'])((${PATH_BODY}\\.(?:${EXT}))${LINE_SUFFIX})`, // 3a 已知后缀
    `(^|[\\s(（【「"'])(((?:\\.{1,2}/|/)[\\w.\\-\\u4e00-\\u9fa5/]+))`, // 3b 显式带目录
    // 4/5 排在路径之后：`**docs/a.md**` 这种要先把路径认出来，再看外面的星号。
    // 手机上没有 markdown 渲染器，不处理的话 `**重点**`、`## 标题` 是**原样**打在屏上的，
    // 满屏的星号井号 —— 这是最伤"精致感"的一处，代价只有两条正则。
    '(\\*\\*[^*\\n]{1,200}\\*\\*)',                                  // 4 粗体
    '(^#{1,4}[ \\t][^\\n]{1,200})',                                  // 5 标题
  ].join('|'),
  'gim',
)

const stripLine = (p: string) => p.replace(/:\d+(?:-\d+)?$/, '')

function isPathLike(s: string): boolean {
  const p = stripLine(s)
  if (!p || /\s/.test(p)) return false
  if (/^https?:\/\//i.test(p) || p.startsWith('mailto:')) return false
  return EXT_RE.test(p) || p.startsWith('/') || p.startsWith('./') || p.startsWith('../')
}

export interface ReplyTextProps {
  text: string
  /** 点一个文件引用。相对路径原样传下去，由调用方对着 cwd 解析。 */
  onOpen: (path: string) => void
}

export default function ReplyText({ text, onOpen }: ReplyTextProps): React.ReactElement {
  const out: React.ReactNode[] = []
  let last = 0
  let key = 0
  TOKEN_RE.lastIndex = 0

  const push = (node: React.ReactNode) => { out.push(<span key={key++}>{node}</span>) }

  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const [full, md, code, pre1, bare1, pre2, bare2, bold, head] = m
    // 3a/3b 把前导字符一起吞了，渲染时要还回去
    const lead = pre1 ?? pre2 ?? ''
    const body = bare1 ?? bare2 ?? ''

    if (m.index > last) push(text.slice(last, m.index))
    if (lead) push(lead)
    last = m.index + full.length

    if (md) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(md)!
      const label = mm[1]
      const target = mm[2]
      if (/^https?:\/\//i.test(target)) {
        // 外链：对讲机里不内嵌浏览器，交给系统
        push(<a className="walkie-link" href={target} target="_blank" rel="noopener noreferrer">{label}</a>)
      } else {
        push(
          <button type="button" className="walkie-filelink" onClick={() => onOpen(stripLine(target))}>
            {label || target}
          </button>,
        )
      }
    } else if (code) {
      const inner = code.slice(1, -1)
      if (isPathLike(inner)) {
        push(
          <button type="button" className="walkie-filelink" onClick={() => onOpen(stripLine(inner))}>
            <code>{stripLine(inner)}</code>
          </button>,
        )
      } else {
        push(<code className="walkie-code">{inner}</code>)
      }
    } else if (body) {
      const p = stripLine(body)
      // 3b 那条只要求"带斜杠"，可能把 `and/or` 之类当真，再过一道后缀校验
      if (isPathLike(p)) {
        push(
          <button type="button" className="walkie-filelink" onClick={() => onOpen(p)}>
            <code>{p}</code>
          </button>,
        )
      } else {
        push(body)
      }
    } else if (bold) {
      push(<strong className="walkie-strong">{bold.slice(2, -2)}</strong>)
    } else if (head) {
      push(<strong className="walkie-strong">{head.replace(/^#{1,4}[ \t]+/, '')}</strong>)
    }
  }
  if (last < text.length) push(text.slice(last))
  return <>{out}</>
}
