// walkie/mode.ts — 决定这次启动进哪个界面（经典终端 / 对讲机）
//
// 优先级从高到低：
//   1. URL 的 ?ui=walkie|classic  —— 电脑上想临时看一眼对讲机，加个参数就行
//   2. localStorage               —— 你在 App 里手动切过，就记住
//   3. 构建产物里的 ui-mode.json  —— Android 风味包自带的出厂默认
//   4. classic                    —— 兜底，且保证浏览器里行为与从前逐字节一致
//
// 第 3 条是为「同一个代码库出两个 APK」服务的：两个 product flavor 各自往
// assets/public/ui-mode.json 里塞一个 {"default":"walkie"} / {"default":"classic"}，
// 前端启动时读它。这样不需要构建两份 bundle，浏览器那边读到的是 SPA 兜底返回的
// index.html（不是 JSON），解析失败 → 当作没有这个文件。

export type UiMode = 'walkie' | 'classic'

const LS_KEY = 'nexus_ui_mode'
const PROBE_PATH = '/ui-mode.json'

let buildDefault: UiMode | null = null
let probed = false

/** 出厂默认（APK 风味决定）。probe 之后才有值，浏览器里恒为 null。 */
export const buildDefaultMode = (): UiMode | null => buildDefault

async function probeBuildDefault(): Promise<UiMode | null> {
  if (probed) return buildDefault
  probed = true
  try {
    const res = await fetch(PROBE_PATH, { cache: 'no-store' })
    // 浏览器里这个路径会被 SPA 兜底成 index.html（200 + text/html），
    // 所以先看 content-type，别拿 HTML 去 JSON.parse
    if (!(res.headers.get('content-type') || '').includes('json')) return null
    const j = (await res.json()) as { default?: string }
    if (j?.default === 'walkie' || j?.default === 'classic') buildDefault = j.default
  } catch { /* 没有这个文件 —— 正常情况 */ }
  return buildDefault
}

export async function resolveMode(): Promise<UiMode> {
  // 无条件先探一次出厂默认 —— **不能**因为 localStorage 有值就跳过。
  // 那个值是"上次停在哪"，而 buildDefaultMode() 决定的是"经典界面里要不要显示
  // 回对讲机的浮标"。跳过探针的后果：在对讲机包里手动切到经典 → 下次启动读到
  // classic 就不探了 → 浮标不渲染 → 再也回不去对讲机界面。
  const baked = await probeBuildDefault()

  const q = new URLSearchParams(location.search).get('ui')
  if (q === 'walkie' || q === 'classic') {
    try { localStorage.setItem(LS_KEY, q) } catch { /* 隐私模式 */ }
    return q
  }
  try {
    const saved = localStorage.getItem(LS_KEY)
    if (saved === 'walkie' || saved === 'classic') return saved
  } catch { /* 隐私模式 */ }
  return baked ?? 'classic'
}

export function rememberMode(m: UiMode): void {
  try { localStorage.setItem(LS_KEY, m) } catch { /* 隐私模式 */ }
}
