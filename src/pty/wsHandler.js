import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import { URL } from 'url'

// WebSocket handler factory
// Exports:
// - createWebSocketHandler(wss, ptyManager, JWT_SECRET)
// - setupWebSocket(server, ptyManager, JWT_SECRET)

export function createWebSocketHandler(wss, ptyManager, JWT_SECRET) {
  const TMUX_SESSION_DEFAULT = process.env.TMUX_SESSION || 'nexus'

  wss.on('connection', (ws, req) => {
    // Per-connection state
    let authed = false
    let ptyKey = null
    let ptyEntry = null
    // 10s auth window
    const authTimeout = setTimeout(() => {
      if (!authed) {
        ws.close(4002, 'auth timeout')
      }
    }, 10000)

    // Parse possible query params (backward-compat)
    const url = new URL(req.url, 'http://x')
    const queryToken = url.searchParams.get('token')
    const windowParam = url.searchParams.get('window') || '0'
    const sessionParam = url.searchParams.get('session') || TMUX_SESSION_DEFAULT
    const windowIndex = parseInt(windowParam, 10) || 0
    const session = sessionParam

    // Helper to attach to a PTY
    const attachToPty = (sess, winIdx) => {
      const res = ptyManager.getOrCreatePty(sess, winIdx, TMUX_SESSION_DEFAULT)
      if (res.error === 'session_not_found') {
        ws.send(JSON.stringify({ error: 'session_not_found', session: sess, message: 'Session does not exist. Create via /api/projects first.' }))
        return false
      }
      ptyKey = res.key
      ptyEntry = res.entry
      if (!ptyKey || !ptyEntry) {
        ws.send(JSON.stringify({ error: 'pty_error', message: 'Failed to attach to PTY' }))
        return false
      }
      ptyManager.addClient(ptyKey, ws)
      authed = true
      clearTimeout(authTimeout)
      console.log(`Client connected to ${ptyKey} (${ptyEntry.clients.size})`)
      if (ptyEntry && ptyEntry.lastOutput) {
        ws.send(ptyEntry.lastOutput.slice(-2000))
      }
      return true
    }

    // Try token-based auth from query (preferred path)
    if (queryToken) {
      try {
        jwt.verify(queryToken, JWT_SECRET)
        attachToPty(session, windowIndex)
      } catch {
        // ignore and require in-message auth
      }
    }

    ws.on('message', (msg) => {
      if (!authed) {
        let parsed = null
        try { parsed = typeof msg === 'string' ? JSON.parse(msg) : JSON.parse(msg.toString()) } catch {}
        if (parsed && parsed.type === 'auth' && parsed.token) {
          try {
            jwt.verify(parsed.token, JWT_SECRET)
            const sess = parsed.session || session
            const win = Number.isFinite(parsed.window) ? parsed.window : windowIndex
            if (!attachToPty(sess, win)) {
              // session_not_found - keep connection open, inform user
              return
            }
          } catch {
            ws.close(4001, 'unauthorized')
          }
        }
        return
      }
      // Authenticated: forward input or resize commands
      const text = typeof msg === 'string' ? msg : msg.toString()
      let isResize = false
      try {
        const data = JSON.parse(text)
        if (data && data.type === 'resize' && data.cols && data.rows) {
          isResize = true
          const cols = Number(data.cols)
          const rows = Number(data.rows)
          ptyManager.resizePty(ptyKey, ws, cols, rows)
        }
      } catch {
        // not JSON: treat as raw input
      }
      if (!isResize && ptyKey) {
        ptyManager.writePty(ptyKey, text)
      }
    })

    ws.on('close', () => {
      if (ptyKey) {
        ptyManager.removeClient(ptyKey, ws)
        ptyKey = null
        ptyEntry = null
      }
    })

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message)
      if (ptyKey) ptyManager.removeClient(ptyKey, ws)
    })
  })
}

export function setupWebSocket(server, ptyManager, JWT_SECRET) {
  const wss = new WebSocketServer({ server, path: '/ws' })
  createWebSocketHandler(wss, ptyManager, JWT_SECRET)
  return wss
}
