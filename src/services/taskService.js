import { spawn } from 'child_process';
import path from 'path';
import { initTasksStore, addTask, updateTask } from '../data/tasks.js';
import { WORKSPACE_ROOT } from '../config/env.js';

// Local in-module store handle (lazy init)
let store = null;

function ensureStore() {
  if (store) return store;
  const filePath = path.resolve(WORKSPACE_ROOT, 'data', 'tasks.json');
  store = initTasksStore(filePath);
  return store;
}

/**
 * Run a Claude task using spawn (no exec for safety).
 * @param {string} prompt - the prompt to send to Claude
 * @param {string} cwd - working directory for the Claude process
 * @param {object} opts - optional callbacks and metadata
 * @param {string} [opts.sessionName]
 * @param {string} [opts.source]
 * @param {string} [opts.tmuxSession]
 * @param {function(string, boolean): void} [opts.onChunk]
 * @param {function(object): void} [opts.onDone]
 * @param {string} [opts.profile]
 * @returns {{ taskId:string, kill: function }}
 */
export async function runTask(prompt, cwd, opts = {}) {
  const { sessionName, source, tmuxSession, onChunk, onDone, profile } = opts;
  // Initialize store if needed
  ensureStore();

  // Create a lightweight unique id
  const taskId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  // Persist initial task entry as running
  await addTask({ id: taskId, prompt, status: 'running', startedAt: Date.now(), sessionName, source, tmuxSession });

  // CLAUDE proxy handling
  const env = { ...process.env };
  if (env.CLAUDE_PROXY) {
    env.CLAUDE_PROXY = env.CLAUDE_PROXY;
  }

  // Build args (extendable with profile)
  const profileArgs = [];
  if (profile) {
    profileArgs.push('--profile', String(profile));
  }
  const claudeExe = process.env.CLAUDE_CLI || 'claude';
  const child = spawn(claudeExe, ['-p', prompt, '--dangerously-skip-permissions', ...profileArgs], {
    cwd: cwd || process.cwd(),
    env,
  });

  child.stdout.on('data', (chunk) => {
    if (typeof onChunk === 'function') onChunk(chunk.toString(), false);
  });
  child.stderr.on('data', (chunk) => {
    if (typeof onChunk === 'function') onChunk(chunk.toString(), true);
  });

  child.on('close', async (code) => {
    const updates = code === 0 ? { status: 'completed', finishedAt: Date.now() } : { status: 'error', finishedAt: Date.now(), note: `Exit code ${code}` };
    try {
      await updateTask(taskId, updates);
    } catch {
      // ignore
    }
    if (typeof onDone === 'function') onDone({ taskId, code });
  });

  return {
    taskId,
    kill: () => {
      try { child.kill('SIGTERM'); } catch {}
    },
  };
}

export default { runTask };
