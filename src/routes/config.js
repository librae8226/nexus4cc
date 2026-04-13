import express from 'express';

import authMiddleware from '../middleware/auth.js';

/**
 * Config router
 * Injected deps: tmuxService, fileService, taskStore, config
 */
export function createConfigRouter(deps) {
  const { config } = deps;
  const router = express.Router();

  router.use(authMiddleware);

  // Server config
  router.get('/config', async (req, res) => {
    try {
      const data = await config.getConfig ? config.getConfig() : {};
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load config' });
    }
  });

  // Config profiles
  router.get('/configs', async (req, res) => {
    try {
      const data = await config.listProfiles ? config.listProfiles() : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list profiles' });
    }
  });

  // Create/Update profile
  router.post('/configs/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await config.upsertProfile ? config.upsertProfile(id, req.body) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to upsert profile' });
    }
  });

  // Delete profile
  router.delete('/configs/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (config.deleteProfile) await config.deleteProfile(id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete profile' });
    }
  });

  // Toolbar config
  router.get('/toolbar-config', async (req, res) => {
    try {
      const data = await config.getToolbarConfig ? config.getToolbarConfig() : {};
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load toolbar config' });
    }
  });

  router.post('/toolbar-config', async (req, res) => {
    try {
      const data = await config.setToolbarConfig ? config.setToolbarConfig(req.body) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to save toolbar config' });
    }
  });

  // Version
  router.get('/version', async (req, res) => {
    try {
      const data = await config.getVersion ? config.getVersion() : { version: 'unknown' };
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to get version' });
    }
  });

  // Latest version from GitHub tags (proxy)
  router.get('/version/latest', async (req, res) => {
    try {
      // Use native fetch if available
      const fetch = global.fetch || (await import('node:https')).get; // fallback to require
      const response = await fetch('https://api.github.com/repos/nexus4cc/nexus4cc/tags');
      const data = await response.json();
      const tags = Array.isArray(data) ? data.map(t => t.name) : [];
      res.json({ latest: tags[0] || null, tags });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch latest version' });
    }
  });

  return router;
}

export default createConfigRouter;
