import express from 'express';

import authMiddleware from '../middleware/auth.js';

/**
 * Tasks router (SSE streaming)
 */
export function createTasksRouter(deps) {
  const { taskStore } = deps;
  const router = express.Router();

  router.use(authMiddleware);

  // List recent tasks
  router.get('/tasks', async (req, res) => {
    try {
      const data = await taskStore.listRecent ? taskStore.listRecent() : [];
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list tasks' });
    }
  });

  // Create task with SSE streaming
  router.post('/tasks', async (req, res) => {
    try {
      if (!taskStore.createTask) return res.status(500).json({ error: 'Task store not available' });
      const task = await taskStore.createTask(req.body);
      // Setup SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Initial event
      res.write(`data: ${JSON.stringify({ id: task?.id, status: 'started' })}\n\n`);
      if (typeof taskStore.streamTask === 'function') {
        taskStore.streamTask(task.id, res);
      } else {
        res.write(`data: ${JSON.stringify({ id: task?.id, status: 'done' })}\n\n`);
        res.end();
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Delete/cancel task
  router.delete('/tasks/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (taskStore.deleteTask) await taskStore.deleteTask(id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  return router;
}

export default createTasksRouter;
