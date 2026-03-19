// server.js — Nexus WebSocket tmux 桥接服务
import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createServer } from 'http';
import { exec, spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';

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

const app = express();
app.use(express.json());

const {
  JWT_SECRET,
  ACC_PASSWORD_HASH,
  TMUX_SESSION = 'main',
  WORKSPACE_ROOT = '/home/librae',
  PORT = '3000',
  CLAUDE_PROXY = 'http://127.0.0.1:6789',
} = process.env;

if (!JWT_SECRET || !ACC_PASSWORD_HASH) {
  console.error('ERROR: JWT_SECRET and ACC_PASSWORD_HASH must be set in environment');
  process.exit(1);
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

// POST /api/sessions — 在 tmux 中创建新 window
// body: { rel_path, shell_type?, profile? }
//   shell_type: 'claude' | 'bash' (default: 'claude')
//   当 shell_type='claude' 时，profile 可选，使用 nexus-run-claude.sh 启动
//   当 shell_type='bash' 时，直接启动 bash
app.post('/api/sessions', authMiddleware, (req, res) => {
  const { rel_path, shell_type = 'claude', profile } = req.body || {};
  if (!rel_path) return res.status(400).json({ error: 'rel_path required' });
  const cwd = rel_path.startsWith('/') ? rel_path : `${WORKSPACE_ROOT}/${rel_path}`;
  const name = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'session';

  let shellCmd;
  if (shell_type === 'bash') {
    shellCmd = 'zsh';
  } else {
    // claude mode: inject proxy env vars so claude can reach the API
    const proxyEnv = CLAUDE_PROXY ? `ALL_PROXY=${CLAUDE_PROXY} HTTPS_PROXY=${CLAUDE_PROXY} HTTP_PROXY=${CLAUDE_PROXY}` : '';
    if (profile) {
      const runScript = join(__dirname, 'nexus-run-claude.sh');
      shellCmd = `${proxyEnv} bash ${runScript} ${profile} ${cwd}`;
    } else {
      shellCmd = `${proxyEnv} claude --dangerously-skip-permissions; exec zsh -i`;
    }
  }

  const cmd = `tmux new-window -t ${TMUX_SESSION} -c "${cwd}" -n "${name}" "${shellCmd}"`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ name, cwd, shell_type, profile: profile || null });
  });
});

