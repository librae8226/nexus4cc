import { join } from 'path';
import { WORKSPACE_ROOT } from './env.js';

// Core directories and fixed constants derived from env.js
export const DATA_DIR = join(WORKSPACE_ROOT, 'data');
export const CONFIGS_DIR = join(WORKSPACE_ROOT, 'configs');

// Common config/file locations
export const TOOLBAR_CONFIG_FILE = join(CONFIGS_DIR, 'toolbar.config.json');
export const TASKS_FILE = join(DATA_DIR, 'tasks.json');
export const UPLOADS_DIR = join(DATA_DIR, 'uploads');

// Maximum concurrent tasks for the system
export const MAX_TASKS = 200;
