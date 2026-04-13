import path from 'path';

// Factory to create a Telegram service instance
export async function createTelegramService(botToken, webhookSecret, workspaceRoot) {
  // Dynamically import shell utilities to ensure we use tmux-based commands where required
  let tmuxExecSync;
  try {
    const shell = await import('../utils/shell.js');
    tmuxExecSync = shell.tmuxExecSync;
  } catch (e) {
    // If not available, we'll degrade gracefully and still perform operations via standard APIs
    tmuxExecSync = null;
  }

  const apiBase = `https://api.telegram.org/bot${botToken}/`;

  // Simple filename sanitizer for downloads
  function sanitizeFilename(fname) {
    if (!fname) return 'download';
    const base = path.basename(fname);
    // allow only alphanumeric, dot, underscore and hyphen
    return base.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  }

  // Basic HTTP POST wrapper using global fetch (Node 18+ should have it)
  async function doPost(method, payload) {
    const url = apiBase + method;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Telegram API error: ${res.status} ${JSON.stringify(data)}`);
    }
    return data;
  }

  const service = {
    request: doPost,
    // Send a text message to a chat
    send: async (chatId, text) => {
      const res = await doPost('sendMessage', { chat_id: chatId, text });
      return res?.result?.message_id;
    },
    // Edit an existing message
    edit: async (chatId, messageId, text) => {
      const res = await doPost('editMessageText', { chat_id: chatId, message_id: messageId, text });
      return res?.result;
    },
    // Download a file from Telegram to destDir/filename (size-limited to 50MB)
    downloadFile: async (fileId, destDir, filename) => {
      // Step 1: getFile to retrieve file_path
      const fileInfo = await doPost('getFile', { file_id: fileId });
      const filePath = fileInfo?.result?.file_path;
      if (!filePath) throw new Error('Invalid file path from Telegram');
      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

      // Prepare destination directory
      const fs = await import('fs');
      const fsPromises = fs.promises;
      const pathMod = await import('path');
      await fsPromises.mkdir(destDir, { recursive: true });
      const safeName = sanitizeFilename(filename || pathMod.basename(filePath));
      const destPath = pathMod.join(destDir, safeName);

      // Try to download via tmux curl if available, otherwise fall back to fetch
      let downloaded = false;
      if (tmuxExecSync) {
        try {
          const cmd = `bash -lc 'curl -fsSL "${downloadUrl}" -o "${destPath}"'`;
          const res = await tmuxExecSync({
            command: cmd,
            timeout: 600000,
            workdir: workspaceRoot,
            description: 'telegram-download',
          });
          if (res?.exitCode === 0) downloaded = true;
        } catch (e) {
          // fall back to fetch on error
          downloaded = false;
        }
      }
      if (!downloaded) {
        // Fallback to native fetch streaming
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
        const total = Number(res.headers.get('content-length') || 0);
        const MAX = 50 * 1024 * 1024;
        if (total > MAX) throw new Error('File too large to download (limit 50MB)');
        const destStream = fsPromises.createWriteStream(destPath);
        await new Promise((resolve, reject) => {
          res.body.pipe(destStream);
          res.body.on('error', reject);
          destStream.on('finish', resolve);
        });
        downloaded = true;
      }
      // After download, return a small descriptor
      const stat = await fsPromises.stat(destPath);
      return { path: destPath, size: stat.size };
    },
    handleWebhook: (update, handlers) => {
      try {
        if (update?.message) {
          const chatId = update.message.chat?.id;
          const text = update.message.text;
          if (typeof text === 'string' && text.startsWith('/start')) {
            if (handlers?.onStart) handlers.onStart(chatId, update.message);
            return;
          }
          if (update.message.document || update.message.photo) {
            const fileId = update.message.document?.file_id || update.message.photo?.[0]?.file_id;
            if (handlers?.onFile && fileId) handlers.onFile(chatId, { fileId, fileInfo: update.message });
            return;
          }
          if (handlers?.onMessage) handlers.onMessage(chatId, text, update.message);
          return;
        }
        if (update?.callback_query) {
          const data = update.callback_query.data;
          const chatId = update.callback_query.message?.chat?.id;
          if (typeof data === 'string' && /^[a-zA-Z0-9_-]+$/.test(data)) {
            if (handlers?.onSwitch) handlers.onSwitch(chatId, data, update.callback_query);
          }
          return;
        }
      } catch (err) {
        console.error('Telegram webhook handling error', err);
      }
    },
  };

  return service;
}

export { createTelegramService };