// GET /api/configs — 列出所有 claude 配置 profile
app.get('/api/configs', authMiddleware, (req, res) => {
  try {
    const files = readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.json'));
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

// GET /api/workspaces — 扫描 WORKSPACE_ROOT 下的子目录
app.get('/api/workspaces', authMiddleware, (req, res) => {
  try {
    const entries = readdirSync(WORKSPACE_ROOT, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(dirs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions — 列出 tmux 会话的所有窗口
app.get('/api/sessions', authMiddleware, (req, res) => {
  exec(
    `tmux list-windows -t ${TMUX_SESSION} -F "#{window_index}|#{window_name}|#{window_active}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const windows = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [index, name, active] = line.split('|')
        return { index: Number(index), name, active: active?.trim() === '1' }
      })
      res.json({ session: TMUX_SESSION, windows })
    }
  )
})

// DELETE /api/sessions/:id — 关闭 tmux 窗口
app.delete('/api/sessions/:id', authMiddleware, (req, res) => {
  const index = req.params.id
  // Check window count first; if this is the last window, create a fallback
  // window before killing so the tmux session is not destroyed.
  exec(`tmux list-windows -t ${TMUX_SESSION} -F "#{window_index}" 2>/dev/null | wc -l`, (countErr, countOut) => {
    const windowCount = parseInt(countOut.trim()) || 0
    if (windowCount <= 1) {
      // Last window: create a new shell first to keep the session alive
      exec(`tmux new-window -t ${TMUX_SESSION} -n shell "zsh"`, () => {
        exec(`tmux kill-window -t ${TMUX_SESSION}:${index}`, (err) => {
          if (err) return res.status(500).json({ error: err.message })
          res.json({ ok: true })
        })
      })
    } else {
      exec(`tmux kill-window -t ${TMUX_SESSION}:${index}`, (err) => {
        if (err) return res.status(500).json({ error: err.message })
        res.json({ ok: true })
      })
    }
  })
})

// POST /api/sessions/:id/attach — 切换到指定 tmux 窗口
app.post('/api/sessions/:id/attach', authMiddleware, (req, res) => {
  const index = req.params.id
  exec(`tmux select-window -t ${TMUX_SESSION}:${index}`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
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

function saveTasks(tasks) {
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2))
}

// GET /api/tasks — 获取任务历史
app.get('/api/tasks', authMiddleware, (req, res) => {
  const tasks = loadTasks()
  res.json(tasks.slice(-50).reverse()) // 最近50条，倒序
})

// POST /api/tasks — 创建新任务，SSE 流式返回
app.post('/api/tasks', authMiddleware, (req, res) => {
  const { session_name, prompt, profile } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'prompt required' })

  // 找到 session 对应的 cwd
  let cwd = WORKSPACE_ROOT
  try {
    const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
    for (const line of windows) {
      const [index, name, path] = line.split(':')
      if (name === session_name) {
        cwd = path
        break
      }
    }
  } catch {}

  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const createdAt = new Date().toISOString()

  // 设置 SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  // 代理环境变量
  const proxyEnv = CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY } : {}

  // 构建 claude 命令
  const args = ['-p', prompt, '--dangerously-skip-permissions']
  if (profile) args.push('--profile', profile)

  const child = spawn('claude', args, {
    cwd,
    env: { ...process.env, ...proxyEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  let errorOutput = ''

  // 发送任务开始事件
  res.write(`event: start\ndata: ${JSON.stringify({ taskId, session_name, prompt, createdAt })}\n\n`)

  child.stdout.on('data', (data) => {
    const chunk = data.toString()
    output += chunk
    res.write(`event: output\ndata: ${JSON.stringify({ chunk })}\n\n`)
  })

  child.stderr.on('data', (data) => {
    const chunk = data.toString()
    errorOutput += chunk
    res.write(`event: error\ndata: ${JSON.stringify({ chunk })}\n\n`)
  })

  child.on('close', (code) => {
    const status = code === 0 ? 'success' : 'error'
    const completedAt = new Date().toISOString()

    // 保存任务历史
    const tasks = loadTasks()
    tasks.push({
      id: taskId,
      session_name,
      prompt: prompt.slice(0, 1000), // 截断保存
      status,
      output: output.slice(-10000), // 保存最后10K输出
      error: errorOutput.slice(-1000),
      createdAt,
      completedAt,
      exitCode: code
    })
    // 只保留最近 100 条
    if (tasks.length > 100) tasks.shift()
    saveTasks(tasks)

    res.write(`event: done\ndata: ${JSON.stringify({ taskId, status, exitCode: code })}\n\n`)
    res.end()
  })

  // 客户端断开时清理
  req.on('close', () => {
    if (!child.killed) child.kill()
  })
})


// SPA fallback — 所有非 API 路由返回 index.html
app.get('*', (req, res) => {
  const indexPath = join(__dirname, 'frontend', 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run: cd frontend && npm run build');
  });
});

// PTY 单实例，attach 到 tmux session
let ptyProc = null;
const clients = new Set();


function ensurePty() {
  if (ptyProc) return;
  // Ensure the tmux session exists before attaching; create it if needed.
  exec(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null || tmux new-session -d -s ${TMUX_SESSION} -n shell "zsh"`, (err) => {
    if (ptyProc) return; // another caller may have completed first
    ptyProc = pty.spawn('tmux', ['attach-session', '-t', TMUX_SESSION], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      env: { ...process.env, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    });

    ptyProc.onData((data) => {
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(data);
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      console.log(`PTY exited with code ${exitCode}`);
      ptyProc = null;
      // Safety net: recreate the tmux session for the next connection.
      exec(`tmux new-session -d -s ${TMUX_SESSION}`);
      for (const ws of clients) {
        if (ws.readyState === 1) {
          ws.send('\r\n[Nexus: tmux session ended — refresh to reconnect]\r\n');
        }
      }
    });
  });
}

// WebSocket 服务
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');

  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(4001, 'unauthorized');
    return;
  }

  ensurePty();
  clients.add(ws);
  console.log(`Client connected (total: ${clients.size})`);

  ws.on('message', (msg) => {
    if (!ptyProc) return;
    const str = typeof msg === 'string' ? msg : msg.toString();
    try {
      const data = JSON.parse(str);
      if (data.type === 'resize' && data.cols && data.rows) {
        ptyProc.resize(Number(data.cols), Number(data.rows));
      }
    } catch {
      // 非 JSON 消息视为原始键盘输入
      ptyProc.write(str);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected (total: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    clients.delete(ws);
  });
});

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Nexus listening on :${PORT}`);
  console.log(`tmux session: ${TMUX_SESSION}`);
  console.log(`workspace: ${WORKSPACE_ROOT}`);
});
