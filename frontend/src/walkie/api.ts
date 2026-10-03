// walkie/api.ts — 对讲机模式的后端接口封装
//
// 路径一律写相对形式：浏览器里与 server 同源，APK 里被 baseUrl.ts 的 fetch shim
// 改写到真实服务器 —— 同一份代码两条路都通，不需要分支判断。

export interface WalkieChannel {
  index: number
  name: string
  cwd: string
  active: boolean
  /** 'other' = 该 pane 里没有 claude，发过去会被 shell 当命令执行，前端必须禁发 */
  kind: 'claude' | 'other'
}

export interface WalkieProject {
  name: string
  path: string
  channels: WalkieChannel[]
}

export interface ChannelList {
  projects: WalkieProject[]
  llm: { label: string; model: string } | null
  /** 本机转写服务（PM2 `intake`）在不在。不在就先告诉用户，别等他按下去才发现 */
  asr: boolean
  tmux: boolean
}

export interface ReplyState {
  state: 'idle' | 'running' | 'done' | 'timeout'
  /** 后端给的阶段文案（认领会话 / 正在输出 / 已完成）——直接显示给用户 */
  stage?: string
  text: string
  partial?: string
  done?: boolean
  error?: string | null
  sessionId?: string | null
  via?: string | null
  elapsedMs?: number
  /**
   * 目标 pane 底部几行的纯文本。等回复的时候把它显示出来 ——
   * "AI 在干活但界面上什么都没有"是最没法自查的状态：有了这个，
   * 卡在权限对话框、卡在 shell、正在跑工具，一眼就能看出来。
   */
  paneTail?: string[]
  /** 后端给的排障提示（认领会话失败、目标不是 claude 等） */
  hint?: string | null
}

async function req<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error((data && (data.hint || data.error)) || `HTTP ${res.status}`) as Error & { code?: number; hint?: string }
    err.code = res.status
    throw err
  }
  return data as T
}

export const getChannels = (token: string) => req<ChannelList>('/api/walkie/channels', token)

export const sendPrompt = (token: string, project: string, window: number, text: string) =>
  req<{ ok: boolean; key: string }>('/api/walkie/send', token, {
    method: 'POST',
    body: JSON.stringify({ project, window, text }),
  })

export const refineText = (token: string, text: string) =>
  req<{ text: string; refined: boolean; reason?: string }>('/api/walkie/refine', token, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })

export const summarizeText = (token: string, text: string) =>
  req<{ text: string; summarized: boolean; reason?: string }>('/api/walkie/summarize', token, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })

export const getReply = (token: string, project: string, window: number, peek = false) =>
  req<ReplyState>(
    `/api/walkie/reply?project=${encodeURIComponent(project)}&window=${window}${peek ? '&peek=1' : ''}`,
    token,
  )

/** 项目名在旋钮上太长了（home-librae-work-server-admin-debian-l-colorful），取末段显示 */
export function shortProject(name: string): string {
  const parts = name.split('-')
  if (name.length <= 14) return name
  return parts.length > 1 ? parts[parts.length - 1] : name.slice(0, 14)
}
