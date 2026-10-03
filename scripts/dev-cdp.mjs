#!/usr/bin/env node
/**
 * dev-cdp.mjs —— 用本机已有的 Chrome（9222）打开一个页面、模拟手机尺寸、截图。
 *
 * 为什么要有它：改移动端 UI 以前只能"改完丢给真机看"，来回一轮几分钟。有了这个，
 * 改完 2 秒就能看到像素级的结果。它**只操作自己新建的那个 tab**，不碰你已经在用的
 * 那些页面（用完自己关掉）。
 *
 * 用法：
 *   node scripts/dev-cdp.mjs shot <url> <out.png> [选项]
 *
 * 选项：
 *   --mobile           按 iPhone 尺寸（390x844, dpr2）渲染
 *   --size <WxH>       自定义视口（如 800x1000）—— 验折叠屏展开/平板那种宽版面
 *   --wait <ms>        加载后额外等多久（默认 1200）
 *   --set k=v          加载后写 localStorage 再刷新（可重复；登录 token 用得上）
 *   --eval "<js>"      在截图前执行一段 JS（可重复，按顺序）
 *   --keep             保留 tab（默认截完就关）
 *   --attach <url:port> 不开新 tab，挂到已有 target 上（WebView 调试口用这个）
 *   --hold <sel> <ms>  按住某个元素 ms 毫秒（真触摸事件，能触发 getUserMedia 的用户手势）
 *   --tap <sel>        点一下某个元素
 *   --drag <sel> <dx> <dy>  横向/纵向拖一段（分步派发真触摸移动，能测滚动吸附）
 *
 * 注意 --hold/--tap 走的是 CDP 的 Input.dispatchTouchEvent，是**可信**输入。
 * 用 JS dispatchEvent 造的合成事件不算用户手势，getUserMedia 会直接拒绝 —— 测不了录音。
 *
 * 例：
 *   node scripts/dev-cdp.mjs shot http://127.0.0.1:59000/?ui=walkie /tmp/w.png \
 *        --mobile --set nexus_token=$TOKEN --eval "document.querySelector('.walkie-chip')"
 */

import fs from 'node:fs'
import { WebSocket } from 'ws'

const CDP = process.env.CDP_BASE || 'http://127.0.0.1:9222'

function parseArgs(argv) {
  const [cmd, url, out] = argv
  const opts = { mobile: false, size: null, wait: 1200, set: [], eval: [], keep: false, attach: '', hold: null, tap: null, drag: null, shotAt: 0 }
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mobile') opts.mobile = true
    else if (a === '--size') { const [w, h] = String(argv[++i]).split('x').map(Number); if (w > 0 && h > 0) opts.size = [w, h] }
    else if (a === '--keep') opts.keep = true
    else if (a === '--attach') opts.attach = argv[++i]
    else if (a === '--hold') opts.hold = { sel: argv[++i], ms: Number(argv[++i]) }
    else if (a === '--tap') opts.tap = argv[++i]
    else if (a === '--drag') opts.drag = { sel: argv[++i], dx: Number(argv[++i]), dy: Number(argv[++i]) }
    else if (a === '--shot-at') opts.shotAt = Number(argv[++i])
    else if (a === '--wait') opts.wait = Number(argv[++i])
    else if (a === '--set') opts.set.push(argv[++i])
    else if (a === '--eval') opts.eval.push(argv[++i])
  }
  return { cmd, url, out, opts }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`开新 tab 失败：HTTP ${res.status}`)
  return res.json()
}

async function closeTab(id) {
  try { await fetch(`${CDP}/json/close/${id}`) } catch { /* 关了就算了 */ }
}

/** 极简 CDP 客户端：够用就行，不引 puppeteer */
class Session {
  constructor(wsUrl) {
    this.id = 0
    this.pending = new Map()
    this.ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 })
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
        else resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
        // 默认 30 秒。要在 --eval 里等一件事自己发生（等 AI 答完、等一轮转写落地），
        // 就用 CDP_TIMEOUT_MS 调大 —— 别去改这个数本身，那是所有调用的默认值。
      }, Number(process.env.CDP_TIMEOUT_MS) || 30000)
    })
  }

  close() { try { this.ws.close() } catch { /* 已经关了 */ } }
}

