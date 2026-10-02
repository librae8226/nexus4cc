// server.js — Nexus WebSocket tmux 桥接服务
import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createServer } from 'node:http';
import os from 'node:os';
import { exec, spawn, execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, normalize, isAbsolute, basename } from 'path';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, rmdirSync, renameSync, cpSync, rmSync } from 'fs';
import { readdir, stat as statAsync } from 'fs/promises';
import https from 'node:https';
import multer from 'multer';
import { createWalkieRouter } from './walkie.js';

// ── 剥掉 PM2 注入的 IPC / 进程管理变量（必须在 .env 加载之前）─────────────────
// PM2 以 fork 模式拉起 Nexus 时会注入 NODE_CHANNEL_FD=3 / NODE_CHANNEL_SERIALIZATION_MODE
// / pm_id / PM2_* 等。它们会跟着 Nexus 的**子进程**走（node-pty 终端、救援 shell、
// 它创建的交互式 shell）；其中 NODE_CHANNEL_FD 最致命：子进程里没有对应的 fd 3 可连，
// 普通 node 进程启动即 SIGABRT（exit 134，core dumped）。
// 这是「别把 PM2 的家务事传给子进程」的卫生问题，与 tmux 归属无关 —— tmux server 的
// 环境现在由 nexus-tmux.service 显式定义（deploy/systemd/nexus-tmux.service），pane 不再
// 继承 Nexus 的 env，所以这里**不再**需要处理 TMUX/TMUX_PANE/TMUX_SESSION 那组补丁。
// 用前缀匹配而不是写死键名：PM2 升级会加新变量。放在 .env 之前，.env 里显式配置优先。
const PM2_IPC_KEY = (k) =>
  k.startsWith('PM2_') ||
  k.startsWith('NODE_CHANNEL') ||
  k === 'NODE_APP_INSTANCE' || k === 'instance_var' || k === 'pm_id';
for (const key of Object.keys(process.env)) {
  if (PM2_IPC_KEY(key)) delete process.env[key];
}

// 加载 .env 文件（如果存在）
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* .env 不存在时忽略 */ }

// locale 兜底：pm2 拉起本进程时会把 LANG 过滤掉（连带 USER / LOGNAME / SHELL），
// 于是 tmux server 与每个 pane 的 shell 都没有 locale —— pane 里 vi/vim 会以
// encoding=latin1 启动，UTF-8 中文看不见（Claude 不受影响是因为 nexus-run-claude.sh
// 内部自己 export 了 C.UTF-8）。这里补默认值，让它 spawn 的所有子进程都拿到 UTF-8 locale。
// 注：上面那段 .env 加载在前，故 .env 里显式写的 LANG 优先级更高。
process.env.LANG ||= 'C.UTF-8';

// （PM2 注入的 IPC / 进程管理变量已在文件顶部用 PM2_IPC_KEY() 摘掉，见上面说明。）

const __dirname = dirname(fileURLToPath(import.meta.url));

// 持久化数据目录（通过 Docker volume 挂载，重建容器不丢失）
const DATA_DIR = join(__dirname, 'data');
const TOOLBAR_CONFIG_FILE = join(DATA_DIR, 'toolbar-config.json');
const CONFIGS_DIR = join(DATA_DIR, 'configs');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(CONFIGS_DIR)) mkdirSync(CONFIGS_DIR, { recursive: true });

// 自动确保 anthropic.json 存在（无需用户手动创建）
// 优先级：已有文件不覆盖；API_KEY 从环境变量 ANTHROPIC_API_KEY 检测
{
  const anthropicProfile = join(CONFIGS_DIR, 'anthropic.json');
  if (!existsSync(anthropicProfile)) {
    // 检测本地 CC 是否已 login（~/.claude.json 有 oauthAccount）
    let isLoggedIn = false;
    try {
      const claudeJson = JSON.parse(readFileSync(join(process.env.HOME || '~', '.claude.json'), 'utf8'));
      isLoggedIn = !!(claudeJson.oauthAccount?.accountUuid);
    } catch { /* 未登录或文件不存在 */ }

    const apiKey = process.env.ANTHROPIC_API_KEY || '';

    if (isLoggedIn || apiKey) {
      writeFileSync(anthropicProfile, JSON.stringify({
        label: 'Anthropic Claude',
        BASE_URL: '',
        AUTH_TOKEN: '',
        API_KEY: apiKey,
        DEFAULT_MODEL: 'claude-sonnet-4-6',
        THINK_MODEL: 'claude-opus-4-6',
        LONG_CONTEXT_MODEL: 'claude-opus-4-6',
        DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
        API_TIMEOUT_MS: '3000000',
      }, null, 2), 'utf8');
      console.log(`[Nexus] Auto-created anthropic profile (${isLoggedIn ? 'oauth login' : 'API key from env'})`);
    }
  }
}

const app = express();
app.use(express.json());

const {
  JWT_SECRET,
  ACC_PASSWORD_HASH,
  TMUX_SESSION = '~',
  WORKSPACE_ROOT = '/workspace',
  PORT = '3000',
  HOST = '0.0.0.0',
  CLAUDE_PROXY = '',
  CLAUDE_BIN: CLAUDE_BIN_ENV = '',
  GITHUB_REPO = 'librae8226/nexus4cc',
  CORS_ORIGINS = '',
} = process.env;

if (!JWT_SECRET || !ACC_PASSWORD_HASH) {
  console.error('ERROR: JWT_SECRET and ACC_PASSWORD_HASH must be set in environment');
  process.exit(1);
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd} >/dev/null 2>&1`);
    return true;
  } catch {
    return false;
  }
}

const INTERACTIVE_SHELL = commandExists('zsh') ? 'zsh' : 'bash';
const INTERACTIVE_SHELL_CMD = `exec ${INTERACTIVE_SHELL} -i`;

function buildInteractiveShellCmd(prefix = '') {
  return `${prefix}${INTERACTIVE_SHELL_CMD}`;
}

// ── claude CLI 定位 ────────────────────────────────────────────────────────
// claude 装在哪取决于安装方式，写死一个路径必然踩空：
//   官方 install.sh          → ~/.local/bin/claude
//   npm -g（nvm/fnm/volta）  → <node 版本目录>/bin/claude
//   npm -g（系统 node）      → /usr/local/bin/claude
//   Homebrew（macOS）        → /opt/homebrew/bin/claude
// 所以按优先级探测，并允许用 CLAUDE_BIN 显式覆盖。
function resolveClaudeBin() {
  let fromPath = '';
  try {
    fromPath = execSync('command -v claude 2>/dev/null').toString().trim();
  } catch { /* 不在 PATH 上 */ }

  const candidates = [
    CLAUDE_BIN_ENV,
    fromPath,
    join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ].filter(Boolean);

  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* 忽略不可读的候选 */ }
  }
  return '';
}

const CLAUDE_BIN = resolveClaudeBin();
// shellCmd 是交给 tmux 的 shell 字符串，路径可能含空格，统一加引号。
// 探测不到时退回裸 `claude`，交给运行时的 PATH 再试一次，而不是拼出一条必然报错的命令。
const CLAUDE_CMD = CLAUDE_BIN ? `"${CLAUDE_BIN}"` : 'claude';

if (!CLAUDE_BIN) {
  console.warn('[Nexus] 未在常见位置找到 claude CLI —— Claude 会话可能无法启动。');
  console.warn('[Nexus] 请安装 https://docs.claude.com/en/docs/claude-code，或用 CLAUDE_BIN=/path/to/claude 指定。');
}

// ── tmux 会话环境 ──────────────────────────────────────────────────────────
// tmux 新窗口继承 session 级环境。把 claude 所在目录前置进 PATH：
// npm/nvm/homebrew 装的 claude 是个 JS 启动器，shebang 为 `#!/usr/bin/env node`，
// 只有 claude 自己的目录在 PATH 上时才能顺带找到同目录的 node。
function buildLaunchEnv() {
  const proxyVars = {
    ...(process.env.HTTP_PROXY  ? { HTTP_PROXY:  process.env.HTTP_PROXY  } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.ALL_PROXY   ? { ALL_PROXY:   process.env.ALL_PROXY   } : {}),
    ...(process.env.http_proxy  ? { http_proxy:  process.env.http_proxy  } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
    ...(CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY, NEXUS_PROXY: CLAUDE_PROXY } : {}),
  };

  if (CLAUDE_BIN) {
    const dir = dirname(CLAUDE_BIN);
    const current = process.env.PATH || '';
    if (!current.split(':').includes(dir)) {
      proxyVars.PATH = `${dir}:${current}`;
    }
  }

  // 让 nexus-run-claude.sh 复用正在跑 nexus 的这个 node：
  // tmux 会话的 PATH 未必包含 node（非交互 shell 不读 ~/.zshrc 是常见原因）。
  if (process.execPath) {
    proxyVars.NEXUS_NODE_BIN = process.execPath;
  }

  const proxyExports = Object.entries(proxyVars).map(([k, v]) => `export ${k}='${v}'`).join('; ');
  return { proxyVars, proxyPrefix: proxyExports ? `${proxyExports}; ` : '' };
}

// ── tmux server 的归属与就绪判定 ──────────────────────────────────────────────
// server 归 nexus-tmux.service 管（deploy/systemd/nexus-tmux.service）：它负责起 server、
// 建 socket 目录、定义 server 的环境、并在（重）启动后触发快照恢复。
// Nexus 只**消费**：调 tmux 之前先确认 server 在，绝不在 server 缺席时自己 new-session ——
// 那会造出一个不受 systemd 管理、环境随调用者而定的「野生 server」（2026-10-02 事故根因）。
let tmuxState = 'starting'; // starting | ready | broken
function tmuxServerUp() {
  try {
    execFileSync('tmux', ['show-environment', '-g'], { stdio: 'pipe' });
    tmuxState = 'ready';
    return true;
  } catch {
    return false;
  }
}

// ── 救援模式：tmux 不可用时的兜底 ─────────────────────────────────────────────
// 目标（用户要求）：最坏情况下 Nexus 网页必须能打开，且里面能启动一个专职 recovery 的
// agent。判据简单到不可能失败 —— server 不在、或快照里的 session 没恢复回来。
let rescueNotifiedAt = 0;
function notifyRescueOnce(reason) {
  const now = Date.now();
  if (now - rescueNotifiedAt < 30 * 60 * 1000) return; // 30 分钟去重，不刷屏
  rescueNotifiedAt = now;
  const push = '/home/librae/work/wechat-agent/push.mjs';
  if (!existsSync(push)) return;
  try {
    execFileSync('node', [push, `【nexus】进入救援模式：${reason}。打开 Nexus 面板 → 救援终端 → 启动 recovery agent。`], { timeout: 8000, stdio: 'pipe' });
    console.log(`[rescue] 已微信推送：${reason}`);
  } catch (e) { console.warn('[rescue] 微信推送失败（不影响救援）:', e.message); }
}

