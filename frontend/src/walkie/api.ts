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
  /** 这一格现在忙不忙。ready = 还没聊过，不知道 */
  status?: 'working' | 'idle' | 'ready' | 'offline'
}

export interface WalkieProject {
  name: string
  path: string
  channels: WalkieChannel[]
}

/** 从 transcript 里提炼出的"一行动作"。见 walkie.js 的 pushStep。 */
export interface WalkieStep {
  /** say = 他自己说的一句话（**这才是"他在干嘛"**，工具是它的证据） */
  kind: 'say' | 'bash' | 'read' | 'edit' | 'search' | 'task' | 'todo' | 'web' | 'think' | 'tool'
  label: string
  /** 带文件的操作会给路径，前端据此把这行做成可点开的 */
  path?: string
  at?: number
  /** 工具调用 id + 跑完没有。没跑完的那条就是"此刻正在做的事" */
  id?: string
  done?: boolean
}

/** 此刻正在发生的那一件事（状态，不是"做过的事"） */
export interface WalkieNow {
  kind: WalkieStep['kind']
  label: string
  since: number
}

export interface ChannelList {
  projects: WalkieProject[]
  llm: { label: string; model: string } | null
  /** 本机转写服务（PM2 `intake`）在不在 */
  asr: boolean
  tmux: boolean
}

/**
 * 流里的一条。**这一屏的全部差异就在这个类型里**：它的另一端是这台机器上
 * 所有在跑的 claude —— 包括你白天在终端里开的那些窗口，不只是从手机上发出去的那条。
 */
export interface StreamEvent {
  id: string
  /** "project:window" */
  ch: string
  project: string
  window: number
  name: string
  cwd: string
  /** 家目录已缩成 ~ */
  path: string
  kind: 'you' | 'it'
  text: string
  at: number
  /** 这一轮还没答完 = 机器现在正在干这件事（只有最后一回合会是 true） */
  running?: boolean
  /** running 时它到目前为止说的最后一句 */
  partial?: string
}

export interface StreamState {
  projects: WalkieProject[]
  events: StreamEvent[]
  /** 现在有几件活在跑 */
  running: number
  at: number
}

export interface ReplyState {
  state: 'idle' | 'running' | 'done' | 'timeout'
  /** 后端给的阶段文案（认领会话 / 正在输出 / 已完成）——直接显示给用户 */
  stage?: string
  /** 这一轮是谁要的。切走再切回来要靠它把「你说 · X」补回去 */
  sent?: string
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
  /** 他在干什么：从 transcript 提炼出的"一行动作"，一行一步 */
  steps?: WalkieStep[]
  /** 此刻正在跑的那一件事（"推理中"是状态，不是一步） */
  now?: WalkieNow | null
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

/** 跨会话的一条时间线。这是这一屏的主屏。 */
export const getStream = (token: string) => req<StreamState>('/api/walkie/stream', token)

/** 附件：把文件交出去，拿回它的绝对路径（那句话里会带上） */
export async function uploadAttachment(token: string, file: File): Promise<{ path: string; name: string }> {
  const res = await fetch(`/api/walkie/upload?name=${encodeURIComponent(file.name || 'file')}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', Authorization: `Bearer ${token}` },
    body: file,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data && (data.hint || data.error)) || `HTTP ${res.status}`)
  return data as { path: string; name: string }
}

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
