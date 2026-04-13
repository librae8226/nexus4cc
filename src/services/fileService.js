import path from 'path';
import fs from 'fs';

// Core workspace path validation
function validateWorkspacePath(inputPath, workspaceRoot) {
  const workspaceRootAbs = path.resolve(workspaceRoot);
  // Join inputPath with workspaceRoot; this handles absolute and relative inputs
  const absPath = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRootAbs, absPath);
  // If relative starts with '..' or goes outside, it's invalid
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path outside workspace: ${inputPath}`);
  }
  return absPath;
}

/** Utility: ensures the parent directory of a given file path exists */
async function ensureParentDirExists(filePath) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
}

/** Lists immediate directory contents inside the workspace */
async function listDirectory(inputPath, workspaceRoot) {
  const abs = validateWorkspacePath(inputPath, workspaceRoot);
  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
}

/** Lists files with basic details: size and mtime */
async function listFilesDetailed(inputPath, workspaceRoot) {
  const abs = validateWorkspacePath(inputPath, workspaceRoot);
  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    const fullPath = path.join(abs, e.name);
    const stat = await fs.promises.stat(fullPath);
    result.push({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      mtime: stat.mtimeMs,
      atime: stat.atimeMs,
    });
  }
  return result;
}

/** Read a text file */
async function readFile(inputPath, workspaceRoot) {
  const abs = validateWorkspacePath(inputPath, workspaceRoot);
  return fs.promises.readFile(abs, 'utf8');
}

/** Write text to a file (overwrite) */
async function writeFile(inputPath, content, workspaceRoot) {
  const abs = validateWorkspacePath(inputPath, workspaceRoot);
  await ensureParentDirExists(abs);
  await fs.promises.writeFile(abs, content, 'utf8');
}

/** Create a directory under a parent path */
async function createDir(parentPath, name, workspaceRoot) {
  const parentAbs = validateWorkspacePath(parentPath, workspaceRoot);
  const newDir = path.join(parentAbs, name);
  await fs.promises.mkdir(newDir, { recursive: true });
  return newDir;
}

/** Delete a file or directory recursively */
async function deleteEntry(targetPath, workspaceRoot) {
  const abs = validateWorkspacePath(targetPath, workspaceRoot);
  // fs.rm supports recursive deletes with { force: true }
  await fs.promises.rm(abs, { recursive: true, force: true });
  return true;
}

/** Rename a file or directory */
async function renameEntry(srcPath, newName, workspaceRoot) {
  const srcAbs = validateWorkspacePath(srcPath, workspaceRoot);
  const dir = path.dirname(srcAbs);
  const dstAbs = path.join(dir, newName);
  await fs.promises.rename(srcAbs, dstAbs);
  return dstAbs;
}

/** Copy a file or directory */
async function copyEntry(sourcePath, targetPath, workspaceRoot) {
  const srcAbs = validateWorkspacePath(sourcePath, workspaceRoot);
  const dstAbs = validateWorkspacePath(targetPath, workspaceRoot);
  // cp supports recursive copy for directories
  await fs.promises.cp(srcAbs, dstAbs, { recursive: true, force: true }).catch(async () => {
    // Fallback: handle if cp is not available (Node may not expose cp on all platforms)
    const stat = await fs.promises.stat(srcAbs);
    if (stat.isDirectory()) {
      // simple manual copy for directory contents
      await fs.promises.mkdir(dstAbs, { recursive: true });
      const items = await fs.promises.readdir(srcAbs);
      for (const item of items) {
        const s = path.join(srcAbs, item);
        const d = path.join(dstAbs, item);
        const st = await fs.promises.stat(s);
        if (st.isDirectory()) {
          await copyEntry(s, d, workspaceRoot);
        } else {
          await fs.promises.copyFile(s, d);
        }
      }
    } else {
      await fs.promises.copyFile(srcAbs, dstAbs);
    }
  });
  return dstAbs;
}

/** Move a file or directory (with cross-device support) */
async function moveEntry(sourcePath, targetPath, workspaceRoot) {
  const srcAbs = validateWorkspacePath(sourcePath, workspaceRoot);
  const dstAbs = validateWorkspacePath(targetPath, workspaceRoot);
  try {
    await fs.promises.rename(srcAbs, dstAbs);
    return dstAbs;
  } catch (err) {
    // Cross-device move: copy then delete
    if (err && (err.code === 'EXDEV' || err.code === 'EPERM')) {
      await copyEntry(sourcePath, targetPath, workspaceRoot);
      await deleteEntry(sourcePath, workspaceRoot);
      return dstAbs;
    }
    throw err;
  }
}

export {
  validateWorkspacePath,
  listDirectory,
  listFilesDetailed,
  readFile,
  writeFile,
  createDir,
  deleteEntry,
  renameEntry,
  copyEntry,
  moveEntry,
};

// Compatibility wrappers for the requested API surface (rename-shims)
export function validatePath(inputPath, workspaceRoot) {
  return validateWorkspacePath(inputPath, workspaceRoot);
}

export async function readFilePath(filePath, workspaceRoot) {
  return await readFile(filePath, workspaceRoot);
}

export async function writeFilePath(filePath, content, workspaceRoot) {
  return await writeFile(filePath, content, workspaceRoot);
}

export async function listDirectoryDetailed(inputPath, workspaceRoot) {
  return await listDirectory(inputPath, workspaceRoot);
}