async function main() {
  const { cmd, url, out, opts } = parseArgs(process.argv.slice(2))
  if (cmd !== 'shot' || (!url && !opts.attach) || !out) {
    console.error('用法：dev-cdp.mjs shot <url> <out.png> [--mobile] [--wait ms] [--set k=v] [--eval js] [--keep]')
    process.exit(2)
  }

  // --attach：挂到已经在跑的 target（Android WebView 的 devtools 口就是这种），
  // 不新建、也不关闭 —— 关了等于把被测的 App 一起关掉。
  let tab
  if (opts.attach) {
    const base = opts.attach
    const r = await fetch(`${base}/json/list`)
    const list = await r.json()
    tab = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!tab) throw new Error(`attach 目标里没有可用的 page：${base}`)
    opts.keep = true
  } else {
    tab = await newTab(url)
  }
  const s = new Session(tab.webSocketDebuggerUrl)
  await s.ready
  await s.send('Page.enable')
  await s.send('Runtime.enable')

  // attach 到真实 WebView 时不要再覆盖尺寸 —— 那会伪造出一个和真机不一样的视口
  if ((opts.mobile || opts.size) && !opts.attach) {
    // --size 用来验折叠屏/平板那种"宽但仍是手机"的版面（竖屏手机验不出宽屏规则）
    const [w, h] = opts.size || [390, 844]
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 2, mobile: true,
    })
    await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  }

  const runJs = async (expr, label) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(`${label} 报错：${r.exceptionDetails.text} ${r.result?.description || ''}`)
    return r.result?.value
  }

  await sleep(opts.wait)

  if (opts.set.length) {
    const js = opts.set.map((kv) => {
      const i = kv.indexOf('=')
      const k = kv.slice(0, i), v = kv.slice(i + 1)
      return `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`
    }).join(';')
    await runJs(js, '--set')
    await s.send('Page.reload', { ignoreCache: false })
    await sleep(opts.wait)
  }

  /** 元素中心（CSS 像素，视口坐标） */
  const centerOf = async (sel) => {
    const v = await runJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, sel)
    if (!v) throw new Error(`找不到元素：${sel}`)
    return v
  }
  const touch = (type, pt) => s.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: pt.x, y: pt.y, radiusX: 6, radiusY: 6, force: 1 }],
  })

  if (opts.tap) {
    const pt = await centerOf(opts.tap)
    await touch('touchStart', pt); await sleep(60); await touch('touchEnd', pt)
    console.log(`tap ${opts.tap} @ ${Math.round(pt.x)},${Math.round(pt.y)}`)
    await sleep(600)
  }

  if (opts.drag) {
    // 横向拖。分步派发：一步到底不产生中间 move 事件，滚动/吸附看不出来。
    const pt = await centerOf(opts.drag.sel)
    const steps = 24
    await touch('touchStart', pt)
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', {
        x: pt.x + (opts.drag.dx * i) / steps,
        y: pt.y + (opts.drag.dy * i) / steps,
      })
      await sleep(12)
    }
    await sleep(120)
    await touch('touchEnd', { x: pt.x + opts.drag.dx, y: pt.y + opts.drag.dy })
    console.log(`drag ${opts.drag.sel} Δ${opts.drag.dx},${opts.drag.dy}`)
    await sleep(700)          // 等吸附停稳 + 父组件提交
  }

  if (opts.hold) {
    const pt = await centerOf(opts.hold.sel)
    const shotAt = opts.shotAt || Math.round(opts.hold.ms * 0.55)
    await touch('touchStart', pt)
    console.log(`hold ${opts.hold.sel} @ ${Math.round(pt.x)},${Math.round(pt.y)} 按 ${opts.hold.ms}ms`)
    await sleep(shotAt)
    // 按下中途先截一张 —— 录音状态只在"按住"这段时间存在
    const mid = await s.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(out.replace(/\.png$/, '.holding.png'), Buffer.from(mid.data, 'base64'))
    console.log('按下中截图 →', out.replace(/\.png$/, '.holding.png'))
    await sleep(Math.max(0, opts.hold.ms - shotAt))
    await touch('touchEnd', pt)
    console.log('已松手')
  }

  for (const expr of opts.eval) {
    const v = await runJs(expr, '--eval')
    if (v !== undefined && v !== null) console.log('eval →', typeof v === 'object' ? JSON.stringify(v) : v)
  }
  if (opts.eval.length) await sleep(400)

  const { data } = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(`截图 → ${out}`)

  s.close()
  if (!opts.keep) await closeTab(tab.id)
  else console.log('tab 保留：', tab.id)
}

main().catch((e) => { console.error('✖', e.message); process.exit(1) })
