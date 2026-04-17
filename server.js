// server.js — Nexus WebSocket tmux 桥接服务
import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createServer } from 'node:http';
import { exec, spawn, execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, normalize, isAbsolute, basename } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, rmdirSync, renameSync, cpSync, rmSync } from 'fs';
import { readdir, stat as statAsync } from 'fs/promises';
import https from 'node:https';
import multer from 'multer';

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

const __dirname = dirname(fileURLToPath(import.meta.url));

// 持久化数据目录（通过 Docker volume 挂载，重建容器不丢失）
const DATA_DIR = join(__dirname, 'data');
const TOOLBAR_CONFIG_FILE = join(DATA_DIR, 'toolbar-config.json');
const CONFIGS_DIR = join(DATA_DIR, 'configs');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');
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
  CLAUDE_PROXY = '',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_DEFAULT_SESSION = '',
  GITHUB_REPO = 'librae8226/nexus4cc',
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

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    const ok = await bcrypt.compare(password, ACC_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    const token = jwt.sign({}, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
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
  const proxyVars = {
    ...(process.env.HTTP_PROXY  ? { HTTP_PROXY:  process.env.HTTP_PROXY  } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.ALL_PROXY   ? { ALL_PROXY:   process.env.ALL_PROXY   } : {}),
    ...(process.env.http_proxy  ? { http_proxy:  process.env.http_proxy  } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
    ...(CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY, NEXUS_PROXY: CLAUDE_PROXY } : {}),
  };
  const proxyExports = Object.entries(proxyVars).map(([k, v]) => `export ${k}='${v}'`).join('; ');
  const proxyPrefix = proxyExports ? `${proxyExports}; ` : '';

  let shellCmd;
  if (shell_type === 'bash') {
    shellCmd = buildInteractiveShellCmd(proxyPrefix);
  } else {
    if (profile) {
      const runScript = join(__dirname, 'nexus-run-claude.sh');
      shellCmd = `${proxyPrefix}bash "${runScript}" ${profile} ${cwd}`;
    } else {
      shellCmd = `${proxyPrefix}claude --dangerously-skip-permissions; ${INTERACTIVE_SHELL_CMD}`;
    }
  }

  // 确保 tmux session 存在
  try {
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
  const proxyVars = {
    ...(process.env.HTTP_PROXY  ? { HTTP_PROXY:  process.env.HTTP_PROXY  } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.ALL_PROXY   ? { ALL_PROXY:   process.env.ALL_PROXY   } : {}),
    ...(process.env.http_proxy  ? { http_proxy:  process.env.http_proxy  } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
    ...(CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY, NEXUS_PROXY: CLAUDE_PROXY } : {}),
  };

  const proxyExports = Object.entries(proxyVars).map(([k, v]) => `export ${k}='${v}'`).join('; ');
  const proxyPrefix = proxyExports ? `${proxyExports}; ` : '';

  let shellCmd;
  if (shell_type === 'bash') {
    shellCmd = buildInteractiveShellCmd(proxyPrefix);
  } else {
    if (profile) {
      const runScript = join(__dirname, 'nexus-run-claude.sh');
      shellCmd = `${proxyPrefix}bash "${runScript}" ${profile} ${cwd}`;
    } else {
      shellCmd = `${proxyPrefix}claude --dangerously-skip-permissions; ${INTERACTIVE_SHELL_CMD}`;
    }
  }

  // 确保 tmux session 存在
  try {
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
    const dirents = await readdir(p, { withFileTypes: true })
    const visible = dirents.filter(e => !e.name.startsWith('.'))
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

// GET /api/workspace/file — 读取文件内容
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
    const content = readFileSync(p, 'utf8')
    res.json({ path: p, content })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/workspace/file — 保存文件内容
app.put('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    let { path: filePath, content = '' } = req.body
    if (!filePath) return res.status(400).json({ error: 'path required' })
    if (!isAbsolute(filePath)) filePath = join(WORKSPACE_ROOT, filePath)
    filePath = normalize(filePath)
    if (filePath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
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

// 读取指定 session 的 uploads 目录（基于 tmux NEXUS_CWD 环境变量）
function getWorkspaceUploadsDir(session = TMUX_SESSION) {
  let cwd = WORKSPACE_ROOT
  try {
    const out = execSync(`tmux show-environment -t ${session} NEXUS_CWD 2>/dev/null`).toString().trim()
    const m = out.match(/^NEXUS_CWD=(.+)$/)
    if (m) cwd = m[1]
  } catch {}
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
  if (!normalized.startsWith(WORKSPACE_ROOT)) return res.status(403).json({ error: 'access denied' })
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
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 50)
  exec(`tmux rename-window -t ${session}:${index} "${safeName}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ ok: true, name: safeName })
  })
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
  const target = `${session}:${windowIndex}`

  // Get pane height first, then capture content and dedup ghost frames
  exec(`tmux display -p -t ${target} '#{pane_height}' 2>/dev/null`, (err, phOut) => {
    const paneHeight = parseInt(phOut?.trim(), 10) || 50
    exec(`tmux capture-pane -e -p -S -${lines} -t ${target} 2>/dev/null`, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const rawLines = stdout.split('\n').map(l => l.trimEnd())
      const content = dedupScrollback(rawLines, paneHeight).join('\n')
      res.json({ content })
    })
  })
})

// Remove "ghost frame" duplicates from scrollback caused by full-screen app re-renders.
// Ghost frames are paneHeight-sized blocks pushed into scrollback when a full-screen app
// redraws without alternate screen. Detection is purely content-based: hash each line,
// compute rolling block fingerprints, and remove earlier duplicates. Zero hardcoded patterns.
function dedupScrollback(lines, paneHeight) {
  if (lines.length <= paneHeight * 2) return lines

  const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const scrollbackEnd = lines.length - paneHeight

  // Hash each line (stripped of ANSI), using djb2
  const lineHashes = new Int32Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    const s = stripAnsi(lines[i])
    let h = 5381
    for (let c = 0; c < s.length; c++) h = ((h << 5) + h + s.charCodeAt(c)) | 0
    lineHashes[i] = h
  }

  // Block fingerprint: XOR of weighted line hashes over paneHeight lines
  function blockFp(start) {
    let fp = 0
    for (let i = start; i < start + paneHeight && i < lines.length; i++) {
      fp = (fp * 31 + lineHashes[i]) | 0
    }
    return fp
  }

  // Build map: fingerprint → last seen position (we keep the latest occurrence)
  const seen = new Map()
  const dupes = []

  for (let i = 0; i <= scrollbackEnd - paneHeight; i += paneHeight) {
    const fp = blockFp(i)
    if (seen.has(fp)) {
      // Verify: sample 8 lines to rule out hash collision
      const prev = seen.get(fp)
      const step = Math.max(1, paneHeight >> 3)
      let match = true
      for (let s = 0; s < paneHeight; s += step) {
        if (lineHashes[prev + s] !== lineHashes[i + s]) { match = false; break }
      }
      if (match) dupes.push(prev)
    }
    seen.set(fp, i)
  }

  if (dupes.length === 0) return lines

  const keep = new Uint8Array(lines.length).fill(1)
  for (const start of dupes) {
    const end = Math.min(start + paneHeight, scrollbackEnd)
    for (let j = start; j < end; j++) keep[j] = 0
  }

  return lines.filter((_, idx) => keep[idx])
}

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
  const proxyVars = {
    ...(process.env.HTTP_PROXY  ? { HTTP_PROXY:  process.env.HTTP_PROXY  } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.ALL_PROXY   ? { ALL_PROXY:   process.env.ALL_PROXY   } : {}),
    ...(process.env.http_proxy  ? { http_proxy:  process.env.http_proxy  } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
    ...(CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY, NEXUS_PROXY: CLAUDE_PROXY } : {}),
  }
  const proxyExports = Object.entries(proxyVars).map(([k, v]) => `export ${k}='${v}'`).join('; ')
  const proxyPrefix = proxyExports ? `${proxyExports}; ` : ''

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
      shellCmd = `${proxyPrefix}claude --dangerously-skip-permissions || echo; echo '[Nexus] claude 退出或启动失败，请确认已 claude login 或配置 API key'; ${INTERACTIVE_SHELL_CMD}`
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
  const proxyVars = {
    ...(process.env.HTTP_PROXY  ? { HTTP_PROXY:  process.env.HTTP_PROXY  } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.ALL_PROXY   ? { ALL_PROXY:   process.env.ALL_PROXY   } : {}),
    ...(process.env.http_proxy  ? { http_proxy:  process.env.http_proxy  } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
    ...(CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY, NEXUS_PROXY: CLAUDE_PROXY } : {}),
  }
  const proxyExports = Object.entries(proxyVars).map(([k, v]) => `export ${k}='${v}'`).join('; ')
  const proxyPrefix = proxyExports ? `${proxyExports}; ` : ''

  let shellCmd
  if (shell_type === 'bash') {
    shellCmd = buildInteractiveShellCmd(proxyPrefix)
  } else {
    if (profile) {
      const runScript = join(__dirname, 'nexus-run-claude.sh')
      shellCmd = `${proxyPrefix}bash '${runScript}' ${profile} '${cwd}' || echo; echo '[Nexus] claude 退出或启动失败，fallback 到 ${INTERACTIVE_SHELL}（可直接输入 claude 重试）'; ${INTERACTIVE_SHELL_CMD}`
    } else {
      shellCmd = `${proxyPrefix}claude --dangerously-skip-permissions || echo; echo '[Nexus] claude 退出或启动失败，请确认已 claude login 或配置 API key'; ${INTERACTIVE_SHELL_CMD}`
    }
  }

  // 确保 session 存在
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
  const sanitizedNewName = newName.trim().replace(/[^a-zA-Z0-9_\-]/g, '')
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
  exec(`tmux rename-session -t ${oldName} ${sanitizedNewName}`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ ok: true, oldName, newName: sanitizedNewName })
  })
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
          if (err) return res.status(500).json({ error: err.message })
          res.json({ ok: true })
        })
      })
    } else {
      exec(`tmux kill-window -t ${session}:${index}`, (err) => {
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

// ---- Tasks API (F-13: claude -p 非交互派发) ----

function loadTasks() {
  try {
    if (existsSync(TASKS_FILE)) {
      return JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
    }
  } catch {}
  return []
}

const MAX_TASKS = 200

function saveTasks(tasks) {
  // 保留最新的 MAX_TASKS 条，防止文件无限增长
  const trimmed = tasks.length > MAX_TASKS ? tasks.slice(-MAX_TASKS) : tasks
  writeFileSync(TASKS_FILE, JSON.stringify(trimmed, null, 2))
}

function updateTask(id, updates) {
  const tasks = loadTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx !== -1) {
    Object.assign(tasks[idx], updates)
    saveTasks(tasks)
  }
}

/**
 * F-17: 统一任务执行入口 — spawn claude -p, 管理任务记录, 回调给各渠道
 * @param {string} prompt
 * @param {string} cwd
 * @param {{ sessionName?: string, source?: string, tmuxSession?: string, profile?: string, onChunk?: (chunk:string,isErr:boolean)=>void, onDone?: (result:object)=>void }} opts
 * @returns {string} taskId
 */
function runTask(prompt, cwd, opts = {}) {
  const { sessionName, source = 'web', tmuxSession, profile, onChunk, onDone } = opts
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const createdAt = new Date().toISOString()

  const taskRecord = {
    id: taskId,
    session_name: sessionName || '',
    prompt: prompt.slice(0, 1000),
    status: 'running',
    output: '',
    error: '',
    createdAt,
    source,
    ...(tmuxSession && tmuxSession !== TMUX_SESSION ? { tmux_session: tmuxSession } : {}),
  }
  const allTasks = loadTasks()
  allTasks.push(taskRecord)
  saveTasks(allTasks)

  const proxyEnv = CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY } : {}
  const claudeArgs = ['-p', prompt, '--dangerously-skip-permissions']
  if (profile) claudeArgs.push('--profile', profile)
  const child = spawn('claude', claudeArgs, {
    cwd,
    env: { ...process.env, ...proxyEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  let errorOutput = ''

  child.stdout.on('data', (data) => {
    const chunk = data.toString()
    output += chunk
    onChunk?.(chunk, false)
  })
  child.stderr.on('data', (data) => {
    const chunk = data.toString()
    errorOutput += chunk
    onChunk?.(chunk, true)
  })

  child.on('close', (code) => {
    const status = code === 0 ? 'success' : 'error'
    updateTask(taskId, {
      status,
      output: output.slice(-10000),
      error: errorOutput.slice(-1000),
      completedAt: new Date().toISOString(),
      exitCode: code,
    })
    onDone?.({ taskId, status, output, errorOutput, exitCode: code })
  })

  return { taskId, kill: () => { if (!child.killed) child.kill() } }
}

// GET /api/tasks — 获取任务历史
app.get('/api/tasks', authMiddleware, (req, res) => {
  const tasks = loadTasks()
  res.json(tasks.slice(-50).reverse()) // 最近50条，倒序
})

// DELETE /api/tasks/:id — 删除单条任务记录
app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  const tasks = loadTasks()
  const filtered = tasks.filter(t => t.id !== req.params.id)
  saveTasks(filtered)
  res.json({ ok: true })
})

// POST /api/tasks — 创建新任务，SSE 流式返回
app.post('/api/tasks', authMiddleware, (req, res) => {
  const { session_name, prompt, profile, tmux_session } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'prompt required' })

  // 找到 session 对应的 cwd
  let cwd = WORKSPACE_ROOT
  const targetSession = tmux_session || TMUX_SESSION
  try {
    const windows = execSync(`tmux list-windows -t ${targetSession} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
    for (const line of windows) {
      const parts = line.split(':')
      const name = parts[1]
      const path = parts.slice(2).join(':')
      if (name === session_name && path) { cwd = path; break }
    }
  } catch {}

  // 设置 SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const createdAt = new Date().toISOString()
  const { taskId, kill } = runTask(prompt, cwd, {
    sessionName: session_name,
    source: 'web',
    tmuxSession: targetSession,
    profile,
    onChunk: (chunk, isErr) => {
      const ev = isErr ? 'error' : 'output'
      res.write(`event: ${ev}\ndata: ${JSON.stringify({ chunk })}\n\n`)
    },
    onDone: ({ taskId: tid, status, exitCode }) => {
      res.write(`event: done\ndata: ${JSON.stringify({ taskId: tid, status, exitCode })}\n\n`)
      res.end()
    },
  })

  res.write(`event: start\ndata: ${JSON.stringify({ taskId, session_name, prompt, createdAt })}\n\n`)
  req.on('close', kill)
})


// ---- Telegram Bot Webhook (F-16) ----

function telegramRequest(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) return Promise.resolve(null)
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      options,
      (res) => {
        let data = ''
        res.on('data', d => data += d)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      }
    )
    req.on('error', (e) => { console.error(`Telegram ${method} error:`, e.message); resolve(null) })
    req.write(body)
    req.end()
  })
}

