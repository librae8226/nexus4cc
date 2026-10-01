#!/usr/bin/env node
/**
 * Nexus 微信通道 worker — iLink / 微信 ClawBot
 *
 * 职责：微信私聊消息 → headless Claude agent → 回复回微信。
 * 由 PM2 监督常驻；对话transcript 写入 data/channels/wechat.log，
 * 由一个普通 tmux window 跑 `tail -F` 观看（显示层复用 Nexus 现有 PTY/WS 通路）。
 *
 * 设计要点（均为实测结论，改动前请先读 docs 或 commit 历史）：
 *   - 出站判据是「响应体含 message_id」，iLink 不返回 ret 字段
 *   - message_id 是大整数，必须按字符串处理，JSON.parse 会静默丢精度
 *   - context_token 必须取自当前入站消息，用缓存旧值会静默不投递
 *   - 无续期接口，-14 唯一恢复路径是重新扫码
 *
 * 环境变量：
 *   WECHAT_PROFILE      使用的 profile id（data/configs/<id>.json），默认 deepseek
 *   WECHAT_WORKDIR      agent 的工作目录（决定其文件访问范围与人格上下文），默认 ~/work
 *   WECHAT_ALLOW_FROM   白名单，覆盖配置文件里的 allowFrom（逗号分隔）
 *   WECHAT_PERMISSION   完整权限开关：full（默认，对齐现有 claude 窗口）| safe（只读+检索）
 *   CLAUDE_BIN          claude 可执行文件路径，默认从 PATH 解析
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

// ─── 配置 ────────────────────────────────────────────────────────────────
const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const CHANNEL_VERSION = '2.4.9'
const CLIENT_VERSION = '132105'
const BOT_AGENT = 'NexusWechat/1.0.0'

const DATA_DIR = path.join(REPO, 'data', 'channels')
const STATE_FILE = path.join(DATA_DIR, 'wechat.json')
const LOG_FILE = path.join(DATA_DIR, 'wechat.log')
const LOG_MAX_BYTES = 5 * 1024 * 1024
const QR_TIMEOUT_MS = 5 * 60_000
const AGENT_TIMEOUT_MS = Number(process.env.WECHAT_AGENT_TIMEOUT_MS || 300_000)
const MAX_TURNS = Number(process.env.WECHAT_MAX_TURNS || 40)
const SEEN_MAX = 2000
const SEND_GAP_MS = 1200          // 发送节流，社区观测到 <1s 易触发限流
const CHUNK_LIMIT = 2000          // 长文切分阈值

const PROFILE_ID = process.env.WECHAT_PROFILE || 'deepseek'
const PROFILE_PATH = path.join(REPO, 'data', 'configs', `${PROFILE_ID}.json`)
const WORKDIR = process.env.WECHAT_WORKDIR || path.join(os.homedir(), 'work')
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const FULL_PERMISSIONS = (process.env.WECHAT_PERMISSION || 'full') !== 'safe'

// ─── 日志 ────────────────────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true })

function rotateLog() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    }
  } catch { /* 轮转失败不影响主流程 */ }
}

/** 同时写 stdout（PM2 日志）和观看用日志（tail -F） */
function emit(line) {
  const stamped = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${line}`
  console.log(stamped)
  try { fs.appendFileSync(LOG_FILE, stamped + '\n') } catch { /* ignore */ }
}

// ─── 状态持久化 ──────────────────────────────────────────────────────────
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch { return {} }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch }
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
  try { fs.chmodSync(STATE_FILE, 0o600) } catch { /* ignore */ }
}

// ─── profile → env ───────────────────────────────────────────────────────
// 与 nexus-run-claude.sh:62-121 保持一致，改一处必须改两处。
// 注意：模型别名仅在第三方 API（有 BASE_URL）时映射，Anthropic 官方留给 /model 控制。
function profileEnv() {
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error(`找不到 profile: ${PROFILE_PATH}`)
  }
  const c = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'))
  const env = {
    ...process.env,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') env[k] = String(v) }

  set('ANTHROPIC_BASE_URL', c.BASE_URL)
  set('ANTHROPIC_AUTH_TOKEN', c.AUTH_TOKEN)
  set('ANTHROPIC_API_KEY', c.API_KEY)
  if (c.BASE_URL && c.DEFAULT_MODEL) {
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
                     'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
      env[k] = String(c.DEFAULT_MODEL)
    }
  }
  set('ANTHROPIC_DEFAULT_HAIKU_MODEL', c.DEFAULT_HAIKU_MODEL)
  set('ANTHROPIC_THINK_MODEL', c.THINK_MODEL)
  set('ANTHROPIC_LONG_CONTEXT_MODEL', c.LONG_CONTEXT_MODEL)
  set('API_TIMEOUT_MS', c.API_TIMEOUT_MS)
  // 第三方模型不在 Claude Code 已知模型表内，显式声明真实窗口，避免提前 auto-compact
  set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', c.CONTEXT_TOKENS)
  return { env, label: c.label || PROFILE_ID, model: c.DEFAULT_MODEL || '(默认)' }
}

// ─── iLink 协议 ──────────────────────────────────────────────────────────
/** X-WECHAT-UIN: 随机 uint32 → 十进制字符串 → base64，每请求重新生成（防重放） */
const wechatUin = () =>
  Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64')

function ilinkHeaders(token, { uin = true } = {}) {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': CLIENT_VERSION,
    ...(uin ? { 'X-WECHAT-UIN': wechatUin() } : {}),
    ...(token ? { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${token}` } : {}),
  }
}