// ── CORS 白名单（独立 origin 客户端，如 Android APK）──────────────────────
// 浏览器路径永远与 server 同源，从不需要 CORS，所以这里默认是关闭的。
// APK 里 WebView 的 origin 是 http(s)://localhost，与服务器不同源，而且
// Authorization 头本身就会触发 OPTIONS 预检 —— 不放行的话请求根本发不出去。
// 两个必须踩准的点：
//   1) 中间件要注册在 express.static 之前。静态中间件会自己应答 OPTIONS
//      （200 + Allow），但不会带任何 CORS 头，注册晚了预检就永远失败。
//   2) 预检要直接短路返回，不能让请求落到路由或 SPA 兜底 app.get('*') 上。
// CORS_ORIGINS 为空 = 中间件根本不装 = 与改造前逐字节等价，浏览器零影响。
const corsOrigins = CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
if (corsOrigins.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = origin && corsOrigins.includes(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  console.log(`CORS allowed origins: ${corsOrigins.join(', ')}`);
}

// 静态文件：frontend/dist 和 public
app.use(express.static(join(__dirname, 'public')));
app.use(express.static(join(__dirname, 'frontend', 'dist')));

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

// ── 操作审计日志（谁、什么时候、动了什么）────────────────────────────────────
// 动机（2026-10-02 排查实录）：最大的困惑是「这个 session 是谁删的」——面板操作、shell 里
// 直接敲 tmux、系统自己触发混在一起，pm2 日志还全都没有时间戳。于是分两层记账：
//   1) **API 审计**：凡经 Nexus 的变更（登录、建/删项目与频道、改文件、恢复、救援）逐条记
//      actor（IP + 设备类型）+ 目标 + 结果。看得到 actor = 面板/脚本干的。
//   2) **状态对账**：每 60s 对比 tmux 的 session/窗口清单，发现增减就记一条，并标注
//      via=api（10 秒内有对应 API 调用）还是 via=unknown(命令行/外部) —— 后者就是
//      「有人在 shell 里直接动过」的意思。
// 落盘 data/audit.log（JSONL，1MB 单代轮转），同时打到 stdout（带时间戳，补 pm2 日志的缺口）。
const AUDIT_FILE = join(DATA_DIR, 'audit.log')
const AUDIT_MAX_BYTES = 1024 * 1024
const recentApiTouches = new Map() // 目标名 → 最近一次 API 触碰时间

function deviceOf(ua = '') {
  if (/iPhone|iPad|Android|Mobile/i.test(ua)) return '手机'
  if (/curl|python|node|axios|wget|Claude/i.test(ua)) return `脚本(${ua.slice(0, 20)})`
  return ua ? '浏览器' : '未知'
}
// 判「这次变更是不是 Nexus 自己干的」：先看进程内 10 秒内的触碰，再回看审计文件的近况
// （对账是每 60s 一轮，10 秒窗口会把「面板 40 秒前的操作」误判成命令行 —— 2026-10-02 实测踩到，
//  正是「谁删的」这类困惑的来源，所以窗口要放宽到 3 分钟，且以审计文件为准）。
const MUTATING_ACTIONS = new Set(['session-created', 'session-deleted', 'session-renamed', 'channel-created', 'channel-deleted', 'channel-renamed', 'history-cleared'])
function auditRecentTargets(windowMs = 180000) {
  const map = new Map()
  try {
    const lines = readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-300)
    for (const l of lines) {
      let e
      try { e = JSON.parse(l) } catch { continue }
      if (!e.target || !MUTATING_ACTIONS.has(e.action)) continue
      const t = Date.parse(e.ts)
      if (!Number.isNaN(t) && Date.now() - t <= windowMs) map.set(String(e.target), t)
    }
  } catch { /* 还没有审计文件 */ }
  return map
}
function viaOf(name, recent) {
  const key = String(name)
  const inMem = recentApiTouches.get(key)
  if (inMem && Date.now() - inMem < 10000) return 'api'
  if (recent) {
    if (recent.has(key)) return 'api'
    // 频道级动作（target 形如 session:window）同样能解释该 session 的窗口数变化
    for (const t of recent.keys()) if (t.startsWith(`${key}:`)) return 'api'
  }
  return 'unknown(命令行/外部)'
}

function audit(action, req, extra = {}) {
  const ts = new Date().toISOString()
  const entry = { ts, action, ...extra }
  if (req) {
    entry.actor = {
      ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
      device: deviceOf(req.headers['user-agent']),
    }
  }
  if (entry.target) recentApiTouches.set(String(entry.target), Date.now())
  try {
    if (existsSync(AUDIT_FILE) && statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES) renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`)
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n')
  } catch (e) { console.warn('[audit] 写盘失败:', e.message) }
  const bits = [new Date().toTimeString().slice(0, 8), action] // 本地时间；文件里仍是 ISO
  if (entry.target) bits.push(`target=${entry.target}`)
  if (entry.via) bits.push(`via=${entry.via}`)
  if (entry.result) bits.push(entry.result)
  if (entry.actor?.device) bits.push(`by=${entry.actor.device}`)
  console.log(`[audit] ${bits.join(' ')}`)
}

// 状态对账：面板操作会先留下 API 审计；对不上号的变更就是命令行/外部进程干的。
let lastInventory = null
function readInventory() {
  try {
    return new Map(
      execFileSync('tmux', ['list-sessions', '-F', '#{session_name} #{session_windows}'], { encoding: 'utf8', stdio: 'pipe' })
        .trim().split('\n').filter(Boolean)
        .map((l) => [l.split(' ')[0], Number(l.split(' ')[1]) || 0])
    )
  } catch { return new Map() }
}
function reconcileInventory(note) {
  const cur = readInventory()
  const recent = auditRecentTargets()
  if (lastInventory) {
    for (const [name, wins] of cur) {
      if (!lastInventory.has(name)) audit('session-added', null, { target: name, windows: wins, via: viaOf(name, recent), note })
      else if (lastInventory.get(name) !== wins) audit('session-windows-changed', null, { target: name, from: lastInventory.get(name), to: wins, via: viaOf(name, recent), note })
    }
    for (const [name, wins] of lastInventory) {
      if (!cur.has(name)) audit('session-removed', null, { target: name, windows: wins, via: viaOf(name, recent), note })
    }
  }
  lastInventory = cur
  return cur
}
setInterval(() => reconcileInventory('periodic'), 60000);

// GET /api/audit — 读最近 N 条审计（面板「操作日志」用，也是我排查时的第一现场）
app.get('/api/audit', authMiddleware, (req, res) => {
  const n = Math.min(Number(req.query.lines) || 200, 1000)
  let lines = []
  try {
    lines = readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l) } catch { return { ts: '', action: 'raw', detail: l } } })
  } catch { /* 还没有日志 */ }
  res.json({ lines })
})

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    const ok = await bcrypt.compare(password, ACC_PASSWORD_HASH);
    if (!ok) { audit('login-fail', req, { result: 'unauthorized' }); return res.status(401).json({ error: 'unauthorized' }); }
    const token = jwt.sign({}, JWT_SECRET, { expiresIn: '30d' });
    audit('login-ok', req, { result: 'ok' });
    res.json({ token });
  } catch (err) {
    audit('login-error', req, { result: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/windows — F-19: 项目-窗口两级结构
// body: { rel_path?, shell_type?, profile? }
// - 提供 rel_path: 设置 NEXUS_CWD 并在此目录创建窗口（新项目）
// - 不提供 rel_path: 读取 NEXUS_CWD 并在此目录创建窗口（新窗口）
app.post('/api/windows', authMiddleware, (req, res) => {
  const { rel_path, shell_type = 'claude', profile } = req.body || {};
  const tmuxSession = req.query.session || TMUX_SESSION;

  let cwd;
  if (rel_path) {
    // 新项目：设置 NEXUS_CWD
    cwd = rel_path.startsWith('/') ? rel_path : `${WORKSPACE_ROOT}/${rel_path}`;
    try {
      execSync(`tmux set-environment -t ${tmuxSession} NEXUS_CWD "${cwd}"`);
    } catch (err) {
      return res.status(500).json({ error: 'failed to set NEXUS_CWD: ' + err.message });
    }
  } else {
    // 新窗口：读取 NEXUS_CWD
    try {
      const envOutput = execSync(`tmux show-environment -t ${tmuxSession} NEXUS_CWD 2>/dev/null`).toString().trim();
      const match = envOutput.match(/^NEXUS_CWD=(.+)$/);
      cwd = match ? match[1] : WORKSPACE_ROOT;
    } catch {
      cwd = WORKSPACE_ROOT;
    }
  }

  // 窗口名称基于目录
  const name = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'window';

  // 构建 shell 命令
  const { proxyVars, proxyPrefix } = buildLaunchEnv();

  let shellCmd;
  if (shell_type === 'bash') {
    shellCmd = buildInteractiveShellCmd(proxyPrefix);
  } else {
    if (profile) {
      const runScript = join(__dirname, 'nexus-run-claude.sh');
      shellCmd = `${proxyPrefix}bash "${runScript}" ${profile} ${cwd}`;
    } else {
      shellCmd = `${proxyPrefix}${CLAUDE_CMD} --dangerously-skip-permissions; ${INTERACTIVE_SHELL_CMD}`;
    }
  }

  // 确保 tmux session 存在
  try {
    if (!tmuxServerUp()) {
      tmuxState = 'broken';
      return res.status(503).json({ error: 'tmux server 未就绪（归 nexus-tmux.service 管理），请用救援终端或 POST /api/rescue/run', rescue: true });
    }
    execSync(`tmux has-session -t ${tmuxSession} 2>/dev/null || tmux new-session -d -s ${tmuxSession} -n shell "${INTERACTIVE_SHELL}"`);
  } catch {}

  // 将代理变量设置到 tmux session 环境
  for (const [key, value] of Object.entries(proxyVars)) {
    try {
      execSync(`tmux set-environment -t ${tmuxSession} ${key} "${value}" 2>/dev/null`);
    } catch {}
  }

  const cmd = `tmux new-window -t ${tmuxSession} -c "${cwd}" -n "${name}" "${shellCmd}"`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    audit('channel-created', req, { target: tmuxSession, channel: name, cwd, profile: profile || null })
    res.json({ name, cwd, shell_type, profile: profile || null, session: tmuxSession });
  });
});

// POST /api/sessions — 在 tmux 中创建新 window
// body: { rel_path, shell_type?, profile?, session? }
//   shell_type: 'claude' | 'bash' (default: 'claude')
//   当 shell_type='claude' 时，profile 可选，使用 nexus-run-claude.sh 启动
//   当 shell_type='bash' 时，启动本地 shell（优先 zsh，不存在时回退 bash）
app.post('/api/sessions', authMiddleware, (req, res) => {
  const { rel_path, shell_type = 'claude', profile, session } = req.body || {};
  const tmuxSession = session || TMUX_SESSION;
  if (!rel_path) return res.status(400).json({ error: 'rel_path required' });
  const cwd = rel_path.startsWith('/') ? rel_path : `${WORKSPACE_ROOT}/${rel_path}`;
  const name = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'session';

  // 收集代理变量（宿主机环境 + CLAUDE_PROXY 覆盖）
  const { proxyVars, proxyPrefix } = buildLaunchEnv();

  let shellCmd;
  if (shell_type === 'bash') {
    shellCmd = buildInteractiveShellCmd(proxyPrefix);
  } else {
    if (profile) {
      const runScript = join(__dirname, 'nexus-run-claude.sh');
      shellCmd = `${proxyPrefix}bash "${runScript}" ${profile} ${cwd}`;
    } else {
      shellCmd = `${proxyPrefix}${CLAUDE_CMD} --dangerously-skip-permissions; ${INTERACTIVE_SHELL_CMD}`;
    }
  }

  // 确保 tmux session 存在
  try {
    if (!tmuxServerUp()) {
      tmuxState = 'broken';
      return res.status(503).json({ error: 'tmux server 未就绪（归 nexus-tmux.service 管理），请用救援终端或 POST /api/rescue/run', rescue: true });
    }
    execSync(`tmux has-session -t ${tmuxSession} 2>/dev/null || tmux new-session -d -s ${tmuxSession} -n shell "${INTERACTIVE_SHELL}"`);
  } catch {}

  // 将代理变量设置到 tmux session 环境，新窗口才能继承
  for (const [key, value] of Object.entries(proxyVars)) {
    try {
      execSync(`tmux set-environment -t ${tmuxSession} ${key} "${value}" 2>/dev/null`);
    } catch {}
  }

  const cmd = `tmux new-window -t ${tmuxSession} -c "${cwd}" -n "${name}" "${shellCmd}"`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    audit('channel-created', req, { target: tmuxSession, channel: name, cwd, profile: profile || null })
    res.json({ name, cwd, shell_type, profile: profile || null, session: tmuxSession });
  });
});

// GET /api/configs — 列出所有 claude 配置 profile
app.get('/api/configs', authMiddleware, (req, res) => {
  try {
    const files = readdirSync(CONFIGS_DIR, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.json'))
      .map(f => ({
        name: f.name,
        mtime: statSync(join(CONFIGS_DIR, f.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.name);
    const configs = files.map(f => {
      const id = f.replace('.json', '');
      try {
        const data = JSON.parse(readFileSync(join(CONFIGS_DIR, f), 'utf8'));
        return { id, label: data.label || id, ...data };
      } catch {
        return { id, label: id };
      }
    });
    res.json(configs);
  } catch {
    res.json([]);
  }
});

// POST /api/configs/:id — 创建或更新配置 profile
app.post('/api/configs/:id', authMiddleware, (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    writeFileSync(join(CONFIGS_DIR, `${id}.json`), JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/configs/:id — 删除配置 profile
app.delete('/api/configs/:id', authMiddleware, (req, res) => {
  const file = join(CONFIGS_DIR, `${req.params.id}.json`);
  try {
    if (existsSync(file)) unlinkSync(file);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/toolbar-config — 读取工具栏配置
app.get('/api/toolbar-config', authMiddleware, (req, res) => {
  try {
    if (!existsSync(TOOLBAR_CONFIG_FILE)) return res.json(null);
    const data = readFileSync(TOOLBAR_CONFIG_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch {
    res.json(null);
  }
});

// POST /api/toolbar-config — 保存工具栏配置
app.post('/api/toolbar-config', authMiddleware, (req, res) => {
  try {
    writeFileSync(TOOLBAR_CONFIG_FILE, JSON.stringify(req.body), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/version — 当前版本号及工作区状态
app.get('/api/version', authMiddleware, (req, res) => {
  try {
    const current = execSync('git describe --tags --abbrev=0', { cwd: __dirname }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: __dirname }).toString().trim();
    res.json({ current, clean: dirty === '' });
  } catch {
    res.json({ current: 'unknown', clean: true });
  }
});

// GET /api/version/latest — 代理 GitHub Tags API 获取最新版本（兼容只有 tag 没有 Release 的 repo）
app.get('/api/version/latest', authMiddleware, (req, res) => {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO}/tags`,
    headers: { 'User-Agent': 'nexus-update-check' },
  };
  https.get(options, (ghRes) => {
    let data = '';
    ghRes.on('data', chunk => { data += chunk; });
    ghRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (!Array.isArray(json) || json.length === 0) return res.status(502).json({ error: 'no tags found' });
        const latest = json[0].name;
        res.json({ latest, url: `https://github.com/${GITHUB_REPO}/releases/tag/${latest}` });
      } catch {
        res.status(502).json({ error: 'invalid response from GitHub' });
      }
    });
  }).on('error', () => {
    res.status(502).json({ error: 'cannot reach GitHub' });
  });
});

