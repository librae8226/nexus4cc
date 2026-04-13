import * as pty from 'node-pty'
import { execFileSync } from '../utils/shell.js'

// PTY Manager: manages per-session/window PTYs with safe tmux execution
// Key: `${session}:${windowIndex}`
class PtyManager {
  constructor() {
    this.ptyMap = new Map(); // key -> { pty, clients: Set<ws>, clientSizes: Map, lastOutput, lastActivity, cleanupTimer? }
  }

  ptyKey(session, windowIndex) {
    return `${session}:${windowIndex}`;
  }

  getOrCreatePty(session, windowIndex, TMUX_SESSION) {
    const key = this.ptyKey(session, windowIndex);
    if (this.ptyMap.has(key)) return { key, entry: this.ptyMap.get(key) };

    // Ensure tmux session exists
    try {
      execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' })
    } catch {
      // best-effort create if missing
      try { execFileSync('tmux', ['new-session', '-d', '-s', session, '-n', 'shell', 'zsh'], { stdio: 'ignore' }) } catch {}
    }

    // Check/window existence; fall back if necessary
    let targetWindow = windowIndex;
    try {
      const list = execFileSync('tmux', ['list-windows', '-t', session, '-F', '#I'], { encoding: 'utf8' })
      const windows = list.trim().split('\n').filter(Boolean)
      if (!windows.includes(String(windowIndex))) {
        if (windows.length > 0) {
          targetWindow = parseInt(windows[0], 10);
        } else {
          execFileSync('tmux', ['new-window', '-t', session, '-n', 'shell', 'zsh'], { stdio: 'ignore' })
          targetWindow = 0
        }
      }
    } catch {
      targetWindow = 0
    }

    const actualKey = this.ptyKey(session, targetWindow);
    if (this.ptyMap.has(actualKey)) return { key: actualKey, entry: this.ptyMap.get(actualKey) }

    const ptyProc = pty.spawn('tmux', ['attach-session', '-t', `${session}:${targetWindow}`], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env: { ...process.env, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    })

    const entry = { pty: ptyProc, clients: new Set(), clientSizes: new Map(), lastOutput: '', lastActivity: Date.now() }
    this.ptyMap.set(actualKey, entry)

    // Broadcast data to all connected WS clients
    ptyProc.onData((data) => {
      const ent = this.ptyMap.get(actualKey)
      if (!ent) return
      ent.lastOutput = (ent.lastOutput + data).slice(-10000)
      ent.lastActivity = Date.now()
      for (const ws of ent.clients) {
        if (ws.readyState === 1) {
          // Include session_id for traceability
          try {
            ws.send(JSON.stringify({ session_id: actualKey, data }))
          } catch {
            ws.send(data)
          }
        }
      }
    })

    ptyProc.onExit(({ exitCode }) => {
      console.log(`PTY ${actualKey} exited with code ${exitCode}`)
      this.ptyMap.delete(actualKey)
      // Try to recreate if the window still exists
      try {
        const list = execFileSync('tmux', ['list-windows', '-t', session, '-F', '#I'], { encoding: 'utf8' }).toString()
        const windows = list.trim().split('\n')
        if (windows.includes(String(targetWindow))) {
          setTimeout(() => this.getOrCreatePty(session, targetWindow, TMUX_SESSION), 100)
        }
      } catch {
        // ignore
      }
    })

    return { key: actualKey, entry }
  }

  resizePty(key, ws, cols, rows) {
    const ent = this.ptyMap.get(key)
    if (!ent) return
    ent.clientSizes.set(ws, { cols: Math.max(cols, 10), rows: Math.max(rows, 5) })
    // Compute minimum across all clients
    let minCols = Infinity, minRows = Infinity
    for (const size of ent.clientSizes.values()) {
      if (size.cols < minCols) minCols = size.cols
      if (size.rows < minRows) minRows = size.rows
    }
    if (minCols !== Infinity) ent.pty.resize(Math.max(minCols, 10), Math.max(minRows, 5))
    ent.lastActivity = Date.now()
  }

  writePty(key, data) {
    const ent = this.ptyMap.get(key)
    if (!ent) return
    ent.lastActivity = Date.now()
    ent.pty.write(data)
  }

  addClient(key, ws) {
    const ent = this.ptyMap.get(key)
    if (!ent) return
    ent.clients.add(ws)
    // If there is an idle timer, cancel it because we have a new client
    if (ent.cleanupTimer) {
      clearTimeout(ent.cleanupTimer)
      ent.cleanupTimer = null
    }
  }

  removeClient(key, ws) {
    const ent = this.ptyMap.get(key)
    if (!ent) return
    ent.clients.delete(ws)
    ent.clientSizes.delete(ws)
    console.log(`Client disconnected from ${key} (clients: ${ent.clients.size})`)
    // Recompute minimum size if other clients remain
    if (ent.clients.size > 0 && ent.clientSizes.size > 0) {
      let minCols = Infinity, minRows = Infinity
      for (const [, size] of ent.clientSizes) {
        if (size.cols < minCols) minCols = size.cols
        if (size.rows < minRows) minRows = size.rows
      }
      if (minCols !== Infinity) ent.pty.resize(Math.max(minCols, 10), Math.max(minRows, 5))
    }
    // Idle cleanup: if no clients, schedule a cleanup in 5 minutes
    if (ent.clients.size === 0) {
      ent.cleanupTimer = setTimeout(() => {
        const e = this.ptyMap.get(key)
        if (e && e.clients.size === 0 && Date.now() - e.lastActivity > 300000) {
          e.pty.kill()
          this.ptyMap.delete(key)
          console.log(`PTY ${key} cleaned up (idle)`)
        }
        ent.cleanupTimer = null
      }, 300000)
    }
  }

  getPtyStatus(session, windowIndex) {
    const key = this.ptyKey(session, windowIndex)
    const ent = this.ptyMap.get(key)
    if (!ent) return { connected: false, output: '', clients: 0, idleMs: null }
    return {
      connected: ent.clients.size > 0,
      output: ent.lastOutput,
      clients: ent.clients.size,
      idleMs: Date.now() - ent.lastActivity,
    }
  }

  cleanup() {
    for (const [key, ent] of this.ptyMap) {
      try { ent.pty.kill() } catch {}
      this.ptyMap.delete(key)
    }
  }
}

export default PtyManager
