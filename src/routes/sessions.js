import express from 'express';

import authMiddleware from '../middleware/auth.js';

/**
 * Sessions router
 * Injected deps: tmuxService, fileService, taskStore, config
 */
export function createSessionsRouter(deps) {
  const { tmuxService } = deps;
  const router = express.Router();

  // Require auth for all routes in this router
  router.use(authMiddleware);

  // List windows/sessions
  router.get('/sessions', async (req, res) => {
    try {
      const data = await tmuxService.listSessions ? tmuxService.listSessions() : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // Create a new window/session
  router.post('/sessions', async (req, res) => {
    try {
      const data = await tmuxService.createSession ? tmuxService.createSession(req.body) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // Create window (F-19 project-window)
  router.post('/windows', async (req, res) => {
    try {
      const data = await tmuxService.createWindow ? tmuxService.createWindow(req.body) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create window' });
    }
  });

  // Kill window
  router.delete('/sessions/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (tmuxService.killSession) await tmuxService.killSession(id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: 'Failed to kill session' });
    }
  });

  // Attach/select window
  router.post('/sessions/:id/attach', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await tmuxService.attachSession ? tmuxService.attachSession(id) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to attach session' });
    }
  });

  // Rename window
  router.post('/sessions/:id/rename', async (req, res) => {
    try {
      const id = req.params.id;
      const newName = req.body && req.body.name;
      const data = await tmuxService.renameSession ? tmuxService.renameSession(id, newName) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to rename session' });
    }
  });

  // PTY status
  router.get('/sessions/:id/output', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await tmuxService.getSessionOutput ? tmuxService.getSessionOutput(id) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to get session output' });
    }
  });

  // Scrollback capture
  router.get('/sessions/:id/scrollback', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await tmuxService.getSessionScrollback ? tmuxService.getSessionScrollback(id) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to capture scrollback' });
    }
  });

  // List all tmux sessions
  router.get('/tmux-sessions', async (req, res) => {
    try {
      const data = await tmuxService.listSessions ? tmuxService.listSessions() : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list tmux sessions' });
    }
  });

  // Current session cwd
  router.get('/session-cwd', async (req, res) => {
    try {
      const data = await tmuxService.getSessionCwd ? tmuxService.getSessionCwd() : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to get session cwd' });
    }
  });

  return router;
}

export default createSessionsRouter;