// Returns the sent message_id (or null)
async function telegramSend(chatId, text) {
  const result = await telegramRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' })
  return result?.result?.message_id ?? null
}

// Edit an existing message in-place (silently ignores errors)
function telegramEdit(chatId, messageId, text) {
  if (!messageId) return
  telegramRequest('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' })
}

// 下载 Telegram 文件到指定目录
function downloadTelegramFile(fileId, destDir, filename) {
  return new Promise((resolve, reject) => {
    // 1. 获取 file_path
    const infoUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    https.get(infoUrl, (res) => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try {
          const info = JSON.parse(data)
          if (!info.ok) return reject(new Error('getFile failed: ' + info.description))
          const filePath = info.result.file_path
          const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`

          // 2. 下载文件
          https.get(fileUrl, (fres) => {
            const chunks = []
            fres.on('data', c => chunks.push(c))
            fres.on('end', () => {
              const buf = Buffer.concat(chunks)
              const destPath = join(destDir, filename)
              writeFileSync(destPath, buf)
              resolve({ path: destPath, size: buf.length })
            })
            fres.on('error', reject)
          }).on('error', reject)
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

// POST /api/webhooks/telegram — Telegram Bot webhook
app.post('/api/webhooks/telegram', (req, res) => {
  // 验证 secret（如果配置了）
  if (TELEGRAM_WEBHOOK_SECRET) {
    const secret = req.headers['x-telegram-bot-api-secret-token']
    if (secret !== TELEGRAM_WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'forbidden' })
    }
  }

  if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ error: 'Telegram not configured' })

  const update = req.body
  res.json({ ok: true }) // 立即返回，避免 Telegram 重试

  const message = update.message || update.edited_message
  if (!message) return

  const chatId = message.chat.id

  // /start 欢迎消息
  if (message.text?.trim() === '/start') {
    telegramSend(chatId, '👋 *Nexus Bot* 已就绪\n\n发送任意文字，我会用 `claude -p` 在你的服务器上执行并回复结果。\n\n发送图片或文件，我会保存到当前 session 目录。\n\n`/sessions` — 查看 tmux 窗口列表\n`/switch <编号>` — 切换目标窗口')
    return
  }

  // /sessions 列出当前窗口
  if (message.text?.trim() === '/sessions') {
    exec(`tmux list-windows -t ${TMUX_SESSION} -F "#{window_index}|#{window_name}|#{window_active}"`, (err, stdout) => {
      if (err) {
        telegramSend(chatId, '❌ 无法获取会话列表: ' + err.message)
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [idx, name, active] = line.split('|')
        return `${active?.trim() === '1' ? '▶' : '  '} \`${idx}: ${name}\``
      })
      telegramSend(chatId, '*当前 tmux 窗口:*\n' + lines.join('\n') + '\n\n用 `/switch <编号>` 切换')
    })
    return
  }

  // /switch <index|name> — 切换 active tmux 窗口
  if (message.text?.trim().startsWith('/switch ')) {
    const raw = message.text.trim().slice('/switch '.length).trim()
    const target = raw.replace(/[^a-zA-Z0-9_\-]/g, '') // 只允许安全字符
    if (!target) {
      telegramSend(chatId, '❌ 无效的窗口名称，只允许字母/数字/下划线/连字符')
      return
    }
    exec(`tmux select-window -t ${TMUX_SESSION}:${target}`, (err) => {
      if (err) {
        telegramSend(chatId, `❌ 无法切换到窗口 \`${target}\`: ${err.message}`)
      } else {
        telegramSend(chatId, `✅ 已切换到窗口 \`${target}\`\n\n后续任务将在此窗口执行。`)
      }
    })
    return
  }

  // 执行 claude -p，Telegram 渠道：增量进度推送
  async function runClaudePrompt(prompt, cwd, sessionName) {
    const msgId = await telegramSend(chatId, `⏳ *执行中*（session: \`${sessionName || 'default'}\`）\n\n_等待输出..._`)

    let currentOutput = ''
    let currentError = ''
    let currentTaskId = null

    const progressInterval = setInterval(() => {
      const preview = (currentOutput || currentError).trim()
      if (preview) {
        if (msgId) {
          const truncated = preview.length > 3000 ? '…' + preview.slice(-3000) : preview
          telegramEdit(chatId, msgId, `⏳ *执行中*（session: \`${sessionName || 'default'}\`）\n\`\`\`\n${truncated}\n\`\`\``)
        }
        // 更新任务记录，让 Web TaskPanel 可见中间输出
        if (currentTaskId) updateTask(currentTaskId, { output: currentOutput.slice(-10000), error: currentError.slice(-1000) })
      }
    }, 5000)

    const { taskId } = runTask(prompt, cwd, {
      sessionName: sessionName || 'telegram',
      source: 'telegram',
      onChunk: (chunk, isErr) => {
        if (isErr) currentError += chunk; else currentOutput += chunk
      },
      onDone: ({ exitCode }) => {
        clearInterval(progressInterval)
        const result = currentOutput.trim() || currentError.trim() || '(无输出)'
        const truncated = result.length > 3800 ? result.slice(0, 3800) + '\n\n…(输出已截断)' : result
        const status = exitCode === 0 ? '✅' : '❌'
        if (msgId) {
          telegramEdit(chatId, msgId, `${status} *执行完成*（session: \`${sessionName || 'default'}\`）\n\`\`\`\n${truncated}\n\`\`\``)
        } else {
          telegramSend(chatId, `${status} *执行完成*\n\`\`\`\n${truncated}\n\`\`\``)
        }
      },
    })
    currentTaskId = taskId
  }

  // 处理文件/图片上传
  if (message.photo || message.document) {
    (async () => {
      try {
        // 确定目标目录
        let cwd = WORKSPACE_ROOT
        try {
          const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
          for (const line of activeLines) {
            const parts = line.split(':')
            if (parts[parts.length - 1]?.trim() === '1') {
              cwd = parts.slice(2, parts.length - 1).join(':')
              break
            }
          }
        } catch {}

        let fileId, filename
        if (message.photo) {
          const photo = message.photo[message.photo.length - 1]
          fileId = photo.file_id
          filename = `tg_photo_${Date.now()}.jpg`
        } else {
          fileId = message.document.file_id
          filename = message.document.file_name || `tg_file_${Date.now()}`
        }

        telegramSend(chatId, `⬇️ 正在下载文件到 \`${cwd}\`...`)
        const result = await downloadTelegramFile(fileId, cwd, filename)
        telegramSend(chatId, `✅ 文件已保存\n\`\`\`\n${result.path}\n\`\`\`\n大小: ${(result.size / 1024).toFixed(1)} KB`)

        // 如果有 caption，把 caption 作为 prompt 执行
        if (message.caption?.trim()) {
          const caption = message.caption.trim()
          runClaudePrompt(caption, cwd, 'telegram').catch(e => console.error('runClaudePrompt error:', e))
        }
      } catch (e) {
        telegramSend(chatId, '❌ 文件处理失败: ' + (e.message || String(e)))
      }
    })()
    return
  }

  // 普通 prompt
  const text = message.text?.trim()
  if (!text) return
  let cwd = WORKSPACE_ROOT
  let sessionName = TELEGRAM_DEFAULT_SESSION

  try {
    const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
    // 优先用默认 session，否则用 active window
    for (const line of windows) {
      const parts = line.split(':')
      const idx = parts[0]
      const name = parts[1]
      const path = parts.slice(2).join(':')
      if (TELEGRAM_DEFAULT_SESSION && name === TELEGRAM_DEFAULT_SESSION) {
        cwd = path
        sessionName = name
        break
      }
    }
    // 如果没找到默认 session，用 active window
    if (!sessionName) {
      const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
      for (const line of activeLines) {
        const parts = line.split(':')
        const active = parts[parts.length - 1]
        if (active?.trim() === '1') {
          sessionName = parts[1]
          cwd = parts.slice(2, parts.length - 1).join(':')
          break
        }
      }
    }
  } catch { /* ignore */ }

  runClaudePrompt(text, cwd, sessionName).catch(e => console.error('runClaudePrompt error:', e))
})

