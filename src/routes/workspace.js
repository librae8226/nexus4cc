import express from 'express';

import authMiddleware from '../middleware/auth.js';

/**
 * Workspace/router for filesystem operations
 * Injected deps: tmuxService, fileService, taskStore, config
 */
export function createWorkspaceRouter(deps) {
  const { fileService } = deps;
  const router = express.Router();

  router.use(authMiddleware);

  // Browse directories starting from a given path
  router.get('/browse', async (req, res) => {
    try {
      const path = req.query.path || '/';
      const data = await fileService.listDirs ? fileService.listDirs(path) : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to browse directories' });
    }
  });

  // List files with stats
  router.get('/workspace/files', async (req, res) => {
    try {
      const path = req.query.path || '/';
      const data = await fileService.listFiles ? fileService.listFiles(path) : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list files' });
    }
  });

  // Make directory
  router.post('/workspace/mkdir', async (req, res) => {
    try {
      const dirPath = req.body.path;
      const data = await fileService.makeDir ? fileService.makeDir(dirPath) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create directory' });
    }
  });

  // Create file
  router.post('/workspace/files', async (req, res) => {
    try {
      const { path, content } = req.body || {};
      const data = await fileService.createFile ? fileService.createFile(path, content) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create file' });
    }
  });

  // Read file
  router.get('/workspace/file', async (req, res) => {
    try {
      const filePath = req.query.path;
      const data = await fileService.readFile ? fileService.readFile(filePath) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // Write file
  router.put('/workspace/file', async (req, res) => {
    try {
      const filePath = req.body.path;
      const content = req.body.content;
      const data = await fileService.writeFile ? fileService.writeFile(filePath, content) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to write file' });
    }
  });

  // Delete entry
  router.delete('/workspace/entry', async (req, res) => {
    try {
      const target = req.body.path;
      const data = await fileService.deleteEntry ? fileService.deleteEntry(target) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete entry' });
    }
  });

  // Rename
  router.post('/workspace/rename', async (req, res) => {
    try {
      const { oldPath, newPath } = req.body || {};
      const data = await fileService.rename ? fileService.rename(oldPath, newPath) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to rename entry' });
    }
  });

  // Copy
  router.post('/workspace/copy', async (req, res) => {
    try {
      const { src, dest } = req.body || {};
      const data = await fileService.copy ? fileService.copy(src, dest) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to copy entry' });
    }
  });

  // Move
  router.post('/workspace/move', async (req, res) => {
    try {
      const { src, dest } = req.body || {};
      const data = await fileService.move ? fileService.move(src, dest) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to move entry' });
    }
  });

  return router;
}

export default createWorkspaceRouter;
