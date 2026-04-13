import express from 'express';

import authMiddleware from '../middleware/auth.js';

/**
 * Projects router
 * Injected deps: tmuxService, fileService, taskStore, config
 */
export function createProjectsRouter(deps) {
  const { tmuxService } = deps;
  const router = express.Router();

  router.use(authMiddleware);

  // List projects
  router.get('/projects', async (req, res) => {
    try {
      const data = await tmuxService.listProjects ? tmuxService.listProjects() : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list projects' });
    }
  });

  // Create project
  router.post('/projects', async (req, res) => {
    try {
      const data = await tmuxService.createProject ? tmuxService.createProject(req.body) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  // Channels for a project
  router.get('/projects/:name/channels', async (req, res) => {
    try {
      const name = req.params.name;
      const data = await tmuxService.listProjectChannels ? tmuxService.listProjectChannels(name) : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list channels' });
    }
  });

  router.post('/projects/:name/channels', async (req, res) => {
    try {
      const name = req.params.name;
      const data = await tmuxService.createProjectChannel ? tmuxService.createProjectChannel(name, req.body) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create channel' });
    }
  });

  // Activate project
  router.post('/projects/:name/activate', async (req, res) => {
    try {
      const name = req.params.name;
      const data = await tmuxService.activateProject ? tmuxService.activateProject(name) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to activate project' });
    }
  });

  // Rename project
  router.post('/projects/:name/rename', async (req, res) => {
    try {
      const name = req.params.name;
      const data = await tmuxService.renameProject ? tmuxService.renameProject(name, req.body.newName) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to rename project' });
    }
  });

  // Kill project
  router.delete('/projects/:name', async (req, res) => {
    try {
      const name = req.params.name;
      if (tmuxService.killProject) await tmuxService.killProject(name);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: 'Failed to kill project' });
    }
  });

  return router;
}

export default createProjectsRouter;