async function ilinkPost(endpoint, body, token, timeoutMs = 20_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${ILINK_BASE}/${endpoint}`, {
      method: 'POST',
      headers: ilinkHeaders(token),
      body: JSON.stringify({ ...body, base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
    return { http: res.status, json, text }
  } finally { clearTimeout(timer) }
}

async function ilinkGet(endpoint) {
  const res = await fetch(`${ILINK_BASE}/${endpoint}`, { headers: ilinkHeaders(null, { uin: false }) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  return { http: res.status, json, text }
}

/** message_id 是大整数（实测 7.5e18 ≫ MAX_SAFE_INTEGER），从原始文本按字符串抽取 */
const extractMessageIds = (raw) => [...raw.matchAll(/"message_id"\s*:\s*(\d+)/g)].map((m) => m[1])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function renderQR(content) {
  emit('')
  emit('  ┌──────────────────────────────────────────────────────────┐')
  emit('  │  微信扫码绑定 — 请用微信扫描下方二维码                    │')
  emit('  │  也可在桌面浏览器打开下面那行 URL                        │')
  emit('  └──────────────────────────────────────────────────────────┘')
  emit('')
  emit(`  ${content}`)
  emit('')
}

// ─── 登录 ────────────────────────────────────────────────────────────────
async function login(reason) {
  emit(`🔐 开始微信扫码登录（${reason}）…`)
  const qr = await ilinkGet(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`)
  if (!qr.json?.qrcode) {
    throw new Error(`获取二维码失败: HTTP ${qr.http} ${qr.text?.slice(0, 200)}`)
  }
  let qrcodeId = qr.json.qrcode
  renderQR(qr.json.qrcode_img_content)

  const deadline = Date.now() + QR_TIMEOUT_MS
  let refreshes = 0
  let done = null

  while (Date.now() < deadline) {
    await sleep(1500)
    const st = await ilinkGet(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`)
    const status = st.json?.status

    if (status === 'wait') continue
    if (status === 'scaned') { emit('👀 已扫码，请在微信端确认…'); continue }
    if (status === 'expired') {
      if (++refreshes > 3) throw new Error('二维码多次过期，放弃')
      emit(`⏳ 二维码过期，刷新 (${refreshes}/3)…`)
      const again = await ilinkGet(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`)
      qrcodeId = again.json?.qrcode ?? qrcodeId
      if (again.json?.qrcode_img_content) renderQR(again.json.qrcode_img_content)
      continue
    }
    if (status === 'need_verifycode') {
      throw new Error('微信要求验证码（need_verifycode），请在微信端完成验证后重启本服务')
    }
    if (status === 'confirmed') {
      done = {
        token: st.json.bot_token,
        baseUrl: st.json.baseurl || ILINK_BASE,
        botId: st.json.ilink_bot_id,
        // 扫码者本人 —— 这就是白名单唯一正确的值
        allowFrom: [st.json.ilink_user_id],
        contextTokens: {},
        getUpdatesBuf: '',
        loggedInAt: new Date().toISOString(),
      }
      break
    }
    if (['failed', 'canceled'].includes(status)) {
      throw new Error(`登录失败: ${status} ${JSON.stringify(st.json).slice(0, 200)}`)
    }
  }
  if (!done) throw new Error('登录超时')

  saveState(done)
  emit(`✅ 绑定成功`)
  emit(`   ilink_bot_id : ${done.botId}`)
  emit(`   allow_from   : ${done.allowFrom.join(', ')}`)
  return done
}

