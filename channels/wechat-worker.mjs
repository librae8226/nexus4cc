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
 *   WECHAT_WORKDIR      agent 的工作目录（决定 session 池、memory 与人格上下文），
 *                       默认 ~/work；部署值见 ecosystem.config.cjs。
 *                       入站媒体也落在这里（WORKDIR/inbox/<日期>/）
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
// -14（会话被顶掉）后的探测间隔。iLink 无续期接口，只能等人工重扫，
// 30 分钟探一次足够，绝不能退化成 5 秒热循环。
const EXPIRED_POLL_MS = Number(process.env.WECHAT_EXPIRED_POLL_MS || 30 * 60_000)
const HEARTBEAT_SAVE_MS = 10 * 60_000   // 存活心跳落盘节流

const PROFILE_ID = process.env.WECHAT_PROFILE || 'deepseek'
const PROFILE_PATH = path.join(REPO, 'data', 'configs', `${PROFILE_ID}.json`)
const WORKDIR = process.env.WECHAT_WORKDIR || path.join(os.homedir(), 'work')
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const FULL_PERMISSIONS = (process.env.WECHAT_PERMISSION || 'full') !== 'safe'
// 本地复核：用 fcitx5-vinput 自带的 sherpa-onnx 再转写一遍语音，两边对不上就标出来。
// 任何失败都只是少一行提示，不影响消息投递。
const LOCAL_ASR = (process.env.WECHAT_LOCAL_ASR || 'on') !== 'off'
const ASR_SCRIPT = path.join(__dirname, 'local-asr.py')
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3'
const ASR_TIMEOUT_MS = Number(process.env.WECHAT_ASR_TIMEOUT_MS || 20_000)
// 微信偶发把「还没打完就按了发送」的残句先送到，用户重打一遍，后一条就成了前一条的
// 严格延长。窗口内认定是同一件事的补全版，别当两个问题各答一遍。
const MERGE_WINDOW_MS = Number(process.env.WECHAT_MERGE_WINDOW_MS || 10 * 60_000)
// 会话收口：agent 处理完本轮后若写了这个文件，就清空本会话，下条消息开干净窗口。
const HANDOFF_FILE = path.join(DATA_DIR, 'handoff.json')
// 新会话开场注入多少条事件摘要。目录按 claude 的 project slug 规则推导，可用环境变量覆盖。
const EVENT_KEEP = Number(process.env.WECHAT_EVENT_KEEP || 5)
const EVENT_DIR = process.env.WECHAT_EVENT_DIR || path.join(
  os.homedir(), '.claude', 'projects', WORKDIR.replace(/[/\\]/g, '-'), 'memory', 'events')

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

// ─── 微信媒体（图片/语音/文件/视频）─────────────────────────────────────
// 入站媒体一律是「CDN 直链 + AES key」两段式，落盘前要下载并解密。
// 官方无文档，模式/IV 靠实测候选 + md5 校验确定，见 decryptMedia。
// 入站媒体统一落在 agent 的 CWD 下（WORKDIR/inbox/<日期>/），而不是仓库的 data/：
// 它们是给 agent 读的文件，跟着 cwd 走才符合「一个 agent 一个目录」的模型。
const INBOX_DIR = path.join(WORKDIR, 'inbox')
/** 媒体 CDN 根；full_url 缺失时用它 + encrypt_query_param 拼下载地址 */
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** 微信语音默认采样率（官方包 silk-transcode.ts 取值），消息未带 sample_rate 时用 */
const SILK_DEFAULT_RATE = 24_000

