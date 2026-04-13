# AGENTS.md — Middleware

**Parent:** `src/AGENTS.md`

## OVERVIEW

Express中间件：认证 + 输入验证 + 限流。

## WHERE TO LOOK

| 中间件 | 文件 | 职责 |
|------|------|------|
| authMiddleware | auth.js | JWT验证（Bearer + cookie） |
| validators | validators.js | 请求参数验证 |
| rateLimit | rateLimit.js | IP限流 |

## KEY: auth.js

```javascript
// 支持两种认证方式
authMiddleware:  Bearer header 或 nexus_token cookie
cookieAuthMiddleware: 仅cookie

// Token创建
createJwtToken()     // 15min access token
createRefreshToken() // 7d refresh token

// Cookie操作
setAuthCookie(res, token)  // httpOnly + secure + sameSite=strict
clearAuthCookie(res)
```

## CONVENTIONS

- **JWT验证**: `jwt.verify(token, JWT_SECRET)`
- **认证失败**: `res.status(401).json({ error: 'unauthorized' })`
- **成功标记**: `req.authenticated = true` → next()

## ANTI-PATTERNS

- **禁止** 在auth外读取JWT_SECRET → 从config/env导入
- **禁止** cookie设置去掉 httpOnly/secure

## NOTES

- cookie有效期: 7天
- access token: 15分钟（短）