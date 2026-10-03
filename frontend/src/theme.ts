// theme.ts — 全局主题：跟随系统，可被手动覆盖
//
// 【为什么从 Terminal.tsx 里抽出来】
// 主题是**整个应用**的事，不只是终端的事：对讲机那一屏也要用它，而且要在
// 系统切换深浅色时**实时**跟着变。原来的写法是在 Terminal.tsx 的模块作用域里
// `applyNexusCssVars(getInitialTheme())` —— 于是任何 import 到 Terminal 的组件
// 都会顺带改全局外观（一个带副作用的模块），而且对讲机屏根本没法主动响应变化。
//
// 【顺带修掉的一处死代码】原来只写内联 CSS 变量，**从不加 `.light` 类** ——
// 而 index.css 里定义了一整套 `:root.light`，从来没生效过。现在两边都做：
// 变量给运行时用，类名给样式表里按主题分叉的规则用（比如对讲机那两个语义色）。

export type ThemeMode = 'dark' | 'light'

const THEME_KEY = 'nexus_theme'
const MQ = '(prefers-color-scheme: dark)'

/** 有没有手动设过。没设过 = 跟随系统。 */
export function hasThemeOverride(): boolean {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'dark' || v === 'light'
  } catch { return false }
}

export function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch { /* 隐私模式 */ }
  return typeof window !== 'undefined' && window.matchMedia?.(MQ).matches ? 'dark' : 'light'
}

export function systemTheme(): ThemeMode {
  return typeof window !== 'undefined' && window.matchMedia?.(MQ).matches ? 'dark' : 'light'
}

/** 主题色板 — 统一 Tailwind slate 色阶。写内联变量，另外把 `.light` 类也切上。 */
export function applyNexusCssVars(mode: ThemeMode): void {
  const isDark = mode === 'dark'
  const root = document.documentElement
  root.style.setProperty('--nexus-bg',         isDark ? '#0f172a' : '#ffffff')   // slate-900 / white
  root.style.setProperty('--nexus-bg2',        isDark ? '#1e293b' : '#f1f5f9')   // slate-800 / slate-100
  root.style.setProperty('--nexus-menu-bg',    isDark ? '#1e293b' : '#ffffff')    // 面板/弹层背景
  root.style.setProperty('--nexus-border',     isDark ? '#334155' : '#e2e8f0')   // slate-700 / slate-200
  root.style.setProperty('--nexus-text',       isDark ? '#f1f5f9' : '#0f172a')   // slate-100 / slate-900
  root.style.setProperty('--nexus-text2',      isDark ? '#94a3b8' : '#64748b')   // slate-400 / slate-500
  root.style.setProperty('--nexus-muted',      isDark ? '#475569' : '#94a3b8')   // slate-600 / slate-400
  root.style.setProperty('--nexus-tab-active', isDark ? '#1e293b' : '#f1f5f9')   // 选中标签高亮
  root.style.setProperty('--nexus-accent',     '#3b82f6')                        // blue-500
  root.style.setProperty('--nexus-success',    '#22c55e')                        // green-500
  root.style.setProperty('--nexus-warning',    isDark ? '#f59e0b' : '#b45309')   // amber-500 / amber-700
  root.style.setProperty('--nexus-error',      '#ef4444')                        // red-500
  // 样式表里按主题分叉的规则要用这个类；`color-scheme` 让系统控件（滚动条、
  // 输入框的原生装饰）也跟着走，不然浅色页面会拖一条黑滚动条。
  root.classList.toggle('light', !isDark)
  root.style.colorScheme = mode
}

/**
 * 系统切深浅色时回调 —— 只在**没有手动覆盖**时生效（有覆盖就说明你指定了）。
 * 返回取消订阅。
 */
export function watchSystemTheme(onChange: (m: ThemeMode) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const mq = window.matchMedia?.(MQ)
  if (!mq?.addEventListener) return () => {}
  const handler = () => { if (!hasThemeOverride()) onChange(systemTheme()) }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