// ─── headless agent ──────────────────────────────────────────────────────
/** 跑一轮 claude -p，返回 { reply, isError, sessionId, permissionMode, model, toolCount, cost } */
function runAgent(prompt, { resumeId, env, label, model }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(MAX_TURNS)]
    if (FULL_PERMISSIONS) args.push('--dangerously-skip-permissions')
    if (resumeId) args.push('--resume', resumeId)
    args.push(prompt)

    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKDIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const st = { result: null, sessionId: null, init: null, toolCount: 0, stderr: '' }
    const timer = setTimeout(() => {
      emit(`   ⏱ agent 超过 ${AGENT_TIMEOUT_MS / 1000}s，终止`)
      child.kill('SIGTERM')
    }, AGENT_TIMEOUT_MS)

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      let ev
      try { ev = JSON.parse(line) } catch { return }

      // 白名单过滤：实测单轮 100+ 行里绝大多数是 system 噪音（thinking_tokens 等）
      if (ev.type === 'system' && ev.subtype === 'init') {
        st.init = ev
        st.sessionId = ev.session_id
        return
      }
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use') {
            st.toolCount++
            emit(`   🔧 ${block.name}: ${JSON.stringify(block.input ?? {}).slice(0, 160)}`)
          } else if (block.type === 'text' && block.text?.trim()) {
            emit(`   💬 ${block.text.trim().slice(0, 200)}`)
          }
        }
        return
      }
      if (ev.type === 'result') {
        st.result = ev
        st.sessionId = ev.session_id || st.sessionId
      }
    })

    child.stderr.on('data', (d) => { st.stderr += d.toString() })

    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!st.result) {
        return reject(new Error(`agent 退出码 ${code}，未产出 result 事件${st.stderr ? `: ${st.stderr.trim().slice(0, 200)}` : ''}`))
      }
      resolve({
        reply: st.result.result ?? '',
        isError: st.result.is_error === true || st.result.subtype !== 'success',
        sessionId: st.sessionId,
        permissionMode: st.init?.permissionMode,
        model: st.init?.model,
        toolCount: st.toolCount,
        cost: st.result.total_cost_usd,
      })
    })
  })
}

// ─── 发送 ────────────────────────────────────────────────────────────────
/** 按 ~2000 字符在段落边界切分；同 context_token，每段新 client_id */
function chunk(text, limit = CHUNK_LIMIT) {
  if (text.length <= limit) return [text]
  const out = []
  let buf = ''
  for (const para of text.split('\n\n')) {
    const piece = buf ? `${buf}\n\n${para}` : para
    if (piece.length > limit && buf) { out.push(buf); buf = para } else { buf = piece }
  }
  if (buf) out.push(buf)
  return out
}

async function sendMessage(token, to, text, contextToken) {
  const parts = chunk(text)
  for (const [i, part] of parts.entries()) {
    const res = await ilinkPost('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: `nexus-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: part } }],
      },
    }, token)
    // 判据：响应体含 message_id 才算受理（iLink 不返回 ret）
    const ids = extractMessageIds(res.text)
    const ok = ids.length > 0
    emit(`   ↳ 发送 ${i + 1}/${parts.length} (${part.length}字) HTTP ${res.http} → ${ok ? `受理 ${ids.at(-1)}` : `⚠️ 未受理: ${res.text.slice(0, 160)}`}`)
    if (!ok) return false
    if (i < parts.length - 1) await sleep(SEND_GAP_MS)
  }
  return true
}

