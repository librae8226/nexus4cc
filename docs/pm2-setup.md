# PM2 配置与启动指南 (nexus)

## ecosystem.config.cjs 内容
```js
module.exports = {
  apps: [{
    name: 'nexus',
    script: './server.js',
    cwd: '/mnt/c/Users/libra/work/nexus',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production'  // 可选：生产环境
    },
    // 日志路径（默认 ~/.pm2/logs）
    error_file: './logs/nexus-error.log',
    out_file: './logs/nexus-out.log',
    log_file: './logs/nexus-combined.log',
    time: true  // 日志带时间戳
  }]
};
```

## 启动命令序列
```bash
# 1. 先停止并删除当前 nexus 进程（安全清理）
pm2 stop nexus
pm2 delete nexus

# 2. 创建 ecosystem.config.cjs（如果手动创建，复制上方内容）
# cat > ecosystem.config.cjs << 'EOF'  # (粘贴内容) EOF

# 3. 确保日志目录存在
mkdir -p logs

# 4. 用新配置启动（会自动 save + startup）
pm2 start ecosystem.config.cjs

# 5. 保存配置（pm2 重启系统时自动恢复）
pm2 save

# 6. 查看状态
pm2 status nexus

# 7. (可选) pm2 startup（系统开机自启 pm2）
pm2 startup
```

## 验证
- `pm2 env nexus | grep CLAUDE_CONFIG_DIR`：应为空（清理成功）。
- `pm2 logs nexus`：查看日志。
- **回滚**：`pm2 delete nexus && rm ecosystem.config.cjs pm2-setup.md logs/nexus*.log`。

**日期**：2026-04-05
