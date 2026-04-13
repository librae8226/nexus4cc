import express from 'express';
import multer from 'multer';

import authMiddleware from '../middleware/auth.js';

/**
 * Files router
 * Injected deps: tmuxService, fileService, taskStore, config
 */
export function createFilesRouter(deps) {
  const { fileService } = deps;
  const router = express.Router();

  router.use(authMiddleware);

  // Multer: memory storage for uploads
  const storage = multer.memoryStorage();
  const uploader = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

  // Upload to session cwd (memory storage file, not persisted here)
  router.post('/upload', uploader.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file uploaded' });
      const result = await fileService.saveToCwd ? fileService.saveToCwd(file) : null;
      res.json({ ok: true, file: file.originalname, result });
    } catch (err) {
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // Upload to data/uploads (date-partitioned)
  const uploadToUploads = uploader.single('file');
  router.post('/files/upload', uploadToUploads, async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file uploaded' });
      const datePath = new Date().toISOString().slice(0, 10);
      const result = await fileService.saveToUploads ? fileService.saveToUploads(file, datePath) : null;
      res.json({ ok: true, file: file.originalname, date: datePath, result });
    } catch (err) {
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // List uploaded files
  router.get('/files', async (req, res) => {
    try {
      const data = await fileService.listUploaded ? fileService.listUploaded() : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list uploaded files' });
    }
  });

  // Delete specific file
  router.delete('/files/:date/:filename', async (req, res) => {
    try {
      const { date, filename } = req.params;
      const data = await fileService.deleteUploaded ? fileService.deleteUploaded(date, filename) : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // Delete all uploaded files
  router.delete('/files/all', async (req, res) => {
    try {
      const data = await fileService.deleteAllUploaded ? fileService.deleteAllUploaded() : null;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete all files' });
    }
  });

  return router;
}

export default createFilesRouter;