// ─── 主流程 ──────────────────────────────────────────────────────────────
async function main() {
  rotateLog()

  let state = loadState()

  // 白名单硬校验：不允许留空，否则任何能给该 bot 发消息的人都等于拿到本机 shell
  const envAllow = (process.env.WECHAT_ALLOW_FROM || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (envAllow.length) state.allowFrom = envAllow

  if (!state.token) {
    state = await login('首次绑定')
  }
  if (!Array.isArray(state.allowFrom) || state.allowFrom.length === 0) {
    throw new Error('白名单 allowFrom 为空，拒绝启动（防止任意人触发本机命令执行）')
  }

  const { env, label, model } = profileEnv()
  const token = state.token
  const allowSet = new Set(state.allowFrom)

  emit('═'.repeat(64))
  emit('Nexus 微信通道已启动')
  emit(`  bot        : ${state.botId}`)
  emit(`  白名单     : ${[...allowSet].join(', ')}`)
  emit(`  profile    : ${label} / ${model}`)
  emit(`  workdir    : ${WORKDIR}`)
  emit(`  权限       : ${FULL_PERMISSIONS ? '⚠️  完整权限（--dangerously-skip-permissions）' : '受限'}`)
  emit(`  对话日志   : ${LOG_FILE}`)
  if (!fs.existsSync(WORKDIR)) emit(`  ⚠️ workdir 不存在: ${WORKDIR}`)
  emit('═'.repeat(64))

  try {
    const n = await ilinkPost('ilink/bot/msg/notifystart', {}, token)
    emit(`notifystart → HTTP ${n.http}`)
  } catch (e) {
    emit(`notifystart 失败（不致命）: ${e.message}`)
  }

  const seen = new Set(state.seenMessageIds ?? [])
  const sessionsByPeer = { ...(state.sessionsByPeer ?? {}) }
  let buf = state.getUpdatesBuf ?? ''

  // 单消费者：同一 bot_token 只允许一个轮询进程，多进程会互相踢下线
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      emit(`收到 ${sig}，正在退出…`)
      try { await ilinkPost('ilink/bot/msg/notifystop', {}, token) } catch { /* ignore */ }
      process.exit(0)
    })
  }

  emit('长轮询已开始，等待微信消息…')

  while (true) {
    let res
    try {
      res = await ilinkPost('ilink/bot/getupdates', { get_updates_buf: buf }, token, 40_000)
    } catch (e) {
      emit(`⚠️ 轮询异常: ${e.message}，3s 后重试`)
      await sleep(3000)
      continue
    }
    if (res.json === null) continue   // 长轮询超时，正常

    const ret = res.json.ret ?? res.json.errcode
    if (ret === -14) {
      emit('❌ 会话已过期（ret=-14）。iLink 无续期接口，需要重新扫码。')
      emit('   清空凭证后重启本服务即可重新扫码：')
      emit(`   rm ${STATE_FILE} && pm2 restart nexus-wechat`)
      process.exit(3)
    }

    // 游标：非空才持久化；在处理完本批消息后再落盘，宁可重投也不丢
    const nextBuf = res.json.get_updates_buf || null
    const rawIds = extractMessageIds(res.text)

    for (const [i, msg] of (res.json.msgs ?? []).entries()) {
      if (msg.message_type !== 1) continue

      const from = msg.from_user_id
      const ctx = msg.context_token
      const mid = rawIds[i] ?? `seq:${msg.seq}:${from}`

      if (seen.has(mid)) continue

      if (!allowSet.has(from)) {
        emit(`⛔ 非白名单发送者，已丢弃: ${from}`)
        seen.add(mid)
        continue
      }

      const text = (msg.item_list ?? []).find((x) => x.type === 1)?.text_item?.text
      if (!text) { emit(`(忽略非文本消息 from=${from})`); seen.add(mid); continue }

      emit('─'.repeat(64))
      emit(`📩 微信消息  from=${from}`)
      emit(`   ${text}`)

      const started = Date.now()
      try {
        const out = await runAgent(text, { resumeId: sessionsByPeer[from], env, label, model })
        sessionsByPeer[from] = out.sessionId
        const secs = ((Date.now() - started) / 1000).toFixed(1)
        emit(`   完成 ${secs}s  工具 ${out.toolCount} 次  $${(out.cost ?? 0).toFixed(4)}  is_error=${out.isError}`)

        await sendMessage(token, from, out.reply || '（agent 无输出）', ctx)
      } catch (e) {
        emit(`   ❌ agent 失败: ${e.message}`)
        await sendMessage(token, from, `⚠️ 执行失败：${e.message}`, ctx).catch(() => {})
      }
      emit('─'.repeat(64))

      // 处理成功后才记入去重表并落盘
      seen.add(mid)
      if (ctx) state.contextTokens = { ...(state.contextTokens ?? {}), [from]: ctx }
      saveState({
        getUpdatesBuf: nextBuf ?? buf,
        seenMessageIds: [...seen].slice(-SEEN_MAX),
        sessionsByPeer,
        contextTokens: state.contextTokens,
      })
    }

    if (nextBuf) { buf = nextBuf; saveState({ getUpdatesBuf: buf }) }
  }
}

main().catch((e) => {
  emit(`Fatal: ${e.stack || e.message}`)
  process.exit(1)
})