/** media.aes_key 是 base64(32 位 hex 字符串)；image_item.aeskey 是同一串明文 */
function decodeAesKey(aesKey) {
  if (!aesKey) return null
  const s = String(aesKey)
  const raw = Buffer.from(s, 'base64').toString('utf-8')
  const hex = /^[0-9a-f]{32}$/i.test(raw) ? raw : s
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : null
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const looksImage = (b) => b.subarray(0, 3).equals(JPEG_MAGIC) || b.subarray(0, 4).equals(PNG_MAGIC)

/** 按 magic bytes 猜扩展名；无把握返回 null（不硬编后缀，避免误导 agent） */
function sniffExt(b) {
  if (b.subarray(0, 3).equals(JPEG_MAGIC)) return '.jpg'
  if (b.subarray(0, 4).equals(PNG_MAGIC)) return '.png'
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif'
  // RIFF 家族靠第 8 字节区分：WAVE / WEBP / AVI
  if (b.subarray(0, 4).toString('latin1') === 'RIFF') {
    const form = b.subarray(8, 12).toString('latin1')
    if (form === 'WAVE') return '.wav'
    if (form === 'WEBP') return '.webp'
    if (form === 'AVI ') return '.avi'
  }
  if (b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return '.zip'
  if (b.subarray(0, 12).toString('latin1').includes('ftyp')) return '.mp4'
  if (b.subarray(0, 9).toString('latin1').includes('SILK')) return '.silk'
  if (b.subarray(0, 5).toString('latin1') === '#!AMR') return '.amr'
  if (b.subarray(0, 3).toString('latin1') === 'ID3') return '.mp3'
  return null
}

/**
 * 解密微信 CDN 媒体。候选模式依次尝试，用 verify（md5 或 magic bytes）判定命中；
 * verify 为 null 时（如语音/视频，消息里不带 md5）取第一个能解出的候选。
 *
 * 2026-10-01 实测：xlsx / 语音 / 图片三类均命中 aes-128-ecb，且解密后 md5 与
 * file_item.md5 逐字节相符；CBC 的两种 IV 均 bad decrypt，故 ECB 放第一位。
 */
function decryptMedia(enc, key, verify) {
  if (verify && verify(enc)) return { buf: enc, mode: 'plain（CDN 未加密）' }
  const modes = [
    { name: 'aes-128-ecb', alg: 'aes-128-ecb', iv: null },
    { name: 'aes-128-cbc/iv=key', alg: 'aes-128-cbc', iv: key },
    { name: 'aes-128-cbc/iv=0', alg: 'aes-128-cbc', iv: Buffer.alloc(16) },
  ]
  const tried = []
  for (const m of modes) {
    try {
      const d = crypto.createDecipheriv(m.alg, key, m.iv)
      const out = Buffer.concat([d.update(enc), d.final()])
      if (!verify || verify(out)) return { buf: out, mode: m.name }
      tried.push(`${m.name}: 校验不符`)
    } catch (e) { tried.push(`${m.name}: ${e.message}`) }
  }
  throw new Error(`解密失败（${tried.join('; ')}）`)
}

/** 裸 PCM(s16le, 单声道) 套 WAV 容器 */
function pcmToWav(pcm, sampleRate) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)          // fmt chunk 大小
  h.writeUInt16LE(1, 20)           // PCM
  h.writeUInt16LE(1, 22)           // 单声道
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)           // block align
  h.writeUInt16LE(16, 34)          // 位深
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/**
 * SILK → WAV。ffmpeg 无 SILK 解码器（实测确认），必须用 silk-wasm（腾讯官方插件同款）。
 * 采样率优先用消息自带的 voice_item.sample_rate，缺失时退 24000（官方包默认值）。
 */
async function silkToWav(silkBuf, sampleRate) {
  const { decode } = await import('silk-wasm')
  const { data } = await decode(silkBuf, sampleRate)
  return pcmToWav(Buffer.from(data), sampleRate)
}

/** 同名文件不覆盖，追加 -1/-2… */
function uniquePath(dir, name) {
  const base = path.basename(String(name || 'file')).replace(/[\/\\\0]/g, '_').replace(/^\.+/, '_').slice(0, 120)
  let file = path.join(dir, base || 'file')
  for (let n = 1; fs.existsSync(file); n++) {
    const ext = path.extname(base)
    file = path.join(dir, `${path.basename(base, ext)}-${n}${ext}`)
  }
  return file
}