app.get('/api/browse', authMiddleware, (req, res) => {
  try {
    let p = req.query.path || WORKSPACE_ROOT
    if (p === '~') p = WORKSPACE_ROOT
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    const entries = readdirSync(p, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = dirname(p) !== p ? dirname(p) : null
    res.json({ path: p, parent, dirs })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/workspace/files — 浏览文件系统（支持文件和目录，任意路径）
app.get('/api/workspace/files', authMiddleware, async (req, res) => {
  try {
    let p = req.query.path || WORKSPACE_ROOT
    if (p === '~') p = WORKSPACE_ROOT
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true'
    const dirents = await readdir(p, { withFileTypes: true })
    const visible = showHidden ? dirents : dirents.filter(e => !e.name.startsWith('.'))
    const entries = await Promise.all(visible.map(async e => {
      const fullPath = join(p, e.name)
      const st = await statAsync(fullPath)
      return {
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isFile() ? st.size : undefined,
        mtime: st.mtimeMs,
      }
    }))
    res.json({ path: p, entries })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 静态文件服务：工作目录文件直接访问（/workspace/相对路径）
// 支持 header 或 query string 传递 token（浏览器直接打开时用 query string）
// 支持通过 ?path=/absolute/path 访问任意路径（仍然限制在 workspaceRoot 内）
app.use('/workspace', (req, res, next) => {
  // 尝试从 query string 获取 token
  const token = req.query.token
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET)
      return next()
    } catch {
      return res.status(401).send('unauthorized')
    }
  }
  // 否则使用 header auth
  return authMiddleware(req, res, next)
}, (req, res) => {
  try {
    let fullPath
    // 如果提供了 path 参数，使用它（绝对路径）
    if (req.query.path) {
      fullPath = normalize(decodeURIComponent(req.query.path))
    } else {
      // 否则使用相对路径（基于 WORKSPACE_ROOT）
      let relPath = decodeURIComponent(req.path)
      relPath = normalize(relPath).replace(/^(\.\.(\/|\|$))+/, '')
      fullPath = join(WORKSPACE_ROOT, relPath)
    }
    // 安全检查：防止路径遍历攻击（规范化后检查是否包含 ..）
    if (fullPath.includes('..')) {
      return res.status(403).send('access denied: invalid path')
    }
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return res.status(404).send('not found')
    }
    if (req.query.dl === '1') {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(fullPath))}`)
    }
    res.sendFile(fullPath)
  } catch (err) {
    res.status(500).send(err.message)
  }
})

// POST /api/workspace/mkdir — 创建文件夹
app.post('/api/workspace/mkdir', authMiddleware, (req, res) => {
  try {
    let { path: targetPath, name } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    targetPath = normalize(targetPath)
    const dirPath = join(targetPath, name)
    if (dirPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (existsSync(dirPath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    mkdirSync(dirPath, { recursive: true })
    res.json({ ok: true, path: dirPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/files — 创建新文件
app.post('/api/workspace/files', authMiddleware, (req, res) => {
  try {
    let { path: targetPath, name, content = '' } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    targetPath = normalize(targetPath)
    const filePath = join(targetPath, name)
    if (filePath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (existsSync(filePath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    writeFileSync(filePath, content, 'utf8')
    res.json({ ok: true, path: filePath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ---- Text file detection utilities ----
// Known binary (non-text) extensions — fast pre-filter to avoid reading large binaries
const BINARY_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'tif', 'heic', 'heif', 'avif',
  // Video / Audio
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'wma', 'm4a', 'opus',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst', 'lz4',
  // Binaries / executables
  'exe', 'dll', 'so', 'dylib', 'o', 'a', 'wasm', 'bin', 'dat',
  // Documents (binary formats)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'epub',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Other binary
  'class', 'jar', 'war', 'pyc', 'pyo', 'elc', 'zwc',
  'db', 'sqlite', 'sqlite3',
  'psd', 'ai', 'sketch',
  'iso', 'dmg', 'vhd', 'qcow2',
  'pdb', 'obj', 'lib',
  'dex', 'apk', 'ipa',
])

function isKnownBinaryExt(filePath) {
  const name = basename(filePath).toLowerCase()
  const dotIdx = name.lastIndexOf('.')
  if (dotIdx <= 0) return false
  const ext = name.slice(dotIdx + 1)
  return BINARY_EXTENSIONS.has(ext)
}

function isBinaryContent(buffer) {
  // Check first 8192 bytes for null bytes — reliable binary indicator
  const maxCheck = Math.min(buffer.length, 8192)
  for (let i = 0; i < maxCheck; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

const MAX_EDITOR_FILE_SIZE = 5 * 1024 * 1024 // 5MB hard limit for text editor

// GET /api/workspace/file — 读取文件内容（自动检测二进制，仅文本文件可读）
app.get('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    let p = req.query.path || ''
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    if (p.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(p) || !statSync(p).isFile()) {
      return res.status(404).json({ error: 'not found' })
    }
    // Fast pre-filter: known binary extension → reject immediately
    if (isKnownBinaryExt(p)) {
      return res.status(415).json({ error: 'binary file, cannot open in editor' })
    }
    // Reject files that are too large for the editor
    const st = statSync(p)
    if (st.size > MAX_EDITOR_FILE_SIZE) {
      return res.status(413).json({ error: 'file too large for editor', size: st.size, max: MAX_EDITOR_FILE_SIZE })
    }
    // Read as buffer first to detect binary content via null bytes
    const buf = readFileSync(p)
    if (isBinaryContent(buf)) {
      return res.status(415).json({ error: 'binary file detected' })
    }
    const content = buf.toString('utf8')
    res.json({ path: p, content })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/workspace/file — 保存文件内容（自动检测二进制，仅文本文件可写）
app.put('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    let { path: filePath, content = '' } = req.body
    if (!filePath) return res.status(400).json({ error: 'path required' })
    if (!isAbsolute(filePath)) filePath = join(WORKSPACE_ROOT, filePath)
    filePath = normalize(filePath)
    if (filePath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    // Fast pre-filter: known binary extension → reject
    if (isKnownBinaryExt(filePath)) {
      return res.status(415).json({ error: 'binary file, cannot save via editor' })
    }
    writeFileSync(filePath, content, 'utf8')
    res.json({ ok: true, path: filePath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/workspace/entry — 删除文件或目录
app.delete('/api/workspace/entry', authMiddleware, (req, res) => {
  try {
    let p = req.body?.path || req.query?.path || ''
    if (!p) return res.status(400).json({ error: 'path required' })
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    if (p.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(p)) {
      return res.status(404).json({ error: 'not found' })
    }
    rmSync(p, { recursive: true, force: true })
    audit('fs-deleted', req, { target: p })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/rename — 重命名文件或目录
app.post('/api/workspace/rename', authMiddleware, (req, res) => {
  try {
    let { path: srcPath, newName } = req.body || {}
    if (!srcPath || !newName) return res.status(400).json({ error: 'path and newName required' })
    if (!isAbsolute(srcPath)) srcPath = join(WORKSPACE_ROOT, srcPath)
    srcPath = normalize(srcPath)
    if (srcPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(srcPath)) {
      return res.status(404).json({ error: 'not found' })
    }
    const destPath = normalize(join(dirname(srcPath), newName))
    if (destPath.includes('..')) {
      return res.status(403).json({ error: 'invalid newName' })
    }
    if (existsSync(destPath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    renameSync(srcPath, destPath)
    res.json({ ok: true, path: destPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/copy — 复制文件或目录
app.post('/api/workspace/copy', authMiddleware, (req, res) => {
  try {
    let { sourcePath, targetPath } = req.body || {}
    if (!sourcePath || !targetPath) return res.status(400).json({ error: 'sourcePath and targetPath required' })
    if (!isAbsolute(sourcePath)) sourcePath = join(WORKSPACE_ROOT, sourcePath)
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    sourcePath = normalize(sourcePath)
    targetPath = normalize(targetPath)
    if (sourcePath.includes('..') || targetPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(sourcePath)) {
      return res.status(404).json({ error: 'source not found' })
    }
    if (existsSync(targetPath)) {
      return res.status(409).json({ error: 'target already exists' })
    }
    cpSync(sourcePath, targetPath, { recursive: true })
    res.json({ ok: true, path: targetPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/move — 移动文件或目录
app.post('/api/workspace/move', authMiddleware, (req, res) => {
  try {
    let { sourcePath, targetPath } = req.body || {}
    if (!sourcePath || !targetPath) return res.status(400).json({ error: 'sourcePath and targetPath required' })
    if (!isAbsolute(sourcePath)) sourcePath = join(WORKSPACE_ROOT, sourcePath)
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    sourcePath = normalize(sourcePath)
    targetPath = normalize(targetPath)
    if (sourcePath.includes('..') || targetPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(sourcePath)) {
      return res.status(404).json({ error: 'source not found' })
    }
    if (existsSync(targetPath)) {
      return res.status(409).json({ error: 'target already exists' })
    }
    try {
      renameSync(sourcePath, targetPath)
    } catch (err) {
      if (err.code === 'EXDEV') {
        cpSync(sourcePath, targetPath, { recursive: true })
        rmSync(sourcePath, { recursive: true, force: true })
      } else {
        throw err
      }
    }
    res.json({ ok: true, path: targetPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/upload — 上传文件到指定 session 的 cwd（F-14）
// body: multipart/form-data, fields: file, session_name (optional)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // 找到目标 session 的 cwd，否则存 WORKSPACE_ROOT
      let cwd = WORKSPACE_ROOT
      try {
        const sessionName = req.body?.session_name || ''
        const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
        for (const line of windows) {
          const parts = line.split(':')
          const name = parts[1]
          const path = parts.slice(2).join(':')
          if (sessionName && name === sessionName) { cwd = path; break }
          // 如果没指定 session，用 active window
          if (!sessionName) {
            const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
            for (const al of activeLines) {
              const ap = al.split(':')
              if (ap[ap.length - 1]?.trim() === '1') { cwd = ap.slice(2, ap.length - 1).join(':'); break }
            }
            break
          }
        }
      } catch {}
      if (!existsSync(cwd)) cwd = WORKSPACE_ROOT
      cb(null, cwd)
    },
    filename: (req, file, cb) => {
      // 保留原始文件名，避免冲突加时间戳前缀
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, safe)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
})

app.post('/api/upload', authMiddleware, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })
    const filePath = req.file.path
    res.json({ ok: true, path: filePath, filename: req.file.filename, size: req.file.size })
  })
})

// ---- F-21: 文件上传 API（上传到当前 workspace 的 data/uploads/）----

// 读取指定 session 的 uploads 目录
// 优先级：NEXUS_CWD 环境变量 > tmux pane_current_path > WORKSPACE_ROOT
function getWorkspaceUploadsDir(session = TMUX_SESSION) {
  let cwd
  try {
    const out = execSync(`tmux show-environment -t ${session} NEXUS_CWD 2>/dev/null`).toString().trim()
    const m = out.match(/^NEXUS_CWD=(.+)$/)
    if (m) cwd = m[1]
  } catch {}
  if (!cwd) {
    try {
      cwd = execSync(`tmux display-message -t ${session} -p '#{pane_current_path}' 2>/dev/null`).toString().trim()
    } catch {}
  }
  if (!cwd) cwd = WORKSPACE_ROOT
  return join(cwd, 'data', 'uploads')
}

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
})

// POST /api/files/upload — 上传文件到当前 workspace/data/uploads/日期/
// Query: overwrite=1 强制覆盖已存在的文件
app.post('/api/files/upload', authMiddleware, (req, res, next) => {
  fileUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })

    const dateDir = new Date().toISOString().slice(0, 10)
    const uploadsDir = getWorkspaceUploadsDir(req.query.session || TMUX_SESSION)
    const uploadDir = join(uploadsDir, dateDir)
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

    // 使用前端传递的原始文件名（避免 multer 解析编码问题）
    const originalName = req.body.originalName || req.file.originalname
    // 清理文件名：只保留合法字符，中文保留
    const safe = originalName.replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')
    const filePath = join(uploadDir, safe)
    const overwrite = req.query.overwrite === '1'

    // 检查文件是否已存在
    if (!overwrite && existsSync(filePath)) {
      return res.status(409).json({
        error: 'file exists',
        filename: safe,
        message: `文件 "${safe}" 已存在`
      })
    }

    // 写入文件
    try {
      writeFileSync(filePath, req.file.buffer)
      const url = `/api/files/content?path=${encodeURIComponent(filePath)}`
      const responseData = {
        ok: true,
        filename: safe,
        url,
        fullPath: filePath,
        size: req.file.size,
        originalName: originalName
      }
      console.log('[Upload]', safe, '→', filePath)
      res.json(responseData)
    } catch (writeErr) {
      res.status(500).json({ error: writeErr.message })
    }
  })
})

// GET /api/files/content?path=... — 访问/下载已上传的文件（路径自描述，无状态）
app.get('/api/files/content', authMiddleware, (req, res) => {
  const filePath = req.query.path
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' })
  const normalized = normalize(filePath)
  const uploadsDir = getWorkspaceUploadsDir()
  const allowed = normalized.startsWith(WORKSPACE_ROOT) || normalized.startsWith(uploadsDir)
  if (!allowed) return res.status(403).json({ error: 'access denied' })
  if (!existsSync(normalized)) return res.status(404).json({ error: 'file not found' })
  res.sendFile(normalized)
})

// GET /api/files — 列出当前 workspace 上传的文件（按日期分组）
app.get('/api/files', authMiddleware, (req, res) => {
  try {
    const uploadsDir = getWorkspaceUploadsDir(req.query.session || TMUX_SESSION)
    const result = []
    if (!existsSync(uploadsDir)) return res.json(result)

    const dateDirs = readdirSync(uploadsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a)) // 降序，最新的在前

    for (const dateDir of dateDirs) {
      const dirPath = join(uploadsDir, dateDir)
      const files = readdirSync(dirPath, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => {
          const fullPath = join(dirPath, e.name)
          const stat = statSync(fullPath)
          return {
            name: e.name,
            url: `/api/files/content?path=${encodeURIComponent(fullPath)}`,
            fullPath,
            size: stat.size,
            created: stat.mtimeMs,
          }
        })
        .sort((a, b) => b.created - a.created)
      if (files.length > 0) {
        result.push({ date: dateDir, files })
      }
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/files/all — 删除当前 workspace 所有上传的文件
app.delete('/api/files/all', authMiddleware, (req, res) => {
  try {
    const uploadsDir = getWorkspaceUploadsDir(req.query.session || TMUX_SESSION)
    if (!existsSync(uploadsDir)) return res.json({ ok: true, deletedCount: 0 })
    const dateDirs = readdirSync(uploadsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
    let deletedCount = 0
    for (const dateDir of dateDirs) {
      const dirPath = join(uploadsDir, dateDir.name)
      const files = readdirSync(dirPath, { withFileTypes: true })
        .filter(e => e.isFile())
      for (const file of files) {
        const filePath = join(dirPath, file.name)
        try {
          unlinkSync(filePath)
          audit('fs-deleted', req, { target: filePath })
          deletedCount++
        } catch {}
      }
      // 尝试删除空目录
      try {
        rmdirSync(dirPath)
      } catch {}
    }
    res.json({ ok: true, deletedCount })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/files/content?path=... — 删除指定文件（路径自描述）
app.delete('/api/files/content', authMiddleware, (req, res) => {
  const filePath = req.query.path
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' })
  const normalized = normalize(filePath)
  if (!normalized.startsWith(WORKSPACE_ROOT)) return res.status(403).json({ error: 'access denied' })
  try {
    if (existsSync(normalized)) {
      unlinkSync(normalized)
      audit('fs-deleted', req, { target: normalized })
      res.json({ ok: true })
    } else {
      res.status(404).json({ error: 'file not found' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/sessions/:id/rename — 重命名窗口
app.post('/api/sessions/:id/rename', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  const { name } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  // window 名允许 Unicode（中日韩等），仅过滤控制字符和 tmux target separator ':'
  // 之前的 /[^a-zA-Z0-9._-]/→'-' 会把中文全部变成 '-'，导致"我的频道" → "----"
  const safeName = String(name).replace(/[\r\n\t\0:]/g, '').trim().slice(0, 50)
  if (!safeName) return res.status(400).json({ error: 'name required' })
  try {
    execFileSync('tmux', ['rename-window', '-t', `${session}:${index}`, '--', safeName], { stdio: 'pipe' })
    audit('channel-renamed', req, { target: `${session}:${index}`, name: safeName })
    res.json({ ok: true, name: safeName })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/sessions/:id/history — 清除窗口的 tmux 回滚历史
// 只清 scrollback 缓冲区：可见屏幕不变，pane 内进程（claude 等）不受影响。
app.delete('/api/sessions/:id/history', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  try {
    execFileSync('tmux', ['clear-history', '-t', `${session}:${index}`], { stdio: 'pipe' })
    audit('history-cleared', req, { target: `${session}:${index}` })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/sessions/:id/output — 获取窗口最后输出（F-15 状态卡片）
app.get('/api/sessions/:id/output', authMiddleware, (req, res) => {
  const windowIndex = parseInt(req.params.id, 10);
  const session = req.query.session || TMUX_SESSION;
  const entry = ptyMap.get(ptyKey(session, windowIndex));
  if (!entry) return res.json({ connected: false, output: '', clients: 0 });
  res.json({
    connected: true,
    output: entry.lastOutput.slice(-2000), // 最后 2KB
    clients: entry.clients.size,
    idleMs: Date.now() - entry.lastActivity,
  });
});

// GET /api/sessions/:id/scrollback — fetch tmux scrollback history (works in alternate screen too)
app.get('/api/sessions/:id/scrollback', authMiddleware, (req, res) => {
  const windowIndex = parseInt(req.params.id, 10)
  const session = req.query.session || TMUX_SESSION
  const lines = Math.min(parseInt(req.query.lines || '3000', 10), 10000)
  exec(`tmux capture-pane -e -p -S -${lines} -t ${session}:${windowIndex} 2>/dev/null`, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message })
    // trim trailing spaces tmux pads to pane width
    const content = stdout.split('\n').map(l => l.trimEnd()).join('\n')
    res.json({ content })
  })
})

// GET /api/config — 服务端配置信息（供前端初始化用）
app.get('/api/config', authMiddleware, (req, res) => {
  res.json({ tmuxSession: TMUX_SESSION, workspaceRoot: WORKSPACE_ROOT })
})

// GET /api/tmux-sessions — 列出所有 tmux session（F-18）
app.get('/api/tmux-sessions', authMiddleware, (req, res) => {
  exec('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"', (err, stdout) => {
    if (err) return res.json([{ name: TMUX_SESSION, windows: 0, attached: false }])
    const sessions = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows, attached] = line.split('|')
      return { name, windows: Number(windows), attached: Number(attached) > 0 }
    })
    res.json(sessions)
  })
})

// POST /api/launch-iterm — 在本机启动 iTerm2 并用 tmux -CC 集成模式接管指定 session
// 仅在 server 与 iTerm2 同机时有意义（macOS only）。
app.post('/api/launch-iterm', authMiddleware, (req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(400).json({ error: 'launch-iterm requires macOS host' })
  }
  const session = req.body?.session
  if (!session || typeof session !== 'string') {
    return res.status(400).json({ error: 'session required' })
  }
  if (/["'\\`$]/.test(session)) {
    return res.status(400).json({ error: 'invalid session name' })
  }
  try {
    execSync(`tmux has-session -t '${session}' 2>/dev/null`)
  } catch {
    return res.status(404).json({ error: 'session not found' })
  }
  const appleScript = `on run argv
  set sess to item 1 of argv
  tell application "iTerm2"
    activate
    set newWin to (create window with default profile)
    tell current session of newWin
      write text "tmux -CC attach -t \\"" & sess & "\\""
    end tell
  end tell
end run`
  try {
    const proc = spawn('osascript', ['-', session], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    proc.stdin.write(appleScript)
    proc.stdin.end()
    proc.unref()
    return res.json({ ok: true, session })
  } catch (e) {
    return res.status(500).json({ error: String(e) })
  }
})

// ========== F-20: Project-Channel API ==========
// Project = tmux session, Channel = tmux window (within a session)

// GET /api/projects — 列出所有 Projects（tmux sessions）
app.get('/api/projects', authMiddleware, (req, res) => {
  exec('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"', (err, stdout) => {
    if (err) return res.json([])
    const lines = stdout.trim().split('\n').filter(Boolean)
    const projects = lines.map(line => {
      const [name, windows, attached] = line.split('|')
      // 尝试读取 NEXUS_CWD
      let path = ''
      try {
        const envOutput = execSync(`tmux show-environment -t ${name} NEXUS_CWD 2>/dev/null`).toString().trim()
        const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
        if (match) path = match[1]
      } catch {}
      // 没有 NEXUS_CWD，尝试取第一个 window 的 pane_current_path
      if (!path && windows !== '0') {
        try {
          const cwdOutput = execSync(`tmux list-windows -t ${name} -F '#{pane_current_path}' 2>/dev/null | head -1`).toString().trim()
          if (cwdOutput) path = cwdOutput
        } catch {}
      }
      return {
        name,
        path: path || WORKSPACE_ROOT,
        active: name === TMUX_SESSION,
        channelCount: Number(windows) || 0
      }
    })
    projects.reverse()
    res.json(projects)
  })
})

// GET /api/session-cwd — 获取指定 session 的 NEXUS_CWD
app.get('/api/session-cwd', authMiddleware, (req, res) => {
  const session = req.query.session || TMUX_SESSION
  let cwd = WORKSPACE_ROOT

  // 1. 尝试读取 NEXUS_CWD（外部启动的 session 可能没有，会抛异常）
  try {
    const envOutput = execSync(`tmux show-environment -t ${session} NEXUS_CWD 2>/dev/null`).toString().trim()
    const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
    if (match) cwd = match[1]
  } catch { /* NEXUS_CWD 未设置 */ }

  // 2. 若 NEXUS_CWD 未设置，回退到 pane_current_path
  if (cwd === WORKSPACE_ROOT) {
    try {
      const panePath = execSync(`tmux display-message -t ${session} -p '#{pane_current_path}' 2>/dev/null`).toString().trim()
      if (panePath) cwd = panePath
    } catch { /* fallback to WORKSPACE_ROOT */ }
  }

  const relative = cwd.startsWith(WORKSPACE_ROOT) ? cwd.slice(WORKSPACE_ROOT.length).replace(/^\/+/, '') : ''
  res.json({ cwd, relative })
})

// ── 会话恢复（Chrome-style restore）+ 救援 ──
let restoreInFlight = false
let rescueInFlight = false
const RESURRECT_DIR = join(process.env.HOME || '', '.tmux', 'resurrect')

/** 返回最新一份「含 nexus-run-claude 频道」的快照；无则 null。与 nexus-restore-tmux.sh 选择器同规则。 */
function findRestoreSnapshot() {
  let files = []
  try { files = readdirSync(RESURRECT_DIR).filter((f) => /^tmux_resurrect_.*\.txt$/.test(f)) } catch { return null }
  if (!files.length) return null
  files.sort((a, b) => statSync(join(RESURRECT_DIR, b)).mtimeMs - statSync(join(RESURRECT_DIR, a)).mtimeMs)
  for (const f of files) {
    let claude = 0
    try {
      for (const line of readFileSync(join(RESURRECT_DIR, f), 'utf8').split('\n')) {
        if (!line.startsWith('pane\t')) continue
        const cols = line.split('\t')
        if (cols[10] && cols[10].includes('nexus-run-claude.sh')) claude++
      }
    } catch { continue }
    if (claude >= 1) {
      const st = statSync(join(RESURRECT_DIR, f))
      return { file: f, time: new Date(st.mtime).toISOString(), claudeChannels: claude }
    }
  }
  return null
}

// 快照里还有多少 session 不在当前 tmux 上（>0 = 有东西可恢复）。
// 这是「可恢复」的唯一判据：事实就是「快照里有、线上没有」，与谁触发无关 ——
// 不再依赖「全新服务器」这类启发式标记。
function missingSessions() {
  const snap = findRestoreSnapshot()
  if (!snap) return { snapshot: null, missing: 0, list: [], missingChannels: 0, channelsList: [] }
  const sessions = new Set()
  const snapWins = new Map() // session -> Set(窗口名)
  try {
    const txt = readFileSync(join(RESURRECT_DIR, snap.file), 'utf8')
    for (const line of txt.split('\n')) {
      if (!line.startsWith('window\t')) continue
      const cols = line.split('\t')
      const sess = cols[1]
      const name = String(cols[3] || '').replace(/^[:+-]/, '')
      if (!sess) continue
      sessions.add(sess)
      if (!snapWins.has(sess)) snapWins.set(sess, new Set())
      if (name) snapWins.get(sess).add(name)
    }
  } catch { return { snapshot: snap, missing: 0, list: [], missingChannels: 0, channelsList: [] } }
  const list = [...sessions].filter((s) => {
    try { execFileSync('tmux', ['has-session', '-t', s], { stdio: 'pipe' }); return false } catch { return true }
  })
  // 频道级：session 在、但快照里的窗口名不在线上 —— 就是 2026-10-02 home-librae 那种「半残」状态
  // （只按 session 判会漏掉它，面板上也看不见）。改名会误报一次，可接受。
  const channelsList = []
  for (const [sess, names] of snapWins) {
    if (list.includes(sess)) continue // 整个 session 都缺，已计入 list
    let live = new Set()
    try {
      live = new Set(execFileSync('tmux', ['list-windows', '-t', sess, '-F', '#{window_name}'], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').filter(Boolean))
    } catch { continue }
    for (const n of names) if (!live.has(n)) channelsList.push(`${sess}:${n}`)
  }
  return { snapshot: snap, missing: list.length, list, missingChannels: channelsList.length, channelsList }
}

// GET /api/restore/status — 前端决定是否亮「恢复」入口
app.get('/api/restore/status', authMiddleware, (req, res) => {
  const { snapshot, missing, missingChannels } = missingSessions()
  let projects = 0
  let channels = 0
  try { projects = Number(execSync('tmux list-sessions 2>/dev/null | wc -l').toString().trim()) || 0 } catch {}
  try { channels = Number(execSync('tmux list-windows -a 2>/dev/null | wc -l').toString().trim()) || 0 } catch {}
  res.json({
    available: (missing > 0 || missingChannels > 0) && !!snapshot,
    missingSessions: missing,
    missingChannels,
    tmuxState,
    snapshot: snapshot?.file || null,
    snapshotTime: snapshot?.time || null,
    claudeChannels: snapshot?.claudeChannels || 0,
    currentProjects: projects,
    currentChannels: channels,
    busy: restoreInFlight,
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  })
})

// POST /api/restore — 一键恢复（幂等：已存在 session/window 跳过，不覆盖在跑会话）
app.post('/api/restore', authMiddleware, (req, res) => {
  if (restoreInFlight) return res.status(409).json({ error: 'restore 正在进行中，请稍候' })
  restoreInFlight = true
  const script = join(__dirname, 'scripts', 'nexus-restore-tmux.sh')
  exec(`bash "${script}" --manual`, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    restoreInFlight = false
    const ok = String(stdout).match(/^RESTORE_OK (.+)$/m)
    if (ok) {
      const kv = {}
      for (const pair of ok[1].trim().split(/\s+/)) {
        const [k, v] = pair.split('=')
        kv[k] = Number.isNaN(Number(v)) ? v : Number(v)
      }
      audit('restore', req, { result: 'ok', detail: ok[1] })
      console.log(`[restore-manual] ${ok[1]}`)
      return res.json({ ok: true, ...kv })
    }
    const em = String(stdout).match(/^RESTORE_ERR (.+)$/m) || String(stderr).match(/^RESTORE_ERR (.+)$/m)
    const msg = em ? em[1] : err ? err.message : 'restore 执行失败'
    audit('restore', req, { result: 'failed', detail: msg })
    console.error(`[restore-manual] failed: ${msg}`)
    res.status(500).json({ error: msg })
  })
})

// ── 救援（break-glass）──
// 最坏情况下（tmux 起不来 / 会话没恢复回来）面板仍然可用，并给出两条自救路径：
//   1. 救援终端（不依赖 tmux，见 /ws?rescue=1）——里面可以直接跑 recovery agent
//   2. POST /api/rescue/run —— 一键跑 scripts/nexus-rescue.sh（零 root 的 break-glass）
app.get('/api/rescue/status', authMiddleware, (req, res) => {
  const { snapshot, missing, list, missingChannels, channelsList } = missingSessions()
  let unit = 'unknown'
  try {
    unit = execFileSync('systemctl', ['is-active', 'nexus-tmux'], { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch (e) {
    unit = String((e && (e.stdout || e.message)) || '').trim() || 'inactive'
  }
  const socketDir = `/tmp/tmux-${typeof process.getuid === 'function' ? process.getuid() : 1000}`
  res.json({
    tmux: { state: tmuxState, up: tmuxState === 'ready', socketDir, socketDirExists: existsSync(socketDir) },
    unit,
    snapshot: snapshot?.file || null,
    snapshotTime: snapshot?.time || null,
    claudeChannels: snapshot?.claudeChannels || 0,
    missingSessions: missing,
    missingList: list,
    missingChannels,
    missingChannelsList: channelsList,
    busy: restoreInFlight || rescueInFlight,
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  })
})

app.post('/api/rescue/run', authMiddleware, (req, res) => {
  if (rescueInFlight) return res.status(409).json({ error: '救援正在进行中，请稍候' })
  rescueInFlight = true
  const script = join(__dirname, 'scripts', 'nexus-rescue.sh')
  exec(`bash "${script}"`, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    rescueInFlight = false
    const out = String(stdout || '').trim() || String(stderr || '').trim() || (err ? err.message : '')
    audit('rescue', req, { result: err ? `failed: ${err.message}` : 'ok' })
    console.log(`[rescue] ${err ? 'failed: ' + err.message : 'done'}`)
    res.json({ ok: !err, output: out.slice(-8000) })
  })
})

// GET /api/projects/:name/channels — 列出指定 Project 的 Channels（windows）
app.get('/api/projects/:name/channels', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  exec(
    `tmux list-windows -t ${sessionName} -F "#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const lines = stdout.trim().split('\n').filter(Boolean)
      const channels = lines.map(line => {
        const parts = line.split('|')
        const index = Number(parts[0])
        const name = parts[1]
        const active = parts[2]?.trim() === '1'
        const cwd = parts.slice(3).join(':') || ''
        return { index, name, active, cwd }
      })
      // 新创建的频道排在上面
      channels.reverse()
      res.json({ project: sessionName, channels })
    }
  )
})

// POST /api/projects — 新建 Project（创建 tmux session）
// body: { path, shell_type?, profile? }
// project 名称基于路径自动生成
app.post('/api/projects', authMiddleware, (req, res) => {
  const { path, shell_type = 'claude', profile } = req.body || {}
  if (!path) return res.status(400).json({ error: 'path required' })

  const cwd = path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`
  if (!existsSync(cwd)) {
    return res.status(400).json({ error: `工作目录不存在：${cwd}` })
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `不是目录：${cwd}` })
    }
  } catch (e) {
    return res.status(400).json({ error: `无法访问：${cwd}（${e.message}）` })
  }

  // project 名称基于路径：把 / 替换成 -，并去除首尾 -
  let projectName = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-')
  if (!projectName) projectName = 'home'
  // 确保名称安全且唯一
  const safeName = projectName.replace(/[^a-zA-Z0-9._~-]/g, '-').substring(0, 50) || 'project'

  // 检查是否已存在同名 session，如果存在则添加序号
  let finalName = safeName
  try {
    const existing = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null').toString().trim().split('\n')
    let counter = 1
    while (existing.includes(finalName)) {
      finalName = `${safeName}-${counter++}`
    }
  } catch {}

  // 构建 shell 命令
  const { proxyVars, proxyPrefix } = buildLaunchEnv()

  let shellCmd
  if (shell_type === 'bash') {
    shellCmd = buildInteractiveShellCmd(proxyPrefix)
  } else {
    if (profile) {
      const runScript = join(__dirname, 'nexus-run-claude.sh')
      // claude 失败时给出提示，再 fallback 到交互 shell，避免窗口看起来"没反应"
      // 注意：提示文本里不能有 `"`；用单引号避免与 execFileSync 的参数边界冲突
      shellCmd = `${proxyPrefix}bash '${runScript}' ${profile} '${cwd}' || echo; echo '[Nexus] claude 退出或启动失败，fallback 到 ${INTERACTIVE_SHELL}（可直接输入 claude 重试）'; ${INTERACTIVE_SHELL_CMD}`
    } else {
      shellCmd = `${proxyPrefix}${CLAUDE_CMD} --dangerously-skip-permissions || echo; echo '[Nexus] claude 退出或启动失败，请确认已 claude login 或配置 API key'; ${INTERACTIVE_SHELL_CMD}`
    }
  }

  // 初始窗口名使用目录名[-profile名]（取路径最后一部分）
  const dirName = cwd.replace(/^\/+|\/+$/g, '').split('/').pop() || '~'
  const initialWindowName = profile ? `${dirName}-${profile}` : dirName

  // 创建 tmux session（改用 execFileSync，避免 shellCmd 含引号时 shell 参数解析错位
  // 导致 tmux 收到截断的命令，window 瞬间退出 → session 消亡 → 后续 set-environment
  // 报 "no such session"）
  // 同时把 NEXUS_CWD 和 proxy vars 通过 `-e KEY=VAL` 在 new-session 时一次性注入，
  // 避免 session 存活不稳时后置 set-environment 失败
  const newSessionArgs = [
    'new-session', '-d',
    '-s', finalName,
    '-n', initialWindowName,
    '-c', cwd,
    '-e', `NEXUS_CWD=${cwd}`,
  ]
  for (const [key, value] of Object.entries(proxyVars)) {
    newSessionArgs.push('-e', `${key}=${value}`)
  }
  newSessionArgs.push(shellCmd)
  try {
    execFileSync('tmux', newSessionArgs, { stdio: 'pipe' })
  } catch (err) {
    return res.status(500).json({ error: 'failed to create project: ' + err.message })
  }

  audit('session-created', req, { target: finalName, cwd })
  res.json({ name: finalName, path: cwd, shell_type, profile: profile || null })
})

// POST /api/projects/:name/channels — 在指定 Project 中新建 Channel（window）
app.post('/api/projects/:name/channels', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  const { shell_type = 'claude', profile, path: bodyPath } = req.body || {}

  // 优先使用前端传入的 path，其次读取 NEXUS_CWD，最后 fallback 到 WORKSPACE_ROOT
  let cwd = WORKSPACE_ROOT
  if (bodyPath) {
    cwd = bodyPath
  } else {
    try {
      const envOutput = execSync(`tmux show-environment -t ${sessionName} NEXUS_CWD 2>/dev/null`).toString().trim()
      const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
      if (match) cwd = match[1]
    } catch {}
  }
  if (!existsSync(cwd)) {
    return res.status(400).json({ error: `工作目录不存在：${cwd}` })
  }

  // Channel 命名：profile 名[-序号]
  const baseName = profile || 'channel'
  let channelName = baseName
  try {
    const existing = execSync(`tmux list-windows -t ${sessionName} -F "#{window_name}"`).toString().trim().split('\n')
    let counter = 1
    while (existing.includes(channelName)) {
      channelName = `${baseName}-${counter++}`
    }
  } catch {}

  // 构建 shell 命令
  const { proxyVars, proxyPrefix } = buildLaunchEnv()

  let shellCmd
  if (shell_type === 'bash') {
    shellCmd = buildInteractiveShellCmd(proxyPrefix)
  } else {
    if (profile) {
      const runScript = join(__dirname, 'nexus-run-claude.sh')
      shellCmd = `${proxyPrefix}bash '${runScript}' ${profile} '${cwd}' || echo; echo '[Nexus] claude 退出或启动失败，fallback 到 ${INTERACTIVE_SHELL}（可直接输入 claude 重试）'; ${INTERACTIVE_SHELL_CMD}`
    } else {
      shellCmd = `${proxyPrefix}${CLAUDE_CMD} --dangerously-skip-permissions || echo; echo '[Nexus] claude 退出或启动失败，请确认已 claude login 或配置 API key'; ${INTERACTIVE_SHELL_CMD}`
    }
  }

  // 确保 session 存在（server 归 nexus-tmux.service；缺席时绝不自己造，交给救援）
  if (!tmuxServerUp()) {
    tmuxState = 'broken'
    return res.status(503).json({ error: 'tmux server 未就绪（归 nexus-tmux.service 管理）', rescue: true })
  }
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'pipe' })
  } catch {
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-n', 'shell', INTERACTIVE_SHELL], { stdio: 'pipe' })
    } catch {}
  }

  // 创建新 window —— 改 execFileSync 避免 shellCmd 引号嵌套问题
  try {
    execFileSync('tmux', [
      'new-window',
      '-t', sessionName,
      '-c', cwd,
      '-n', channelName,
      shellCmd,
    ], { stdio: 'pipe' })
    audit('channel-created', req, { target: sessionName, channel: channelName, cwd, profile: profile || null })
    res.json({ name: channelName, cwd, shell_type, profile: profile || null, project: sessionName })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/projects/:name/activate — 切换到指定 Project（设置为目标 session）
app.post('/api/projects/:name/activate', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  // 验证 session 存在
  try {
    execSync(`tmux has-session -t ${sessionName}`)
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  // 读取该 session 最后激活的 channel
  let lastChannel = null
  try {
    const envOutput = execSync(`tmux show-environment -t ${sessionName} NEXUS_LAST_CHANNEL 2>/dev/null`).toString().trim()
    const match = envOutput.match(/^NEXUS_LAST_CHANNEL=(\d+)$/)
    if (match) lastChannel = parseInt(match[1], 10)
  } catch {}
  // 验证 channel 是否存在，不存在则返回 null（前端会用第一个）
  if (lastChannel !== null) {
    try {
      const windows = execSync(`tmux list-windows -t ${sessionName} -F "#I"`).toString().trim().split('\n')
      if (!windows.includes(String(lastChannel))) {
        lastChannel = null
      }
    } catch {
      lastChannel = null
    }
  }
  // 返回 session 信息，前端据此切换 WebSocket 连接
  res.json({ active: true, project: sessionName, lastChannel })
})

// POST /api/projects/:name/rename — 重命名 Project（重命名 tmux session）
app.post('/api/projects/:name/rename', authMiddleware, (req, res) => {
  const oldName = req.params.name
  const { name: newName } = req.body || {}
  if (!newName || !newName.trim()) {
    return res.status(400).json({ error: 'new name required' })
  }
  // session 名允许 Unicode，但不能含 tmux 保留字符（`:` `.`）、空白、路径分隔符、控制字符
  // —— 之前的 /[^a-zA-Z0-9_\-]/→'' 把中文字符直接删掉，中文名会变空导致 invalid name
  const sanitizedNewName = String(newName).trim().replace(/[\s:.\0\r\n\t\/\\]/g, '').slice(0, 50)
  if (!sanitizedNewName) {
    return res.status(400).json({ error: 'invalid name format' })
  }
  // 验证旧 session 存在
  try {
    execSync(`tmux has-session -t ${oldName}`)
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  // 检查新名称是否已存在
  try {
    execSync(`tmux has-session -t ${sanitizedNewName}`)
    return res.status(409).json({ error: 'project name already exists' })
  } catch {
    // 不存在，可以重命名
  }
  // 执行重命名
  try {
    execFileSync('tmux', ['rename-session', '-t', oldName, '--', sanitizedNewName], { stdio: 'pipe' })

    audit('session-renamed', req, { target: oldName, name: sanitizedNewName })
    res.json({ ok: true, oldName, newName: sanitizedNewName })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/projects/:name — 关闭 Project（kill tmux session）
app.delete('/api/projects/:name', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  // 验证 session 存在
  try {
    execSync(`tmux has-session -t ${sessionName}`)
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  // kill session
  exec(`tmux kill-session -t ${sessionName}`, (err) => {
    audit('session-deleted', req, { target: sessionName, result: err ? `failed: ${err.message}` : 'ok' })
    if (err) return res.status(500).json({ error: err.message })
    res.json({ ok: true })
  })
})

// ================================================

// GET /api/sessions — 列出 tmux 会话的所有窗口
app.get('/api/sessions', authMiddleware, (req, res) => {
  const session = req.query.session || TMUX_SESSION
  exec(
    `tmux list-windows -t ${session} -F "#{window_index}|#{window_name}|#{window_active}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const windows = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [index, name, active] = line.split('|')
        return { index: Number(index), name, active: active?.trim() === '1' }
      })
      res.json({ session, windows })
    }
  )
})

// DELETE /api/sessions/:id — 关闭 tmux 窗口
app.delete('/api/sessions/:id', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  // Check window count first; if this is the last window, create a fallback
  // window before killing so the tmux session is not destroyed.
  exec(`tmux list-windows -t ${session} -F "#{window_index}" 2>/dev/null | wc -l`, (countErr, countOut) => {
    const windowCount = parseInt(countOut.trim()) || 0
    if (windowCount <= 1) {
      // Last window: create a new shell first to keep the session alive
      exec(`tmux new-window -t ${session} -n shell "${INTERACTIVE_SHELL}"`, () => {
        exec(`tmux kill-window -t ${session}:${index}`, (err) => {
          audit('channel-deleted', req, { target: `${session}:${index}`, result: err ? `failed: ${err.message}` : 'ok' })
          if (err) return res.status(500).json({ error: err.message })
          res.json({ ok: true })
        })
      })
    } else {
      exec(`tmux kill-window -t ${session}:${index}`, (err) => {
        audit('channel-deleted', req, { target: `${session}:${index}`, result: err ? `failed: ${err.message}` : 'ok' })
        if (err) return res.status(500).json({ error: err.message })
        res.json({ ok: true })
      })
    }
  })
})

// POST /api/sessions/:id/attach — 切换到指定 tmux 窗口
app.post('/api/sessions/:id/attach', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  exec(`tmux select-window -t ${session}:${index}`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    // 记录最后激活的 channel 到环境变量
    try {
      execSync(`tmux set-environment -t ${session} NEXUS_LAST_CHANNEL ${index}`)
    } catch {}
    res.json({ ok: true })
  })
})

// ========== F-24: 对讲机模式（实验特性）==========
// 频道清单 / 直接发送 / 口语精炼 / 回复追踪四件事全在 walkie.js 里，
// 这里只负责挂载并注入它需要的上下文（认证、数据目录、默认 session、审计）。
app.use('/api/walkie', createWalkieRouter({ authMiddleware, dataDir: DATA_DIR, tmuxSession: TMUX_SESSION, audit }))

// SPA fallback — 所有非 API 路由返回 index.html
app.get('*', (req, res) => {
  const indexPath = join(__dirname, 'frontend', 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run: cd frontend && npm run build');
  });
});

// PTY 多实例管理（F-11/F-18：每个 session:window 独立 PTY）
const ptyMap = new Map(); // "session:windowIndex" -> { pty, clients: Set<ws>, lastOutput, lastActivity }

function ptyKey(session, windowIndex) {
  return `${session}:${windowIndex}`;
}

// ── 救援 PTY：不依赖 tmux 的终端 ─────────────────────────────────────────────
// tmux 一旦坏掉，Nexus 里其它终端全都是 `tmux attach-session`，等于全废。这个 PTY 直接
// 跑 zsh（或直接跑 recovery agent），是「最坏情况下网页仍然可用、还能起一个修东西的
// agent」的那条命脉。前端从 /ws?rescue=1[&agent=1] 接进来。
const RESCUE_PROMPT = [
  '机器刚重启或出现异常，tmux 里的会话没有恢复到 Nexus 里。你的唯一任务是把它们恢复回来：',
  '1) 先跑 `bash /home/librae/work/nexus/scripts/nexus-rescue.sh`，把输出读完；',
  '2) 若 tmux server 不在，查 `systemctl status nexus-tmux` 与 `journalctl -u nexus-tmux -n 50`；',
  '3) 恢复脚本是幂等的，可以重复跑；细节见 docs/SESSION-PERSISTENCE.md 的救援一节；',
  '3b) 若还有服务没起来：pm2 resurrect，或 pm2 start /home/librae/work/nexus/ecosystem.config.cjs；mihomo（clash-meta）不在就先起它；',
  '4) 不要重启机器、不要 kill-server。做完把「恢复了哪些 session、还缺什么、你判断的根因」讲清楚。',
].join(' ');

function spawnRescuePty(key, agent) {
  const env = { ...process.env, LANG: 'C.UTF-8', TERM: 'xterm-256color' };
  let cmd, args;
  if (agent) {
    // 救援 agent 必须**不依赖本机代理**：最坏情况是 PM2 挂了 → mihomo 也没了，
    // 而 127.0.0.1:7890 连不上 = 「agent 连模型都连不上」，命脉在最需要时断掉。
    // 所以：① 摘掉所有 proxy 变量走直连；② 默认用墙内直连可达的 profile（deepseek），
    // 而不是官方 anthropic（官方接口在这台机器上本来就得靠代理）。
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NEXUS_PROXY', 'CLAUDE_PROXY']) delete env[k];
    cmd = 'bash';
    args = [join(__dirname, 'nexus-run-claude.sh'), process.env.NEXUS_RESCUE_PROFILE || 'deepseek', __dirname];
    env.NEXUS_INITIAL_PROMPT = RESCUE_PROMPT;
  } else {
    cmd = INTERACTIVE_SHELL === 'zsh' ? '/usr/bin/zsh' : '/bin/bash';
    args = ['-l'];
  }

  let ptyProc = null;
  try {
    ptyProc = pty.spawn(cmd, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: __dirname, env });
  } catch (err) {
    console.error(`[rescue] pty.spawn 失败（${cmd} ${args.join(' ')}）: ${err.message}`);
  }

  const entry = { pty: ptyProc, clients: new Set(), clientSizes: new Map(), lastOutput: '', lastActivity: Date.now(), rescue: true, agent: !!agent };
  if (ptyProc) {
    ptyProc.onData((data) => {
      const ent = ptyMap.get(key);
      if (!ent) return;
      ent.lastOutput = (ent.lastOutput + data).slice(-10000);
      ent.lastActivity = Date.now();
      for (const ws of ent.clients) if (ws.readyState === 1) ws.send(data);
    });
    ptyProc.onExit(({ exitCode }) => {
      console.log(`[rescue] PTY ${key} exited with code ${exitCode}`);
      ptyMap.delete(key); // 救援终端退出就退出，不自动重开（用户自己再点）
    });
  }
  return entry;
}

function ensureWindowPty(session, windowIndex) {
  // tmux server 不在：不给用户一个死终端，直接给救援 shell（它不依赖 tmux）
  if (!tmuxServerUp()) {
    tmuxState = 'broken';
    const rkey = ptyKey(session, windowIndex);
    if (!ptyMap.has(rkey)) ptyMap.set(rkey, spawnRescuePty(rkey, false));
    return { key: rkey, entry: ptyMap.get(rkey) };
  }

  // Validate session exists as a real tmux session (execFileSync avoids shell expansion)
  let safeSession = session;
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'pipe' });
  } catch {
    // Requested session doesn't exist — fall back to default TMUX_SESSION
    safeSession = TMUX_SESSION;
    try {
      execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'pipe' });
    } catch {
      // Default session also missing — create it
      try { execFileSync('tmux', ['new-session', '-d', '-s', TMUX_SESSION, '-n', 'shell', INTERACTIVE_SHELL], { stdio: 'pipe' }); } catch {}
    }
  }

  const key = ptyKey(safeSession, windowIndex);
  if (ptyMap.has(key)) return { key, entry: ptyMap.get(key) };

  // 检查窗口是否存在，不存在则 fallback 到第一个可用窗口
  let targetWindow = windowIndex;
  try {
    const out = execFileSync('tmux', ['list-windows', '-t', safeSession, '-F', '#I'], { encoding: 'utf8', stdio: 'pipe' });
    const windows = out.trim().split('\n');
    if (!windows.includes(String(windowIndex))) {
      console.log(`[ensureWindowPty] window ${windowIndex} not found in session ${safeSession}, falling back`);
      if (windows.length > 0) {
        targetWindow = parseInt(windows[0], 10);
      } else {
        execFileSync('tmux', ['new-window', '-t', safeSession, '-n', 'shell', INTERACTIVE_SHELL], { stdio: 'pipe' });
        targetWindow = 0;
      }
    }
  } catch {
    targetWindow = 0;
  }

  const actualKey = ptyKey(safeSession, targetWindow);
  if (ptyMap.has(actualKey)) return { key: actualKey, entry: ptyMap.get(actualKey) }; // reuse if fallback exists

  let ptyProc;
  try {
    ptyProc = pty.spawn('tmux', ['attach-session', '-t', `${safeSession}:${targetWindow}`], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env: { ...process.env, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    });
  } catch (err) {
    console.error(`pty.spawn failed for ${safeSession}:${targetWindow}:`, err.message);
    return { key: actualKey, entry: { pty: null, clients: new Set(), clientSizes: new Map(), lastOutput: '', lastActivity: Date.now() } };
  }

  const entry = { pty: ptyProc, clients: new Set(), clientSizes: new Map(), lastOutput: '', lastActivity: Date.now() };
  ptyMap.set(actualKey, entry);

  ptyProc.onData((data) => {
    const ent = ptyMap.get(actualKey);
    if (!ent) return;
    ent.lastOutput = (ent.lastOutput + data).slice(-10000);
    ent.lastActivity = Date.now();
    for (const ws of ent.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    console.log(`PTY ${actualKey} exited with code ${exitCode}`);
    ptyMap.delete(actualKey);
    // 如果 window 还在，重新创建
    try {
      const list = execFileSync('tmux', ['list-windows', '-t', safeSession, '-F', '#I'], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
      if (list.includes(String(targetWindow))) {
        setTimeout(() => ensureWindowPty(safeSession, targetWindow), 100);
      }
    } catch {}
  });

  return { key: actualKey, entry };
}

// WebSocket 服务 — 支持 /ws?token=xxx&window=<index>
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const windowParam = url.searchParams.get('window') || '0';
  const windowIndex = parseInt(windowParam, 10) || 0;
  const session = url.searchParams.get('session') || TMUX_SESSION;

  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(4001, 'unauthorized');
    return;
  }

  // 救援终端：/ws?rescue=1（shell）或 /ws?rescue=1&agent=1（recovery agent）——
  // 不经过 tmux，专门用在 tmux 不可用 / 会话没恢复回来的时候。
  let key, entry;
  if (url.searchParams.get('rescue') === '1') {
    const isAgent = url.searchParams.get('agent') === '1';
    key = isAgent ? 'rescue:agent' : 'rescue:shell';
    if (!ptyMap.has(key)) ptyMap.set(key, spawnRescuePty(key, isAgent));
    entry = ptyMap.get(key);
  } else {
    ({ key, entry } = ensureWindowPty(session, windowIndex));
  }
  entry.clients.add(ws);
  console.log(`Client connected to ${key} (clients: ${entry.clients.size})`);

  // Heartbeat: Cloudflare closes idle WebSockets after ~100s. Track liveness
  // via ping/pong so the server can detect and reclaim dead connections.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Send recent output so the screen isn't blank while waiting for the first repaint.
  if (entry.lastOutput) {
    ws.send(entry.lastOutput.slice(-2000));
  }

  ws.on('message', (msg) => {
    const ent = ptyMap.get(key);
    if (!ent || !ent.pty) return;
    const str = typeof msg === 'string' ? msg : msg.toString();
    let isResize = false;
    try {
      const data = JSON.parse(str);
      if (data && data.type === 'resize' && data.cols && data.rows) {
        isResize = true;
        const newCols = Number(data.cols);
        const newRows = Number(data.rows);
        ent.clientSizes.set(ws, { cols: newCols, rows: newRows });
        // 直接使用当前客户端的尺寸，而不是所有客户端的最小值
        // 避免多个客户端/窗口切换时的尺寸混乱
        ent.pty.resize(Math.max(newCols, 10), Math.max(newRows, 5));
      }
    } catch { /* not JSON — fall through to pty.write */ }
    // Write for all non-resize messages. Previously only the catch branch wrote,
    // which silently dropped single-digit strings ('1'..'9','0') since
    // JSON.parse('1') succeeds without throwing.
    if (!isResize) ent.pty.write(str);
  });

  ws.on('close', () => {
    const ent = ptyMap.get(key);
    if (ent) {
      ent.clients.delete(ws);
      ent.clientSizes.delete(ws);
      console.log(`Client disconnected from ${key} (clients: ${ent.clients.size})`);
      // Recompute minimum size if other clients remain
      if (ent.clients.size > 0 && ent.clientSizes.size > 0) {
        let minCols = Infinity, minRows = Infinity;
        for (const [, size] of ent.clientSizes) {
          if (size.cols < minCols) minCols = size.cols;
          if (size.rows < minRows) minRows = size.rows;
        }
        if (minCols !== Infinity) ent.pty.resize(Math.max(minCols, 10), Math.max(minRows, 5));
      }
      // 如果 5 分钟后没有客户端，清理 PTY 节省资源
      setTimeout(() => {
        const e = ptyMap.get(key);
        if (e && e.clients.size === 0 && Date.now() - e.lastActivity > 300000) {
          e.pty.kill();
          ptyMap.delete(key);
          console.log(`PTY ${key} cleaned up (idle)`);
        }
      }, 300000);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    const ent = ptyMap.get(key);
    if (ent) { ent.clients.delete(ws); ent.clientSizes.delete(ws); }
  });
});

// Ping every 30s — well under Cloudflare's ~100s idle timeout. Any client that
// didn't respond to the previous ping is treated as dead and forcibly closed.
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket already closing */ }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(Number(PORT), HOST, () => {
  console.log(`Nexus listening on ${HOST}:${PORT}`);
  console.log(`tmux session: ${TMUX_SESSION}`);
  console.log(`workspace: ${WORKSPACE_ROOT}`);
  console.log(`claude: ${CLAUDE_BIN || '(未找到，回退到 PATH 上的 claude)'}`);
  // tmux server 归 nexus-tmux.service 管：起服务器、建 socket 目录、定义 server 的 env、
  // 并在（重）启动后触发快照恢复。Nexus 不再自己起 server / 清 tmux global env / 触发恢复。
  // 这里只做两件事（异步、不阻塞 listen，更不 exit —— 面板必须永远能打开）：
  //   1. 探测就绪，就绪后兜底确保默认 session 在
  //   2. 不就绪 / 快照有 session 没恢复 → 进救援模式（面板横幅 + 微信提醒 + 救援终端）
  (async () => {
    const deadline = Date.now() + 30000;
    let up = false;
    while (Date.now() < deadline) {
      if (tmuxServerUp()) { up = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) {
      tmuxState = 'broken';
      console.error('[Nexus] tmux server 30s 内未就绪 —— 进入救援模式（面板仍可用：救援终端 / 一键救援）');
      audit('tmux-broken', null, { result: 'probe-timeout' });
      notifyRescueOnce('tmux server 未就绪');
      return;
    }
    console.log('[Nexus] tmux server 就绪');
    audit('tmux-ready', null, { sessions: [...reconcileInventory('boot').keys()].join(',') });
    try {
      const defaultWindowName = WORKSPACE_ROOT.replace(/^\/+|\/+$/, '').split('/').pop() || '~'
      execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null || tmux new-session -d -s ${TMUX_SESSION} -n "${defaultWindowName}" -c "${WORKSPACE_ROOT}" "${INTERACTIVE_SHELL}"`);
      console.log(`tmux session '${TMUX_SESSION}' ready`);
    } catch (e) { console.warn('tmux session init failed:', e.message); }
    try {
      const { missing } = missingSessions();
      if (missing > 0) {
        console.warn(`[Nexus] 快照里有 ${missing} 个 session 不在线上：面板可一键恢复，或 POST /api/rescue/run`);
        notifyRescueOnce(`有 ${missing} 个 session 未恢复`);
      }
    } catch (e) { console.warn('missingSessions 检查失败:', e.message); }
  })();
});
