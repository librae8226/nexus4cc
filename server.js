// server.js — Nexus v4.4.2 (security-hardened)
import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createServer } from 'node:http';
import { execFile, spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, isAbsolute, basename } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, rmdirSync, renameSync, cpSync, rmSync } from 'node:fs';
import { readdir, stat as statAsync } from 'node:fs/promises';
import https from 'node:https';
import multer from 'multer';
import cookieParser from 'cookie-parser';

// ── env loading ──
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
} catch { /* .env not found */ }

const __dirname = dirname(fileURLToPath(import.meta.url));
const { JWT_SECRET, ACC_PASSWORD_HASH } = process.env;
 
// escape shell arguments for tmux commands
function shEscape(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
if (!JWT_SECRET || !ACC_PASSWORD_HASH) { console.error('ERROR: JWT_SECRET and ACC_PASSWORD_HASH required'); process.exit(1); }

// ── config ──
const TMUX_SESSION = process.env.TMUX_SESSION || 'nexus';
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';
const DEFAULT_WORKSPACE = join(process.env.HOME || '/root', '.nexus_workspace');
if (!existsSync(DEFAULT_WORKSPACE)) mkdirSync(DEFAULT_WORKSPACE, { recursive: true });
const PORT = process.env.PORT || '3000';
const CLAUDE_PROXY = process.env.CLAUDE_PROXY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TELEGRAM_DEFAULT_SESSION = process.env.TELEGRAM_DEFAULT_SESSION || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'librae8226/nexus4cc';

// ── data dirs ──
const DATA_DIR = join(__dirname, 'data');
const TOOLBAR_CONFIG_FILE = join(DATA_DIR, 'toolbar-config.json');
const CONFIGS_DIR = join(DATA_DIR, 'configs');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
[DATA_DIR, CONFIGS_DIR, UPLOADS_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

// ── app setup ──
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(join(__dirname, 'public')));
app.use(express.static(join(__dirname, 'frontend', 'dist')));

// ── rate limiter (in-memory) ──
const limiterStore = new Map();
function createRateLimiter({ windowMs = 60000, max = 60, keyFn = (r) => r.ip || r.connection?.remoteAddress || '' }) {
  return (req, res, next) => {
    const key = String(keyFn(req) || 'default');
    const now = Date.now();
    let entry = limiterStore.get(key);
    if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + windowMs };
    if (entry.count < max) { entry.count++; return next(); }
    res.status(429).json({ error: 'too many requests', retryAfter: Math.ceil((entry.resetAt - now) / 1000) });
  };
}
const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 5, keyFn: (r) => r.ip || r.connection?.remoteAddress || '' });
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 100, keyFn: (r) => r.ip || r.connection?.remoteAddress || '' });
setInterval(() => { const now = Date.now(); for (const [k, e] of limiterStore) if (now > e.resetAt) limiterStore.delete(k); }, 60_000);

// ── auth middleware ──
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) { try { jwt.verify(token, JWT_SECRET); req.authenticated = true; return next(); } catch {} }
  const cookieToken = req.cookies?.nexus_token;
  if (cookieToken) { try { jwt.verify(cookieToken, JWT_SECRET); req.authenticated = true; return next(); } catch {} }
  res.status(401).json({ error: 'unauthorized' });
}

// ── safe tmux helpers ──
function tmuxHasSession(s) { try { execFileSync('tmux', ['has-session', '-t', s], { stdio: 'ignore' }); return true; } catch { return false; } }
function setTmuxEnv(s, k, v) { try { execFileSync('tmux', ['set-environment', '-t', s, k, v], { stdio: 'ignore' }); } catch {} }
// Central session cwd management: use tmux user option @nexus_cwd with pane_current_path fallback
function getSessionCwd(session, fallback = DEFAULT_WORKSPACE) {
  try {
    const opt = execFileSync('tmux', ['show-options', '-t', session, '@nexus_cwd'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const m = opt.match(/^@nexus_cwd\s+"?([^"]+)"?$/);
    if (m && m[1]) return m[1];
  } catch {}
  try {
    const path = execFileSync('tmux', ['display-message', '-t', session, '-p', '#{pane_current_path}'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (path) return path;
  } catch {}
  return fallback;
}
function setSessionCwd(session, cwd) {
  try { execFileSync('tmux', ['set-option', '-t', session, '@nexus_cwd', cwd], { stdio: 'ignore' }); } catch {}
}
function getLastChannel(session) {
  try {
    const opt = execFileSync('tmux', ['show-options', '-t', session, '@nexus_last_channel'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const m = opt.match(/^@nexus_last_channel\s+(\d+)$/);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return null;
}
function setLastChannel(session, idx) {
  try { execFileSync('tmux', ['set-option', '-t', session, '@nexus_last_channel', idx], { stdio: 'ignore' }); } catch {}
}
function ensureTmuxSession(s, defaultCwd = DEFAULT_WORKSPACE) {
  if (!tmuxHasSession(s)) {
    return false;
  }
  return true;
}
function proxyVars() {
  return {
    ...(process.env.HTTP_PROXY  ? { HTTP_PROXY:  process.env.HTTP_PROXY  } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.ALL_PROXY   ? { ALL_PROXY:   process.env.ALL_PROXY   } : {}),
    ...(process.env.http_proxy  ? { http_proxy:  process.env.http_proxy  } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
    ...(CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY, NEXUS_PROXY: CLAUDE_PROXY } : {}),
  };
}

// ── PTY map ──
const ptyMap = new Map();
function ptyKey(s, w) { return `${s}:${w}`; }

// ── POST /api/auth/login ──
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    const ok = await bcrypt.compare(password, ACC_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    const token = jwt.sign({}, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('nexus_token', jwt.sign({}, JWT_SECRET, { expiresIn: '7d' }), { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7*24*60*60*1000, path: '/' });
    res.json({ token });
  } catch (err) { res.status(500).json({ error: 'internal error' }); }
});

// ── POST /api/windows ──
app.post('/api/windows', apiLimiter, authMiddleware, (req, res) => {
  const { rel_path, shell_type = 'claude', profile } = req.body || {};
  const ts = req.query.session || TMUX_SESSION;
  let cwd;
  if (rel_path) {
    cwd = rel_path.startsWith('/') ? rel_path : `${WORKSPACE_ROOT}/${rel_path}`;
    setSessionCwd(ts, cwd);
  } else {
    cwd = getSessionCwd(ts);
  }
  const name = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'window';
  const pv = proxyVars();
  const px = Object.entries(pv).map(([k,v]) => `export ${k}='${v}'`).join('; ');
  const pp = px ? `${px}; ` : '';
  let shellCmd;
  if (shell_type === 'bash') shellCmd = `${pp}exec zsh -i`;
  else if (profile) { const rs = join(__dirname, 'nexus-run-claude.sh'); shellCmd = `${pp}bash ${shEscape(rs)} ${shEscape(profile)} ${shEscape(cwd)}`; }
  else shellCmd = `${pp}claude --dangerously-skip-permissions; exec zsh -i`;
  if (!ensureTmuxSession(ts, cwd)) return res.status(404).json({ error: `session '${ts}' not found. Create via POST /api/projects first.` });
  for (const [k,v] of Object.entries(pv)) setTmuxEnv(ts, k, v);
  execFile('tmux', ['new-window', '-t', ts, '-c', cwd, '-n', name, shellCmd], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ name, cwd, shell_type, profile: profile || null, session: ts });
  });
});

// ── POST /api/sessions ──
app.post('/api/sessions', apiLimiter, authMiddleware, (req, res) => {
  const { rel_path, shell_type = 'claude', profile, session } = req.body || {};
  const ts = session || TMUX_SESSION;
  if (!rel_path) return res.status(400).json({ error: 'rel_path required' });
  const cwd = rel_path.startsWith('/') ? rel_path : `${WORKSPACE_ROOT}/${rel_path}`;
  const name = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'session';
  const pv = proxyVars();
  const px = Object.entries(pv).map(([k,v]) => `export ${k}='${v}'`).join('; ');
  const pp = px ? `${px}; ` : '';
  let shellCmd;
  if (shell_type === 'bash') shellCmd = `${pp}exec zsh -i`;
  else if (profile) { const rs = join(__dirname, 'nexus-run-claude.sh'); shellCmd = `${pp}bash ${shEscape(rs)} ${shEscape(profile)} ${shEscape(cwd)}`; }
  else shellCmd = `${pp}claude --dangerously-skip-permissions; exec zsh -i`;
  if (!ensureTmuxSession(ts, cwd)) return res.status(404).json({ error: `session '${ts}' not found. Create via POST /api/projects first.` });
  for (const [k,v] of Object.entries(pv)) setTmuxEnv(ts, k, v);
  execFile('tmux', ['new-window', '-t', ts, '-c', cwd, '-n', name, shellCmd], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ name, cwd, shell_type, profile: profile || null, session: ts });
  });
});