/** 下载 → 解密 → 落盘。返回 { path } 或 { note } 说明失败原因 */
async function saveMedia(media, { name, md5, kind, mid, aeskey, transcode, sampleRate }) {
  // 官方实现优先用 image_item.aeskey（明文 hex），其次 media.aes_key（base64）
  const url = media?.full_url || (media?.encrypt_query_param
    ? `${CDN_BASE}/download?encrypted_query_param=${media.encrypt_query_param}`
    : null)
  if (!url) return { path: null, note: '消息里既无 full_url 也无 encrypt_query_param' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  let enc
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return { path: null, note: `下载 HTTP ${res.status}` }
    enc = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    return { path: null, note: `下载异常 ${e.message}` }
  } finally { clearTimeout(timer) }

  const key = decodeAesKey(aeskey ?? media.aes_key)
  // 校验器：文件有 md5；图片无 md5 但可验 magic bytes；语音/视频两者皆无 → null（信任 ECB 首个候选）
  const verify = md5
    ? (b) => crypto.createHash('md5').update(b).digest('hex') === md5
    : kind === 'image' ? looksImage : null
  let out = enc
  let mode = 'plain（无 key）'
  if (key) {
    try {
      const r = decryptMedia(enc, key, verify)
      out = r.buf
      mode = r.mode
    } catch (e) {
      return { path: null, note: `${e.message}（${enc.length} 字节密文，未落盘）` }
    }
  } else if (verify && !verify(enc)) {
    return { path: null, note: '缺少 aes_key 且校验不符，未落盘' }
  }
  if (verify && !verify(out)) return { path: null, note: `落盘前校验失败，已放弃` }

  // 可选转码：目前只有 SILK→WAV。失败不致命，保留原始文件并如实说明。
  let extraNote = ''
  if (transcode === 'silk2wav') {
    try {
      out = await silkToWav(out, sampleRate || SILK_DEFAULT_RATE)
      extraNote = '，已转 WAV'
    } catch (e) {
      extraNote = `，silk2wav 失败(${e.message})，保留原始 SILK`
    }
  }

  const dir = path.join(INBOX_DIR, new Date().toISOString().slice(0, 10))
  fs.mkdirSync(dir, { recursive: true })
  // 调用方给的名字已带扩展名就照用（文件类）；否则按内容嗅探，嗅不出就不加
  const base = name || `${kind}-${mid}`
  const file = uniquePath(dir, path.extname(base) ? base : `${base}${sniffExt(out) ?? ''}`)
  fs.writeFileSync(file, out)
  return { path: file, note: `${out.length} 字节，${mode}${extraNote}` }
}

/** 调 local-asr.py 转写。任何失败都只返回 { ok:false, note }，不抛。 */
function transcribeLocal(wavPath) {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }

    const child = spawn(PYTHON_BIN, [ASR_SCRIPT, wavPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, note: `超时 ${ASR_TIMEOUT_MS}ms` })
    }, ASR_TIMEOUT_MS)

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, note: `无法启动 ${PYTHON_BIN}：${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = out.trim()
      if (code === 0 && text) finish({ ok: true, text })
      else finish({ ok: false, note: err.trim().split('\n').pop() || `退出码 ${code}` })
    })
  })
}

/**
 * 比对前抹掉空白、标点和大小写：两边标点习惯不同（微信常不给标点、本地会给），
 * 英文大小写也会飘（Nexus/nexus），这些都不该报"不一致"；
 * 真正的字词差异（"啦"vs"了"、"三百万"vs"300万"）必须留下。
 */
const SPEECH_NOISE = /[\s　，。！？；：、""''（）《》〈〉【】「」『』…—～·,.;:!?'"()[\]{}<>~`|/\\@#$%^&*+=_-]/g
const normalizeSpeech = (s) => (s || '').replace(SPEECH_NOISE, '').toLowerCase()

/**
 * 把一条微信消息的 item_list 转成 agent 能读的文本。
 * 媒体一律落盘并把本地路径交给 agent（agent 有完整 Bash/读文件权限，可自行处理）。
 */
