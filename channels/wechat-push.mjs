#!/usr/bin/env node
/**
 * 主动推送 — 让 agent 在处理一条消息的途中，随时往微信发消息。
 *
 * 背景：worker 只在「一条入站消息处理完」时发送回复，中间过程没有话事权。
 * 于是「收到→里程碑→结果」这种三段式回信做不了。本工具直接复用
 * data/channels/wechat.json 里的 token + contextTokens[peer] 打
 * ilink/bot/sendmessage，把发送权交回给 agent 自己。
 *
 * 判据仍是「响应体含 message_id」才算受理。实测缓存 context_token 有效
 * （2026-10-01 主动推送返回 message_id 且用户确认收到），源码头部那句
 * 「缓存旧值会静默不投递」不成立 —— 详见 docs/WECHAT-CHANNEL.md。
 *
 * 用法：
 *   node channels/wechat-push.mjs "消息内容"
 *   echo "内容" | node channels/wechat-push.mjs
 *   node channels/wechat-push.mjs --to <peer> "内容"
 *
 * 退出码：0 = 受理，1 = 未受理/参数错。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STATE_FILE = path.join(REPO, 'data', 'channels', 'wechat.json')

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '2.4.9'
const CLIENT_VERSION = '132105'
const BOT_AGENT = 'NexusWechat/1.0.0'
const CHUNK_LIMIT = 2000
const SEND_GAP_MS = 1200

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chunk = (s, limit = CHUNK_LIMIT) =>
  s.length <= limit ? [s] : s.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) ?? [s]

const wechatUin = () =>
  Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64')

async function send(token, to, text, contextToken) {
  const parts = chunk(text)
  for (const [i, part] of parts.entries()) {
    const res = await fetch(`${ILINK_BASE}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': CLIENT_VERSION,
        'X-WECHAT-UIN': wechatUin(),
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: `nexus-${crypto.randomUUID()}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: part } }],
        },
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
      }),
    })
    const body = await res.text()
    const ok = /"message_id"\s*:\s*\d+/.test(body)
    if (!ok) {
      process.stderr.write(`未受理 HTTP ${res.status}: ${body.slice(0, 300)}\n`)
      return false
    }
    if (i < parts.length - 1) await sleep(SEND_GAP_MS)
  }
  return true
}

async function main() {
  const argv = process.argv.slice(2)
  let to = null
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--to') { to = argv[++i]; continue }
    rest.push(argv[i])
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const peers = Object.keys(state.contextTokens ?? {})
  if (!to) {
    if (peers.length !== 1) {
      process.stderr.write(`需要 --to <peer>（当前有 ${peers.length} 个候选）\n`)
      process.exit(1)
    }
    to = peers[0]
  }
  const ctx = state.contextTokens?.[to]
  if (!ctx) {
    process.stderr.write(`没有 ${to} 的 context_token，无法主动推送\n`)
    process.exit(1)
  }

  // 内容优先取参数，其次读 stdin（管道用法）
  let text = rest.join(' ')
  if (!text && !process.stdin.isTTY) {
    text = fs.readFileSync(0, 'utf8')
  }
  text = text.replace(/\s+$/, '')
  if (!text) {
    process.stderr.write('内容为空\n')
    process.exit(1)
  }

  process.exit((await send(state.token, to, text, ctx)) ? 0 : 1)
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e.message}\n`)
  process.exit(1)
})