// GET /api/telegram/setup — 一键配置 Telegram webhook URL
app.get('/api/telegram/setup', authMiddleware, (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not set' })
  const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/telegram`
  const secretParam = TELEGRAM_WEBHOOK_SECRET ? `&secret_token=${TELEGRAM_WEBHOOK_SECRET}` : ''
  const setupUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}${secretParam}`

  // 调用 Telegram API 设置 webhook
  https.get(setupUrl, (r) => {
    let data = ''
    r.on('data', d => data += d)
    r.on('end', () => {
      try {
        res.json({ webhookUrl, telegramResponse: JSON.parse(data) })
      } catch {
        res.json({ webhookUrl, raw: data })
      }
    })
  }).on('error', (e) => res.status(500).json({ error: e.message }))
})

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

function ensureWindowPty(session, windowIndex) {
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

  const { key, entry } = ensureWindowPty(session, windowIndex);
  entry.clients.add(ws);
  console.log(`Client connected to ${key} (clients: ${entry.clients.size})`);

  // Send recent output so the screen isn't blank while waiting for the first repaint.
  if (entry.lastOutput) {
    ws.send(entry.lastOutput.slice(-2000));
  }

  ws.on('message', (msg) => {
    const ent = ptyMap.get(key);
    if (!ent) return;
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

// 启动时清理残留的 running 状态（服务重启导致的孤儿任务）
try {
  const staleTasks = loadTasks()
  let changed = false
  for (const t of staleTasks) {
    if (t.status === 'running') {
      t.status = 'error'
      t.error = '(服务重启，任务中断)'
      t.completedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) saveTasks(staleTasks)
} catch {}

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Nexus listening on :${PORT}`);
  console.log(`tmux session: ${TMUX_SESSION}`);
  console.log(`workspace: ${WORKSPACE_ROOT}`);
  // 启动时确保默认 tmux session 存在，窗口名使用 WORKSPACE_ROOT 的目录名
  try {
    const defaultWindowName = WORKSPACE_ROOT.replace(/^\/+|\/+$/, '').split('/').pop() || '~'
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null || tmux new-session -d -s ${TMUX_SESSION} -n "${defaultWindowName}" -c "${WORKSPACE_ROOT}" "${INTERACTIVE_SHELL}"`);
    console.log(`tmux session '${TMUX_SESSION}' ready`);
  } catch (e) { console.warn('tmux session init failed:', e.message); }
});