async function describeItems(items, { mid }) {
  const parts = []
  for (const it of items) {
    try {
      if (it.type === 1) {
        if (it.text_item?.text) parts.push(it.text_item.text)
      } else if (it.type === 3) {
        const v = it.voice_item ?? {}
        const secs = v.playtime ? (v.playtime / 1000).toFixed(1) : '?'
        // 无论微信是否给了转写，都解一份音频落盘：文本可能错，原始音频是兜底
        const saved = await saveMedia(v.media, {
          name: `voice-${mid}`, kind: 'voice', mid,
          transcode: 'silk2wav', sampleRate: v.sample_rate,
        })
        const lines = [`[语音 ${secs}s] ${v.text || '微信未给出转写文本'}`]
        lines.push(saved.path ? `（原始音频：${saved.path}）` : `（原始音频读取失败：${saved.note}）`)
        if (LOCAL_ASR && saved.path) {
          const asr = await transcribeLocal(saved.path)
          if (!asr.ok) lines.push(`（本地转写失败：${asr.note}）`)
          else if (!v.text) lines.push(`本地转写：${asr.text}`)
          else if (normalizeSpeech(asr.text) === normalizeSpeech(v.text)) lines.push('本地转写：与微信一致')
          else lines.push(`⚠️ 本地转写不一致：${asr.text}`)
        }
        parts.push(lines.join('\n'))
      } else if (it.type === 4) {
        const f = it.file_item ?? {}
        const saved = await saveMedia(f.media, { name: f.file_name, md5: f.md5, kind: 'file', mid })
        parts.push(saved.path
          ? `[微信文件] ${f.file_name || '(未命名)'}（${f.len ?? '?'} 字节）已保存到 ${saved.path}`
          : `[微信文件] ${f.file_name || '(未命名)'} 处理失败：${saved.note}`)
      } else if (it.type === 2) {
        const img = it.image_item ?? {}
        const saved = await saveMedia(img.media, {
          name: `image-${mid}`, kind: 'image', mid,
          // 官方实现优先用 image_item.aeskey（明文 hex），其次 media.aes_key（base64）
          aeskey: img.aeskey,
        })
        parts.push(saved.path
          ? `[微信图片] 已保存到 ${saved.path}`
          : `[微信图片] 处理失败：${saved.note}`)
      } else if (it.type === 5) {
        const vid = it.video_item ?? {}
        // 实测 play_length 可能为 0（此时真实时长要从文件 mvhd 读），别显示错误的 0.0s
        const secs = vid.play_length > 0 ? ` ${(vid.play_length / 1000).toFixed(1)}s` : ''
        const saved = await saveMedia(vid.media, {
          name: `video-${mid}`, kind: 'video', mid,
          md5: vid.video_md5,
        })
        parts.push(saved.path
          ? `[微信视频${secs}] 已保存到 ${saved.path}`
          : `[微信视频${secs}] 处理失败：${saved.note}`)
      } else {
        parts.push(`[未支持的消息类型 type=${it.type}]`)
      }
    } catch (e) {
      parts.push(`[类型 ${it.type} 处理异常: ${e.message}]`)
    }
  }
  return parts.filter(Boolean).join('\n')
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

/**
 * 这条是不是上一条的「补全版」？后者以前者为前缀、更长，且在时间窗口内。
 * now 走参数便于测试。
 */
function isCompletionOf(prev, text, { now = Date.now(), windowMs = MERGE_WINDOW_MS } = {}) {
  return Boolean(prev) &&
    now - prev.at < windowMs &&
    text.length > prev.text.length &&
    text.startsWith(prev.text)
}

/**
 * 新会话的开场白：把最近几条事件摘要带上，免得换了干净窗口就人走茶凉。
 * 读不到就返回空字符串——这只是锦上添花，不能影响消息处理。
 */
function recentEventsBlock() {
  try {
    if (!fs.existsSync(EVENT_DIR)) return ''
    const files = fs.readdirSync(EVENT_DIR).filter((f) => f.endsWith('.md')).sort().slice(-EVENT_KEEP)
    if (!files.length) return ''
    const body = files
      .map((f) => fs.readFileSync(path.join(EVENT_DIR, f), 'utf8').trim())
      .join('\n\n---\n\n')
    return `（新会话开场。以下是最近 ${files.length} 条事件摘要，供你了解上下文，不必逐条回应。）\n\n`
      + `${body}\n\n===== 以下是用户本次消息 =====\n`
  } catch (e) {
    emit(`   ⚠️ 读事件摘要失败（不影响处理）: ${e.message}`)
    return ''
  }
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
  // 存活记录：用来回答「这个会话到底能活多久」——见 docs/WECHAT-CHANNEL.md
  if (state.loggedInAt) {
    const h = ((Date.now() - Date.parse(state.loggedInAt)) / 3600_000).toFixed(1)
    emit(`  绑定于     : ${state.loggedInAt}（已 ${h} 小时）`)
  }
  if (state.lastSeenAt) emit(`  上次活动   : ${state.lastSeenAt}`)
  if (state.expiredAt) emit(`  ⚠️ 曾于 ${state.expiredAt} 过期（累计 ${state.expiredCount ?? 1} 次）`)
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
  // cwd 换了 = Claude Code 的 session 池换了，旧 sessionId 在新池子里不存在，
  // `--resume` 会直接报「找不到会话」。所以 workdir 一变就丢掉续聊指针，
  // 让它重开一个新窗口，而不是把通道弄坏。
  if (state.workdir && state.workdir !== WORKDIR) {
    const n = Object.keys(sessionsByPeer).length
    for (const k of Object.keys(sessionsByPeer)) delete sessionsByPeer[k]
    emit(`⚠️ workdir 变更（${state.workdir} → ${WORKDIR}），已丢弃 ${n} 个续聊会话`)
  }
  saveState({ workdir: WORKDIR, sessionsByPeer })
  // peer → 上一条入站文本。故意只放内存：重启后清空，宁可漏判也不要误判。
  const lastInbound = new Map()
  let buf = state.getUpdatesBuf ?? ''
  let lastSeenSaveMs = 0   // 心跳落盘节流用；初值 0 保证启动后立刻记一次

  /** 记一次「会话活着」：清过期标记 + 节流落盘 lastSeenAt，用于统计真实会话寿命 */
  const markSeen = () => {
    const nowMs = Date.now()
    if (state.expiredAt) {
      emit(`✅ 会话已恢复（${state.expiredAt} → ${new Date(nowMs).toISOString()}）`)
      state.expiredAt = null
      saveState({ expiredAt: null })
    }
    if (nowMs - lastSeenSaveMs < HEARTBEAT_SAVE_MS) return
    lastSeenSaveMs = nowMs
    saveState({ lastSeenAt: new Date(nowMs).toISOString() })
    const since = state.loggedInAt ? ((nowMs - Date.parse(state.loggedInAt)) / 3600_000).toFixed(1) : '?'
    emit(`💓 会话正常（已连接 ${since} 小时）`)
  }

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
    // 长轮询超时属正常：服务端一直挂着连接 = 会话活着，同样算「见到了」
    if (res.json === null) { markSeen(); continue }

    const ret = res.json.ret ?? res.json.errcode
    if (ret === -14) {
      // 不再 exit(3)：那会让 pm2 每 5 秒拉起一次，无限打接口。
      // iLink 无续期接口，唯一恢复路径是人工重扫，所以这里改成低频探测。
      const nowIso = new Date().toISOString()
      if (!state.expiredAt) {
        state.expiredAt = nowIso
        state.expiredCount = (state.expiredCount ?? 0) + 1
        saveState({ expiredAt: state.expiredAt, expiredCount: state.expiredCount })
        emit('❌ 会话已过期（ret=-14）——本 bot 已被顶掉或失效。')
        emit('   iLink 一个微信号同时只能有一个 bot 在线：新扫码会顶掉旧的。')
        emit('   请先确认没有其他绑定在跑，再按 docs/WECHAT-CHANNEL.md 重新绑定。')
        emit('   本进程不会自行重扫，也不会热循环。')
      } else {
        const min = Math.round((Date.now() - Date.parse(state.expiredAt)) / 60_000)
        emit(`   ↳ 仍处于过期状态（已 ${min} 分钟）`)
      }
      emit(`   ${Math.round(EXPIRED_POLL_MS / 60_000)} 分钟后再探一次。`)
      await sleep(EXPIRED_POLL_MS)
      continue
    }

    markSeen()

    // 游标：非空才持久化；在处理完本批消息后再落盘，宁可重投也不丢
    const nextBuf = res.json.get_updates_buf || null
    const rawIds = extractMessageIds(res.text)

    for (const [i, msg] of (res.json.msgs ?? []).entries()) {
      if (msg.message_type !== 1) {
        emit(`(跳过 message_type=${msg.message_type} 的消息 from=${msg.from_user_id})`)
        continue
      }

      const from = msg.from_user_id
      const ctx = msg.context_token
      const mid = rawIds[i] ?? `seq:${msg.seq}:${from}`

      if (seen.has(mid)) continue

      if (!allowSet.has(from)) {
        emit(`⛔ 非白名单发送者，已丢弃: ${from}`)
        seen.add(mid)
        continue
      }

      const text = await describeItems(msg.item_list ?? [], { mid })
      if (!text) {
        emit(`(空消息，已忽略 from=${from})`)
        seen.add(mid)
        continue
      }

      emit('─'.repeat(64))
      emit(`📩 微信消息  from=${from}`)
      emit(`   ${text}`)

      // 补全版检测：不改变处理流程，只是让 agent 知道「这跟上一条是同一件事」
      const prevInbound = lastInbound.get(from)
      lastInbound.set(from, { text, at: Date.now() })
      let prompt = text
      if (isCompletionOf(prevInbound, text)) {
        emit('   ↳ 判定为上一条的补全版（残句重打），标注为同一件事')
        prompt = '（注意：这条与刚才那条是同一件事。上一条是用户还没打完就发出去的残句，'
          + '这条是补全版。按一个完整问题回答，不要拆成两件事。）\n' + text
      }

      // 新会话开场（没有可续的 sessionId）：把最近几条事件摘要带上
      if (!sessionsByPeer[from]) {
        const events = recentEventsBlock()
        if (events) {
          emit(`   ↳ 新会话：注入最近 ${EVENT_KEEP} 条事件摘要`)
          prompt = events + prompt
        }
      }

      const started = Date.now()
      try {
        const out = await runAgent(prompt, { resumeId: sessionsByPeer[from], env, label, model })
        sessionsByPeer[from] = out.sessionId
        const secs = ((Date.now() - started) / 1000).toFixed(1)
        emit(`   完成 ${secs}s  工具 ${out.toolCount} 次  $${(out.cost ?? 0).toFixed(4)}  is_error=${out.isError}`)

        await sendMessage(token, from, out.reply || '（agent 无输出）', ctx)
      } catch (e) {
        emit(`   ❌ agent 失败: ${e.message}`)
        await sendMessage(token, from, `⚠️ 执行失败：${e.message}`, ctx).catch(() => {})
      }
      emit('─'.repeat(64))

      // 收口信号：agent 本轮写了 handoff 文件 = 这件事聊完了，该换干净窗口。
      // 放在落盘之前，好让清空后的 sessionsByPeer 一起持久化。
      if (fs.existsSync(HANDOFF_FILE)) {
        fs.rmSync(HANDOFF_FILE, { force: true })
        delete sessionsByPeer[from]
        emit('   ↳ 收到收口信号：本会话已清空，下条消息开新窗口')
      }

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

// 默认启动长轮询；仅单测 import 时用 WECHAT_NO_MAIN=1 跳过。
// 不要用 process.argv[1] 判定「是否直接执行」——pm2 经 ProcessContainerFork.js 加载本文件，
// argv[1] 是 pm2 的包装器路径而非本文件，判定会为 false，导致通道静默不启动（实测踩过）。
if (process.env.WECHAT_NO_MAIN !== '1') {
  main().catch((e) => {
    emit(`Fatal: ${e.stack || e.message}`)
    process.exit(1)
  })
}

export { describeItems, saveMedia, decryptMedia, decodeAesKey, loadState, isCompletionOf, recentEventsBlock }

