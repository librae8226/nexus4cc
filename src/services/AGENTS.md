# AGENTS.md — Services

**Parent:** `src/AGENTS.md`

## OVERVIEW

核心业务服务，tmux操作封装 + 任务执行 + 文件管理。

## WHERE TO LOOK

| 服务 | 文件 | 职责 |
|------|------|------|
| TmuxService | tmuxService.js | 所有tmux命令安全封装 |
| TaskService | taskService.js | claude -p 任务执行 |
| FileService | fileService.js | 文件系统操作 |
| TelegramService | telegramService.js | Bot webhook处理 |

## KEY: TmuxService

```javascript
class TmuxService {
  // session名验证
  _validateSessionName(name) // SESSION_NAME_REGEX
  
  // 核心方法
  listWindows(session)
  listSessions()
  createWindow(session, cwd, name, shellCmd)
  createSession(sessionName, cwd, initialWindowName, shellCmd)
  killWindow/killSession(session, index)
  setEnv/getEnv(session, key)
  capturePane(session, windowIndex, lines)
  hasSession/ensureSession(sessionName)
}
```

## CONVENTIONS

- **async方法**: 全部返回 Promise
- **参数验证**: session名先调用 `_validateSessionName`
- **execFileP**: promisified execFile，不用shell
- **错误处理**: try/catch → throw 或 return undefined

## ANTI-PATTERNS

- **禁止** `exec('tmux ' + session)` → 必须用 `execFile('tmux', ['has-session', '-t', session])`
- **禁止** session名含空格/中文/特殊字符

## NOTES

- `runTmuxAsync`: 返回stdout，处理Node版本差异
- `buildProxyCommand`: 构建代理环境变量字符串