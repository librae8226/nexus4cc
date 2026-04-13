#!/bin/bash
# Nexus 重启/启动脚本
# 用法: ./start.sh                    (正常启动)
#       ./start.sh --dev              (开发模式，热重载)
#       ./start.sh --reset "密码"     (重置密码并启动)
# 每次运行都会自动清理已有进程，确保启动干净。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 颜色 ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}▶ $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $1${NC}"; }
error() { echo -e "${RED}✖ $1${NC}" >&2; exit 1; }

# ── 1. 检查 Node.js ──
command -v node >/dev/null 2>&1 || error "Node.js 未安装"
NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || error "需要 Node.js 20+，当前 $(node -v)"

# ── 2. 安装依赖 ──
if [ ! -d node_modules ]; then
  info "安装依赖..."
  npm install
fi

# ── 3. 重置密码模式 (如果指定了 --reset) ──
if [ "$1" = "--reset" ]; then
  PW="$2"
  if [ -z "$PW" ]; then
    echo -n "设置新登录密码 [回车使用 nexus123]: "
    read -r PW
    [ -z "$PW" ] && PW="nexus123"
  fi
  
  info "重置密码..."
  # 使用 stdin 传密码避免特殊字符转义问题
  HASH=$(node -e "
    const b = require('bcrypt');
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => b.hash(data.trim(), 12).then(h => console.log(h)));
  " <<< "$PW")
  
  JWT=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  
  cat > .env <<EOF
JWT_SECRET=${JWT}
ACC_PASSWORD_HASH=${HASH}
TMUX_SESSION=nexus4cc
WORKSPACE_ROOT=${SCRIPT_DIR}
PORT=3000
EOF
  chmod 600 .env
  info "密码已重置为: ${PW}"
fi

# ── 4. 生成 .env（如果不存在） ──
if [ ! -f .env ]; then
  warn ".env 不存在，正在生成..."
  PW=""
  if [ -z "$PW" ]; then
    echo -n "设置登录密码 [回车使用 nexus123]: "
    read -r PW
    [ -z "$PW" ] && PW="nexus123"
  fi
  
  HASH=$(node -e "
    const b = require('bcrypt');
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => b.hash(data.trim(), 12).then(h => console.log(h)));
  " <<< "$PW")
  
  JWT=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  
  cat > .env <<EOF
JWT_SECRET=${JWT}
ACC_PASSWORD_HASH=${HASH}
TMUX_SESSION=nexus4cc
WORKSPACE_ROOT=${SCRIPT_DIR}
PORT=3000
EOF
  chmod 600 .env
  info ".env 已生成 (密码: ${PW})"
fi

# ── 5. 检查前端构建 ──
if [ ! -d frontend/dist ] && [ -d frontend ]; then
  info "构建前端..."
  cd frontend && npm install --silent && npm run build && cd "$SCRIPT_DIR"
fi

# ── 6. 清理已有进程（确保启动干净） ──
PIDS=$(pgrep -f "node.*server\.js" 2>/dev/null) || true
if [ -n "$PIDS" ]; then
  info "检测到已有 Nexus 进程 (PID: $(echo $PIDS | tr '\n' ' '))，正在停止..."
  kill $PIDS 2>/dev/null || true
  sleep 2
  # 强制杀掉仍未退出的进程
  PIDS=$(pgrep -f "node.*server\.js" 2>/dev/null) || true
  [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true
fi
info "环境已就绪..."

# ── 7. 启动服务 ──
if [ "$1" = "--dev" ] || [ "$2" = "--dev" ]; then
  info "启动开发模式 (热重载) :${PORT:-3000}..."
  exec node --watch server.js
else
  PORT=$(grep '^PORT=' .env 2>/dev/null | cut -d'=' -f2 || echo "3000")
  info "启动 Nexus :${PORT}..."
  exec node server.js
fi