// ── Configs ──
app.get('/api/configs', apiLimiter, authMiddleware, (req, res) => {
  try {
    const files = readdirSync(CONFIGS_DIR, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.json')).map(f => ({ name: f.name, mtime: statSync(join(CONFIGS_DIR, f.name)).mtimeMs })).sort((a,b) => b.mtime - a.mtime).map(f => f.name);
    res.json(files.map(f => { try { const d = JSON.parse(readFileSync(join(CONFIGS_DIR, f), 'utf8')); return { id: f.replace('.json',''), label: d.label || f.replace('.json',''), ...d }; } catch { return { id: f.replace('.json',''), label: f.replace('.json','') }; } }));
  } catch { res.json([]); }
});
app.post('/api/configs/:id', apiLimiter, authMiddleware, (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase(); if (!id) return res.status(400).json({ error: 'invalid id' });
  try { writeFileSync(join(CONFIGS_DIR, `${id}.json`), JSON.stringify(req.body, null, 2), 'utf8'); res.json({ ok: true, id }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/configs/:id', apiLimiter, authMiddleware, (req, res) => {
  const file = join(CONFIGS_DIR, `${req.params.id}.json`);
  try { if (existsSync(file)) unlinkSync(file); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Toolbar ──
app.get('/api/toolbar-config', apiLimiter, authMiddleware, (req, res) => {
  try { if (!existsSync(TOOLBAR_CONFIG_FILE)) return res.json(null); res.json(JSON.parse(readFileSync(TOOLBAR_CONFIG_FILE, 'utf8'))); } catch { res.json(null); }
});
app.post('/api/toolbar-config', apiLimiter, authMiddleware, (req, res) => {
  try { writeFileSync(TOOLBAR_CONFIG_FILE, JSON.stringify(req.body), 'utf8'); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Version ──
app.get('/api/version', apiLimiter, authMiddleware, (req, res) => {
  try {
    const current = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: __dirname, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: __dirname, encoding: 'utf8' }).trim();
    res.json({ current, clean: dirty === '' });
  } catch { res.json({ current: 'unknown', clean: true }); }
});
app.get('/api/version/latest', apiLimiter, authMiddleware, (req, res) => {
  const rq = https.request({ hostname: 'api.github.com', path: `/repos/${GITHUB_REPO}/tags`, headers: { 'User-Agent': 'nexus-update-check' } }, (ghRes) => {
    let data = ''; ghRes.on('data', c => data += c); ghRes.on('end', () => {
      try { const json = JSON.parse(data); if (!Array.isArray(json) || !json.length) return res.status(502).json({ error: 'no tags found' }); res.json({ latest: json[0].name, url: `https://github.com/${GITHUB_REPO}/releases/tag/${json[0].name}` }); } catch { res.status(502).json({ error: 'invalid response' }); }
    });
  }); rq.on('error', () => res.status(502).json({ error: 'cannot reach GitHub' })); rq.end();
});

// ── Workspace browse ──
app.get('/api/browse', apiLimiter, authMiddleware, (req, res) => {
  try {
    let p = req.query.path || WORKSPACE_ROOT; if (p === '~') p = WORKSPACE_ROOT; if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p); p = normalize(p);
    const entries = readdirSync(p, { withFileTypes: true }); const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ name: e.name, path: join(p, e.name) })).sort((a,b) => a.name.localeCompare(b.name));
    res.json({ path: p, parent: dirname(p) !== p ? dirname(p) : null, dirs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/workspace/files', apiLimiter, authMiddleware, async (req, res) => {
  try {
    let p = req.query.path || WORKSPACE_ROOT; if (p === '~') p = WORKSPACE_ROOT; if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p); p = normalize(p);
    const dirents = await readdir(p, { withFileTypes: true });
    const entries = await Promise.all(dirents.filter(e => !e.name.startsWith('.')).map(async e => { const fp = join(p, e.name); const st = await statAsync(fp); return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? st.size : undefined, mtime: st.mtimeMs }; }));
    res.json({ path: p, entries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── /workspace static file serving ──
app.use('/workspace', (req, res, next) => {
  const token = req.query.token;
  if (token) { try { jwt.verify(String(token), JWT_SECRET); return next(); } catch { return res.status(401).send('unauthorized'); } }
  const ct = req.cookies?.nexus_token; if (ct) { try { jwt.verify(ct, JWT_SECRET); return next(); } catch {} }
  return authMiddleware(req, res, next);
}, (req, res) => {
  try {
    let fp; if (req.query.path) { fp = normalize(decodeURIComponent(String(req.query.path))); }
    else { let rp = normalize(decodeURIComponent(req.path)).replace(/^(\.\.(\/|\|$))+/, ''); fp = join(WORKSPACE_ROOT, rp); }
    if (fp.includes('..')) return res.status(403).send('access denied');
    if (!existsSync(fp) || !statSync(fp).isFile()) return res.status(404).send('not found');
    if (req.query.dl === '1') res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(fp))}`);
    res.sendFile(fp);
  } catch (err) { res.status(500).send(err.message); }
});

// ── Workspace CRUD ──
app.post('/api/workspace/mkdir', apiLimiter, authMiddleware, (req, res) => {
  try { let { path: tp, name } = req.body; if (!name) return res.status(400).json({ error: 'name required' }); if (!isAbsolute(tp)) tp = join(WORKSPACE_ROOT, tp); tp = normalize(tp); const dp = join(tp, name); if (dp.includes('..')) return res.status(403).json({ error: 'invalid path' }); if (existsSync(dp)) return res.status(409).json({ error: 'already exists' }); mkdirSync(dp, { recursive: true }); res.json({ ok: true, path: dp }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/workspace/files', apiLimiter, authMiddleware, (req, res) => {
  try { let { path: tp, name, content = '' } = req.body; if (!name) return res.status(400).json({ error: 'name required' }); if (!isAbsolute(tp)) tp = join(WORKSPACE_ROOT, tp); tp = normalize(tp); const fp = join(tp, name); if (fp.includes('..')) return res.status(403).json({ error: 'invalid path' }); if (existsSync(fp)) return res.status(409).json({ error: 'already exists' }); writeFileSync(fp, content, 'utf8'); res.json({ ok: true, path: fp }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/workspace/file', apiLimiter, authMiddleware, (req, res) => {
  try { let p = req.query.path || ''; if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p); p = normalize(p); if (p.includes('..')) return res.status(403).json({ error: 'invalid path' }); if (!existsSync(p) || !statSync(p).isFile()) return res.status(404).json({ error: 'not found' }); res.json({ path: p, content: readFileSync(p, 'utf8') }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/workspace/file', apiLimiter, authMiddleware, (req, res) => {
  try { let { path: fp, content = '' } = req.body; if (!fp) return res.status(400).json({ error: 'path required' }); if (!isAbsolute(fp)) fp = join(WORKSPACE_ROOT, fp); fp = normalize(fp); if (fp.includes('..')) return res.status(403).json({ error: 'invalid path' }); writeFileSync(fp, content, 'utf8'); res.json({ ok: true, path: fp }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/workspace/entry', apiLimiter, authMiddleware, (req, res) => {
  try { let p = req.body?.path || req.query?.path || ''; if (!p) return res.status(400).json({ error: 'path required' }); if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p); p = normalize(p); if (p.includes('..')) return res.status(403).json({ error: 'invalid path' }); if (!existsSync(p)) return res.status(404).json({ error: 'not found' }); rmSync(p, { recursive: true, force: true }); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/workspace/rename', apiLimiter, authMiddleware, (req, res) => {
  try { let { path: sp, newName } = req.body || {}; if (!sp || !newName) return res.status(400).json({ error: 'path and newName required' }); if (!isAbsolute(sp)) sp = join(WORKSPACE_ROOT, sp); sp = normalize(sp); if (sp.includes('..')) return res.status(403).json({ error: 'invalid path' }); if (!existsSync(sp)) return res.status(404).json({ error: 'not found' }); const dp = normalize(join(dirname(sp), newName)); if (dp.includes('..')) return res.status(403).json({ error: 'invalid newName' }); if (existsSync(dp)) return res.status(409).json({ error: 'already exists' }); renameSync(sp, dp); res.json({ ok: true, path: dp }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/workspace/copy', apiLimiter, authMiddleware, (req, res) => {
  try { let { sourcePath, targetPath: dp } = req.body || {}; if (!sourcePath || !dp) return res.status(400).json({ error: 'sourcePath and targetPath required' }); if (!isAbsolute(sourcePath)) sourcePath = join(WORKSPACE_ROOT, sourcePath); if (!isAbsolute(dp)) dp = join(WORKSPACE_ROOT, dp); sourcePath = normalize(sourcePath); dp = normalize(dp); if (sourcePath.includes('..') || dp.includes('..')) return res.status(403).json({ error: 'invalid path' }); if (!existsSync(sourcePath)) return res.status(404).json({ error: 'source not found' }); if (existsSync(dp)) return res.status(409).json({ error: 'target already exists' }); cpSync(sourcePath, dp, { recursive: true }); res.json({ ok: true, path: dp }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/workspace/move', apiLimiter, authMiddleware, (req, res) => {
  try { let { sourcePath, targetPath: dp } = req.body || {}; if (!sourcePath || !dp) return res.status(400).json({ error: 'sourcePath and targetPath required' }); if (!isAbsolute(sourcePath)) sourcePath = join(WORKSPACE_ROOT, sourcePath); if (!isAbsolute(dp)) dp = join(WORKSPACE_ROOT, dp); sourcePath = normalize(sourcePath); dp = normalize(dp); if (sourcePath.includes('..') || dp.includes('..')) return res.status(403).json({ error: 'invalid path' }); if (!existsSync(sourcePath)) return res.status(404).json({ error: 'source not found' }); if (existsSync(dp)) return res.status(409).json({ error: 'target already exists' }); try { renameSync(sourcePath, dp); } catch (e) { if (e.code === 'EXDEV') { cpSync(sourcePath, dp, { recursive: true }); rmSync(sourcePath, { recursive: true, force: true }); } else throw e; } res.json({ ok: true, path: dp }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Upload ──
const upload = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => { let cwd = WORKSPACE_ROOT; try { const sn = req.body?.session_name || ''; const wins = execFileSync('tmux', ['list-windows', '-t', TMUX_SESSION, '-F', '#I:#W:#{pane_current_path}:#{window_active}'], { encoding: 'utf8' }).trim().split('\n'); for (const line of wins) { const ap = line.split(':'); if (ap[ap.length-1]?.trim() === '1') { cwd = ap.slice(2, ap.length-1).join(':'); break; } } } catch {} cb(null, cwd); }, filename: (req, file, cb) => cb(null, file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')) }), limits: { fileSize: 50*1024*1024 } });
app.post('/api/upload', apiLimiter, authMiddleware, (req, res, next) => { upload.single('file')(req, res, (err) => { if (err) return res.status(400).json({ error: err.message }); if (!req.file) return res.status(400).json({ error: 'no file' }); res.json({ ok: true, path: req.file.path, filename: req.file.filename, size: req.file.size }); }); });

// ── F-21 uploads ──
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100*1024*1024 } });
app.post('/api/files/upload', apiLimiter, authMiddleware, (req, res, next) => { fileUpload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message }); if (!req.file) return res.status(400).json({ error: 'no file' });
  const dd = new Date().toISOString().slice(0,10); const ud = join(UPLOADS_DIR, dd); if (!existsSync(ud)) mkdirSync(ud, { recursive: true });
  const on = req.body.originalName || req.file.originalname; const safe = on.replace(/[<>:"|?*\\/\x00-\x1f]/g, '_'); const fp = join(ud, safe);
  req.query.overwrite === '1' ? (() => {})() : (() => { if (existsSync(fp)) return res.status(409).json({ error: 'file exists', filename: safe, message: `文件 "${safe}" 已存在` }); })();
  try { writeFileSync(fp, req.file.buffer); console.log('[Upload]', safe, '→', fp); res.json({ ok: true, filename: safe, url: `/uploads/${dd}/${safe}`, fullPath: fp, size: req.file.size, originalName: on }); } catch (e) { res.status(500).json({ error: e.message }); }
}); });
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/api/files', apiLimiter, authMiddleware, (req, res) => {
  try { const result = []; readdirSync(UPLOADS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort((a,b) => b.localeCompare(a)).forEach(dd => { const dp = join(UPLOADS_DIR, dd); const files = readdirSync(dp, { withFileTypes: true }).filter(e => e.isFile()).map(e => { const s = statSync(join(dp, e.name)); return { name: e.name, url: `/uploads/${dd}/${e.name}`, fullPath: join(dp, e.name), size: s.size, created: s.mtimeMs }; }).sort((a,b) => b.created - a.created); if (files.length) result.push({ date: dd, files }); }); res.json(result); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/files/:date/:filename', apiLimiter, authMiddleware, (req, res) => {
  const dd = req.params.date.replace(/[^0-9-]/g, ''); const fn = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '_'); const fp = join(UPLOADS_DIR, dd, fn); if (!fp.startsWith(UPLOADS_DIR)) return res.status(400).json({ error: 'invalid path' }); try { if (existsSync(fp)) { unlinkSync(fp); res.json({ ok: true }); } else res.status(404).json({ error: 'file not found' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/files/all', apiLimiter, authMiddleware, (req, res) => { try { let dc = 0; readdirSync(UPLOADS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).forEach(dd => { const dp = join(UPLOADS_DIR, dd.name); readdirSync(dp, { withFileTypes: true }).filter(e => e.isFile()).forEach(f => { try { unlinkSync(join(dp, f.name)); dc++; } catch {} }); try { rmdirSync(dp); } catch {} }); res.json({ ok: true, deletedCount: dc }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Session / Window (safe execFile) ──
app.post('/api/sessions/:id/rename', apiLimiter, authMiddleware, (req, res) => {
  const idx = req.params.id; const session = req.query.session || TMUX_SESSION; const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' }); const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 50);
  execFile('tmux', ['rename-window', '-t', `${session}:${idx}`, safeName], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true, name: safeName }); });
});
app.get('/api/sessions/:id/output', apiLimiter, authMiddleware, (req, res) => {
  const wi = parseInt(req.params.id, 10); const session = req.query.session || TMUX_SESSION;
  const key = ptyKey(session, wi); const entry = ptyMap.get(key);
  if (!entry) return res.json({ connected: false, output: '', clients: 0 });
  res.json({ connected: true, output: entry.lastOutput.slice(-2000), clients: entry.clients.size, idleMs: Date.now() - entry.lastActivity });
});
app.get('/api/sessions/:id/scrollback', apiLimiter, authMiddleware, (req, res) => {
  const wi = parseInt(req.params.id, 10); const session = req.query.session || TMUX_SESSION;
  const lines = Math.min(parseInt(req.query.lines || '3000', 10), 10000);
  execFile('tmux', ['capture-pane', '-p', '-S', `-${lines}`, '-t', `${session}:${wi}`], (err, stdout) => { if (err) return res.status(500).json({ error: err.message }); res.json({ content: stdout.split('\n').map(l => l.trimEnd()).join('\n') }); });
});
app.get('/api/config', apiLimiter, authMiddleware, (req, res) => { res.json({ tmuxSession: TMUX_SESSION, workspaceRoot: WORKSPACE_ROOT }); });
app.get('/api/tmux-sessions', apiLimiter, authMiddleware, (req, res) => {
  execFile('tmux', ['list-sessions', '-F', '#{session_name}|#{session_windows}|#{session_attached}'], (err, stdout) => {
    if (err) return res.json([{ name: TMUX_SESSION, windows: 0, attached: false }]);
    const sessions = stdout.trim().split('\n').filter(Boolean).map(line => { const [n,w,a] = line.split('|'); return { name: n, windows: Number(w), attached: Number(a) > 0 }; });
    res.json(sessions);
  });
});

// ── Projects (safe execFile/execFileSync) ──
app.get('/api/projects', apiLimiter, authMiddleware, (req, res) => {
  execFile('tmux', ['list-sessions', '-F', '#{session_name}|#{session_windows}|#{session_attached}'], (err, stdout) => {
    if (err) return res.json([]);
    const projects = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows] = line.split('|'); let path = ''; let valid = true;
      try { execFileSync('tmux', ['show-environment', '-t', name], { encoding: 'utf8' }); } catch { valid = false; }
      if (!valid) return null;
      path = getSessionCwd(name);
      return { name, path, active: name === TMUX_SESSION, channelCount: Number(windows) || 0 };
    }).filter(Boolean); projects.reverse(); res.json(projects);
  });
});
app.get('/api/session-cwd', apiLimiter, authMiddleware, (req, res) => {
  const session = req.query.session || TMUX_SESSION;
  const cwd = getSessionCwd(session);
  res.json({ cwd, relative: cwd.startsWith(WORKSPACE_ROOT) ? cwd.slice(WORKSPACE_ROOT.length).replace(/^\/+/, '') : '' });
});
app.get('/api/projects/:name/channels', apiLimiter, authMiddleware, (req, res) => {
  const sn = req.params.name;
  execFile('tmux', ['list-windows', '-t', sn, '-F', '#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}'], (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const channels = stdout.trim().split('\n').filter(Boolean).map(line => { const p = line.split('|'); return { index: Number(p[0]), name: p[1], active: p[2]?.trim() === '1', cwd: p.slice(3).join(':') || '' }; });
    channels.reverse(); res.json({ project: sn, channels });
  });
});
app.post('/api/projects', apiLimiter, authMiddleware, (req, res) => {
  const { path, shell_type = 'claude', profile } = req.body || {}; if (!path) return res.status(400).json({ error: 'path required' });
  const cwd = path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`;
  let pn = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-'); if (!pn) pn = 'home';
  const safeName = pn.replace(/[^a-zA-Z0-9._~-]/g, '-').substring(0, 50) || 'project';
  let finalName = safeName;
  try { const ex = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim().split('\n'); let c = 1; while (ex.includes(finalName)) finalName = `${safeName}-${c++}`; } catch {}
  const pv = proxyVars(); const px = Object.entries(pv).map(([k,v]) => `export ${k}='${v}'`).join('; '); const pp = px ? `${px}; ` : '';
  let shellCmd; if (shell_type === 'bash') shellCmd = `${pp}exec zsh -i`; else if (profile) shellCmd = `${pp}bash ${shEscape(join(__dirname, 'nexus-run-claude.sh'))} ${shEscape(profile)} ${shEscape(cwd)}`; else shellCmd = `${pp}claude --dangerously-skip-permissions; exec zsh -i`;
  const dn = cwd.replace(/^\/+|\/+$/g, '').split('/').pop() || '~'; const iwn = profile ? `${dn}-${profile}` : dn;
  try { execFileSync('tmux', ['new-session', '-d', '-s', finalName, '-n', iwn, '-c', cwd, shellCmd], { stdio: 'ignore' }); setSessionCwd(finalName, cwd); for (const [k,v] of Object.entries(pv)) setTmuxEnv(finalName, k, v); } catch (err) { return res.status(500).json({ error: 'failed to create project: ' + err.message }); }
  res.json({ name: finalName, path: cwd, shell_type, profile: profile || null });
});
app.post('/api/projects/:name/channels', apiLimiter, authMiddleware, (req, res) => {
  const sn = req.params.name; const { shell_type = 'claude', profile, path: bp } = req.body || {};
  const cwd = bp ? (bp.startsWith('/') ? bp : `${WORKSPACE_ROOT}/${bp}`) : getSessionCwd(sn);
  const bn = profile || 'channel'; let cn = bn; try { const ex = execFileSync('tmux', ['list-windows', '-t', sn, '-F', '#{window_name}'], { encoding: 'utf8' }).trim().split('\n'); let c = 1; while (ex.includes(cn)) cn = `${bn}-${c++}`; } catch {}
  const pv = proxyVars(); const px = Object.entries(pv).map(([k,v]) => `export ${k}='${v}'`).join('; '); const pp = px ? `${px}; ` : '';
  let shellCmd; if (shell_type === 'bash') shellCmd = `${pp}exec zsh -i`; else if (profile) shellCmd = `${pp}bash ${shEscape(join(__dirname, 'nexus-run-claude.sh'))} ${shEscape(profile)} ${shEscape(cwd)}`; else shellCmd = `${pp}claude --dangerously-skip-permissions; exec zsh -i`;
  if (!ensureTmuxSession(sn, cwd)) return res.status(404).json({ error: `project '${sn}' not found` });
  execFile('tmux', ['new-window', '-t', sn, '-c', cwd, '-n', cn, shellCmd], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ name: cn, cwd, shell_type, profile: profile || null, project: sn }); });
});
app.post('/api/projects/:name/activate', apiLimiter, authMiddleware, (req, res) => {
  const sn = req.params.name; if (!tmuxHasSession(sn)) return res.status(404).json({ error: 'project not found' });
  let lc = getLastChannel(sn);
  if (lc !== null) { try { const w = execFileSync('tmux', ['list-windows', '-t', sn, '-F', '#I'], { encoding: 'utf8' }).trim().split('\n'); if (!w.includes(String(lc))) lc = null; } catch { lc = null; } }
  res.json({ active: true, project: sn, lastChannel: lc });
});
app.post('/api/projects/:name/rename', apiLimiter, authMiddleware, (req, res) => {
  const oldName = req.params.name; const { name: newName } = req.body || {}; if (!newName || !newName.trim()) return res.status(400).json({ error: 'new name required' });
  const sn = newName.trim().replace(/[^a-zA-Z0-9_\-]/g, ''); if (!sn) return res.status(400).json({ error: 'invalid name format' });
  if (!tmuxHasSession(oldName)) return res.status(404).json({ error: 'project not found' });
  if (tmuxHasSession(sn)) return res.status(409).json({ error: 'project name already exists' });
  execFile('tmux', ['rename-session', '-t', oldName, sn], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true, oldName, newName: sn }); });
});
app.delete('/api/projects/:name', apiLimiter, authMiddleware, (req, res) => {
  const sn = req.params.name; if (!tmuxHasSession(sn)) return res.status(404).json({ error: 'project not found' });
  execFile('tmux', ['kill-session', '-t', sn], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});

// ── Sessions ──
app.get('/api/sessions', apiLimiter, authMiddleware, (req, res) => {
  const session = req.query.session || TMUX_SESSION;
  execFile('tmux', ['list-windows', '-t', session, '-F', '#{window_index}|#{window_name}|#{window_active}'], (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const windows = stdout.trim().split('\n').filter(Boolean).map(line => { const [i,n,a] = line.split('|'); return { index: Number(i), name: n, active: a?.trim() === '1' }; });
    res.json({ session, windows });
  });
});
app.delete('/api/sessions/:id', apiLimiter, authMiddleware, (req, res) => {
  const idx = req.params.id; const session = req.query.session || TMUX_SESSION;
  const wc = execFileSync('tmux', ['list-windows', '-t', session, '-F', '#{window_index}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  if (wc <= 1) execFile('tmux', ['new-window', '-t', session, '-n', 'shell', 'zsh'], () => { execFile('tmux', ['kill-window', '-t', `${session}:${idx}`], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); }); });
  else execFile('tmux', ['kill-window', '-t', `${session}:${idx}`], (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ ok: true }); });
});
app.post('/api/sessions/:id/attach', apiLimiter, authMiddleware, (req, res) => {
  const idx = req.params.id; const session = req.query.session || TMUX_SESSION;
  execFile('tmux', ['select-window', '-t', `${session}:${idx}`], (err) => {
    if (err) return res.status(500).json({ error: err.message }); setLastChannel(session, idx); res.json({ ok: true });
  });
});

// ── Tasks ──
function loadTasks() { try { if (existsSync(TASKS_FILE)) return JSON.parse(readFileSync(TASKS_FILE, 'utf8')); } catch {} return []; }
const MAX_TASKS = 200;
function saveTasks(tasks) { const t = tasks.length > MAX_TASKS ? tasks.slice(-MAX_TASKS) : tasks; const tmp = TASKS_FILE + '.tmp'; writeFileSync(tmp, JSON.stringify(t, null, 2)); renameSync(tmp, TASKS_FILE); }
function updateTask(id, u) { const t = loadTasks(); const i = t.findIndex(x => x.id === id); if (i !== -1) Object.assign(t[i], u); saveTasks(t); }
function runTask(prompt, cwd, opts = {}) {
  const { sessionName, source = 'web', tmuxSession, profile, onChunk, onDone } = opts;
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; const createdAt = new Date().toISOString();
  const rec = { id: taskId, session_name: sessionName || '', prompt: prompt.slice(0,1000), status: 'running', output: '', error: '', createdAt, source, ...(tmuxSession && tmuxSession !== TMUX_SESSION ? { tmux_session: tmuxSession } : {}) };
  saveTasks([...loadTasks(), rec]);
  const pe = CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY } : {};
  const args = ['-p', prompt, '--dangerously-skip-permissions']; if (profile) args.push('--profile', profile);
  const child = spawn('claude', args, { cwd, env: { ...process.env, ...pe }, stdio: ['ignore','pipe','pipe'] });
  let output = '', errorOutput = '';
  child.stdout.on('data', d => { const c = d.toString(); output += c; onChunk?.(c, false); });
  child.stderr.on('data', d => { const c = d.toString(); errorOutput += c; onChunk?.(c, true); });
  child.on('close', code => { const st = code === 0 ? 'success' : 'error'; updateTask(taskId, { status: st, output: output.slice(-10000), error: errorOutput.slice(-1000), completedAt: new Date().toISOString(), exitCode: code }); onDone?.({ taskId, status: st, output, errorOutput, exitCode: code }); });
  return { taskId, kill: () => { if (!child.killed) child.kill(); } };
}
app.get('/api/tasks', apiLimiter, authMiddleware, (req, res) => { const t = loadTasks(); res.json(t.slice(-50).reverse()); });
app.delete('/api/tasks/:id', apiLimiter, authMiddleware, (req, res) => { saveTasks(loadTasks().filter(t => t.id !== req.params.id)); res.json({ ok: true }); });
app.post('/api/tasks', apiLimiter, authMiddleware, (req, res) => {
  const { session_name, prompt, profile, tmux_session } = req.body || {}; if (!prompt) return res.status(400).json({ error: 'prompt required' });
  let cwd = WORKSPACE_ROOT; const ts = tmux_session || TMUX_SESSION;
  try { const w = execFileSync('tmux', ['list-windows', '-t', ts, '-F', '#I:#W:#{pane_current_path}'], { encoding: 'utf8' }).trim().split('\n'); for (const line of w) { const p = line.split(':'); if (p[1] === session_name && p.slice(2).join(':')) { cwd = p.slice(2).join(':'); break; } } } catch {}
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
  const { taskId, kill } = runTask(prompt, cwd, { sessionName: session_name, source: 'web', tmuxSession: ts, profile,
    onChunk: (c, e) => res.write(`event: ${e?'error':'output'}\ndata: ${JSON.stringify({chunk:c})}\n\n`),
    onDone: ({ taskId: tid, status, exitCode }) => { res.write(`event: done\ndata: ${JSON.stringify({taskId:tid,status,exitCode})}\n\n`); res.end(); },
  });
  res.write(`event: start\ndata: ${JSON.stringify({taskId,session_name,prompt,createdAt:new Date().toISOString()})}\n\n`); req.on('close', kill);
});

// ── Telegram ──
function telegramReq(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) return Promise.resolve(null);
  return new Promise(resolve => {
    const body = JSON.stringify(payload); const opt = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const rq = https.request(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, opt, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
    rq.on('error', e => { console.error(`Telegram ${method}:`, e.message); resolve(null); }); rq.write(body); rq.end();
  });
}
async function telegramSend(chatId, text) { const r = await telegramReq('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' }); return r?.result?.message_id ?? null; }
function telegramEdit(chatId, msgId, text) { if (msgId) telegramReq('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown' }); }
function downloadTGFile(fileId, destDir, filename) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { const info = JSON.parse(d); if (!info.ok) return reject(new Error(info.description)); const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${info.result.file_path}`;
          https.get(fileUrl, fres => { const chunks = []; fres.on('data', c => chunks.push(c)); fres.on('end', () => { writeFileSync(join(destDir, filename), Buffer.concat(chunks)); resolve({ path: join(destDir, filename), size: chunks.reduce((a,c) => a+c.length, 0) }); }); fres.on('error', reject); }).on('error', reject);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
app.post('/api/webhooks/telegram', (req, res) => {
  if (TELEGRAM_WEBHOOK_SECRET) { const s = req.headers['x-telegram-bot-api-secret-token']; if (s !== TELEGRAM_WEBHOOK_SECRET) return res.status(403).json({ error: 'forbidden' }); }
  if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ error: 'Telegram not configured' });
  const update = req.body; res.json({ ok: true }); const message = update.message || update.edited_message; if (!message) return; const chatId = message.chat.id;
  if (message.text?.trim() === '/start') { telegramSend(chatId, '👋 *Nexus Bot* 已就绪\n\n发送文字用 `claude -p` 执行。\n\n`/sessions` — 窗口列表\n`/switch <编号>` — 切换窗口'); return; }
  if (message.text?.trim() === '/sessions') { execFile('tmux', ['list-windows', '-t', TMUX_SESSION, '-F', '#{window_index}|#{window_name}|#{window_active}'], (err, stdout) => {
    if (err) return telegramSend(chatId, '❌ 无法获取会话列表: ' + err.message);
    const lines = stdout.trim().split('\n').filter(Boolean).map(line => { const [i,n,a] = line.split('|'); return `${a?.trim()==='1'?'▶':'  '} \`${i}: ${n}\``; });
    telegramSend(chatId, '*当前 tmux 窗口:*\n' + lines.join('\n')); }); return;
  }
  if (message.text?.trim().startsWith('/switch ')) { const t = message.text.trim().slice(8).replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!t) return telegramSend(chatId, '❌ 无效名称');
    execFile('tmux', ['select-window', '-t', `${TMUX_SESSION}:${t}`], err => telegramSend(chatId, err ? `❌ ${err.message}` : `✅ 已切换到 \`${t}\``)); return;
  }
  async function runClaude(prompt, c, sn) {
    const msgId = await telegramSend(chatId, `⏳ *执行中*（\`${sn||'default'}\`）\n\n_等待输出..._`);
    let cur='', curErr='', curId=null; const iv=setInterval(()=>{if(cur||curErr&&msgId)telegramEdit(chatId,msgId,`⏳ *执行中*\n\`\`\`\n${((cur||curErr).length>3000?'…'+(cur||curErr).slice(-3000):(cur||curErr))}\n\`\`\``);if(curId)updateTask(curId,{output:cur.slice(-10000),error:curErr.slice(-1000)});},5000);
    const {taskId}=runTask(prompt,c,{sessionName:sn||'telegram',source:'telegram',onChunk:(c,e)=>{if(e)curErr+=c;else cur+=c;},onDone:()=>{clearInterval(iv);const r=(cur.trim()||curErr.trim()||'(无输出)');const tr=r.length>3800?r.slice(0,3800)+'\n\n…(截断)':r;if(msgId)telegramEdit(chatId,msgId,`✅ *完成*\n\`\`\`\n${tr}\n\`\`\``);else telegramSend(chatId,`✅ *完成*\n\`\`\`\n${tr}\n\`\`\``);}}); curId=taskId;
  }
  if (message.photo || message.document) { (async ()=>{ try { let c=WORKSPACE_ROOT; try{const w=execFileSync('tmux',['list-windows','-t',TMUX_SESSION,'-F','#I:#W:#{pane_current_path}:#{window_active}'],{encoding:'utf8'}).trim().split('\n');for(const l of w){const p=l.split(':');if(p[p.length-1]?.trim()==='1'){c=p.slice(2,p.length-1).join(':');break;}}}catch{}let fid,fn;if(message.photo){fid=message.photo[message.photo.length-1].file_id;fn=`tg_photo_${Date.now()}.jpg`;}else{fid=message.document.file_id;fn=message.document.file_name||`tg_file_${Date.now()}`;}telegramSend(chatId,`⬇️ 下载到 \`${c}\`...`);const r=await downloadTGFile(fid,c,fn);telegramSend(chatId,`✅ 已保存\`\`\`\n${r.path}\n\`\`\`\n大小: ${(r.size/1024).toFixed(1)} KB`);if(message.caption?.trim())runClaude(message.caption.trim(),c,'telegram').catch(()=>{});}catch(e){telegramSend(chatId,'❌ 失败: '+e.message);} })(); return; }
  const text = message.text?.trim(); if (!text) return; let c=WORKSPACE_ROOT, sn=TELEGRAM_DEFAULT_SESSION;
  try{const w=execFileSync('tmux',['list-windows','-t',TMUX_SESSION,'-F','#I:#W:#{pane_current_path}'],{encoding:'utf8'}).trim().split('\n');for(const l of w){const p=l.split(':');if(TELEGRAM_DEFAULT_SESSION&&p[1]===TELEGRAM_DEFAULT_SESSION){c=p.slice(2).join(':');sn=p[1];break;}}if(!sn){const a=execFileSync('tmux',['list-windows','-t',TMUX_SESSION,'-F','#I:#W:#{pane_current_path}:#{window_active}'],{encoding:'utf8'}).trim().split('\n');for(const l of a){const p=l.split(':');if(p[p.length-1]?.trim()==='1'){sn=p[1];c=p.slice(2,p.length-1).join(':');break;}}}}catch{}
  runClaude(text,c,sn).catch(()=>{});
});
app.get('/api/telegram/setup', apiLimiter, authMiddleware, (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  const wu = `${req.protocol}://${req.get('host')}/api/webhooks/telegram`; const sp = TELEGRAM_WEBHOOK_SECRET ? `&secret_token=${TELEGRAM_WEBHOOK_SECRET}` : '';
  https.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(wu)}${sp}`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res.json({webhookUrl:wu,telegramResponse:JSON.parse(d)});}catch{res.json({webhookUrl:wu,raw:d});}}); }).on('error',e=>res.status(500).json({error:e.message}));
});

// ── Health check ──
app.get('/health', (req, res) => { let t = false; try { if (tmuxHasSession(TMUX_SESSION)) t = true; } catch {} res.json({ status: 'ok', uptime: process.uptime(), ptyCount: ptyMap.size, tmux: t, version: '4.4.2' }); });

// ── SPA fallback ──
app.get('*', (req, res) => { const idx = join(__dirname, 'frontend', 'dist', 'index.html'); res.sendFile(idx, err => { if (err) res.status(404).send('Not found — run: cd frontend && npm run build'); }); });

// ── PTY management ──
function ensureWindowPty(session, windowIndex, defaultSession) {
  const key = ptyKey(session, windowIndex); if (ptyMap.has(key)) return { key, entry: ptyMap.get(key) };
  if (!tmuxHasSession(session)) { console.log(`Session '${session}' not found`); return { key: null, entry: null, error: 'session_not_found' }; }
  let tw = windowIndex; try { const w = execFileSync('tmux', ['list-windows', '-t', session, '-F', '#I'], { encoding: 'utf8' }).trim().split('\n'); if (!w.includes(String(windowIndex))) { tw = w.length > 0 ? parseInt(w[0], 10) : 0; if (w.length === 0) try { execFileSync('tmux', ['new-window', '-t', session, '-n', 'shell', 'zsh'], { stdio: 'ignore' }); } catch {} } } catch { tw = 0; }
  const ak = ptyKey(session, tw); if (ptyMap.has(ak)) return { key: ak, entry: ptyMap.get(ak) };
  const ppy = pty.spawn('tmux', ['attach-session', '-t', `${session}:${tw}`], { name: 'xterm-256color', cols: 120, rows: 30, env: { ...process.env, LANG: 'C.UTF-8', TERM: 'xterm-256color' } });
  const entry = { pty: ppy, clients: new Set(), clientSizes: new Map(), lastOutput: '', lastActivity: Date.now() };
  ptyMap.set(ak, entry);
  ppy.onData(data => { const e = ptyMap.get(ak); if (!e) return; e.lastOutput = (e.lastOutput + data).slice(-10000); e.lastActivity = Date.now(); for (const ws of e.clients) if (ws.readyState === 1) ws.send(data); });
  ppy.onExit(({ exitCode }) => { console.log(`PTY ${ak} exited ${exitCode}`); ptyMap.delete(ak); try { const l = execFileSync('tmux', ['list-windows', '-t', session, '-F', '#I'], { encoding: 'utf8' }).trim().split('\n'); if (l.includes(String(tw))) setTimeout(() => ensureWindowPty(session, tw, defaultSession), 100); } catch {} });
  return { key: ak, entry };
}

// ── WS server ──
const server = createServer(app); const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x'); const token = url.searchParams.get('token');
  const windowIndex = parseInt(url.searchParams.get('window') || '0', 10) || 0;
  const session = url.searchParams.get('session') || TMUX_SESSION;
  try { jwt.verify(token, JWT_SECRET); } catch { ws.close(4001, 'unauthorized'); return; }
  const { key, entry } = ensureWindowPty(session, windowIndex); entry.clients.add(ws);
  console.log(`Client connected to ${key} (${entry.clients.size})`);
  if (entry.lastOutput) ws.send(entry.lastOutput.slice(-2000));
  ws.on('message', msg => {
    const ent = ptyMap.get(key); if (!ent) return; const str = typeof msg === 'string' ? msg : msg.toString(); let isResize = false;
    try { const data = JSON.parse(str); if (data && data.type === 'resize' && data.cols && data.rows) { isResize = true; ent.clientSizes.set(ws, { cols: Math.max(Number(data.cols),10), rows: Math.max(Number(data.rows),5) }); ent.pty.resize(Math.max(Number(data.cols),10), Math.max(Number(data.rows),5)); } } catch {}
    if (!isResize) ent.pty.write(str);
  });
  ws.on('close', () => { const ent = ptyMap.get(key); if (ent) { ent.clients.delete(ws); ent.clientSizes.delete(ws); console.log(`Client disconnected from ${key} (${ent.clients.size})`);
    if (ent.clients.size > 0 && ent.clientSizes.size > 0) { let mc=Infinity,mr=Infinity; for (const s of ent.clientSizes.values()){if(s.cols<mc)mc=s.cols;if(s.rows<mr)mr=s.rows;} if(mc!==Infinity)ent.pty.resize(Math.max(mc,10),Math.max(mr,5)); }
    ent.cleanupTimer = setTimeout(() => { const e = ptyMap.get(key); if (e && e.clients.size === 0 && Date.now() - e.lastActivity > 300000) { e.pty.kill(); ptyMap.delete(key); console.log(`PTY ${key} cleaned up`); } }, 300000);
  }});
  ws.on('error', err => { console.error('WS error:', err.message); const ent = ptyMap.get(key); if (ent) { ent.clients.delete(ws); ent.clientSizes.delete(ws); } });
});

// ── Startup cleanup & listen ──
try { const st = loadTasks(); let changed = false; for (const t of st) { if (t.status === 'running') { t.status = 'error'; t.error = '(服务重启，任务中断)'; t.completedAt = new Date().toISOString(); changed = true; } } if (changed) saveTasks(st); } catch {}

// Graceful shutdown
function shutdown(sig) {
  console.log(`${sig} — shutting down...`);
  try { const st=loadTasks(); let c=false; for(const t of st) if(t.status==='running'){t.status='error';t.error='(关机关闭)';t.completedAt=new Date().toISOString();c=true;} if(c)saveTasks(st); } catch {}
  wss.clients.forEach(ws => { try { ws.close(1001, 'Server shutting down'); } catch {} });
  for (const [,e] of ptyMap) { try { e.pty.kill(); } catch {} }
  server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Nexus v4.4.2 listening on :${PORT}`);
  console.log(`tmux session: ${TMUX_SESSION}`);
  console.log(`workspace: ${WORKSPACE_ROOT}`);
  console.log(`Default session: '${TMUX_SESSION}' (create via API if needed)`);
});
