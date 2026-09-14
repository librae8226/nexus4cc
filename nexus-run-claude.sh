#!/bin/bash
# nexus-run-claude.sh — 以指定配置 profile 启动 claude
# 用法: nexus-run-claude.sh <profile_id> <project_absolute_path>

set -e

PROFILE="$1"
PROJECT="$2"
INTERACTIVE_SHELL="$(command -v zsh || command -v bash || echo /bin/sh)"

if [ -z "$PROFILE" ] || [ -z "$PROJECT" ]; then
    echo "[Nexus] Usage: nexus-run-claude.sh <profile> <project_path>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/data/configs/${PROFILE}.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[Nexus] Config profile '${PROFILE}' not found at ${CONFIG_FILE}"
    exit 1
fi

# ── 依赖定位 ──────────────────────────────────────────────────────────────
# 用 node 读 JSON，而不是 python3：nexus 本身就是 node 应用，node 一定在；
# 而 python3 在 macOS（自 Mojave 起不再自带）和最小化 Debian 上都没有。
# NEXUS_NODE_BIN 由 server.js 用 process.execPath 注入，确保用的就是跑 nexus 的那个 node。
NODE_BIN="${NEXUS_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "[Nexus] 未找到 node，无法读取 profile 配置：${CONFIG_FILE}"
    exit 1
fi

cfg() {
    CFG_KEY="$1" CFG_FILE="$CONFIG_FILE" "$NODE_BIN" -e \
        'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.env.CFG_FILE,"utf8"));const v=d[process.env.CFG_KEY];process.stdout.write(v==null?"":String(v))'
}

# claude 装在哪取决于安装方式（官方 install.sh → ~/.local/bin；npm -g 走 nvm/fnm/volta
# → node 版本目录；Homebrew → /opt/homebrew/bin），写死路径必然踩空，所以按优先级探测。
# 可用 CLAUDE_BIN=/path/to/claude 显式覆盖。
resolve_claude() {
    local found
    if [ -n "${CLAUDE_BIN:-}" ] && [ -x "${CLAUDE_BIN}" ]; then
        printf '%s' "${CLAUDE_BIN}"; return 0
    fi
    found="$(command -v claude 2>/dev/null || true)"
    if [ -n "$found" ] && [ -x "$found" ]; then
        printf '%s' "$found"; return 0
    fi
    for found in "$HOME/.local/bin/claude" /usr/local/bin/claude /opt/homebrew/bin/claude; do
        if [ -x "$found" ]; then printf '%s' "$found"; return 0; fi
    done
    return 1
}

CLAUDE_BIN="$(resolve_claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
    echo "[Nexus] 未找到 claude CLI。请安装 Claude Code，或用 CLAUDE_BIN=/path/to/claude 指定。"
    exit 1
fi

BASE_URL=$(cfg BASE_URL)
AUTH_TOKEN=$(cfg AUTH_TOKEN)
API_KEY=$(cfg API_KEY)
DEFAULT_MODEL=$(cfg DEFAULT_MODEL)
THINK_MODEL=$(cfg THINK_MODEL)
LONG_CONTEXT_MODEL=$(cfg LONG_CONTEXT_MODEL)
DEFAULT_HAIKU_MODEL=$(cfg DEFAULT_HAIKU_MODEL)
CONTEXT_TOKENS=$(cfg CONTEXT_TOKENS)
API_TIMEOUT_MS=$(cfg API_TIMEOUT_MS)
LABEL=$(cfg label)

# ── 导出所有环境变量 ──
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

# 仅当配置项非空时才设置（使用官方 API 时这些可以为空）
if [ -n "$BASE_URL" ]; then
    export ANTHROPIC_BASE_URL="$BASE_URL"
fi
if [ -n "$AUTH_TOKEN" ]; then
    export ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN"
fi
if [ -n "$API_KEY" ]; then
    export ANTHROPIC_API_KEY="$API_KEY"
fi
# 第三方 API（有 BASE_URL）才映射模型别名；Anthropic 官方留给 /model 自行控制
if [ -n "$BASE_URL" ] && [ -n "$DEFAULT_MODEL" ]; then
    export ANTHROPIC_MODEL="$DEFAULT_MODEL"
    export ANTHROPIC_SMALL_FAST_MODEL="$DEFAULT_MODEL"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$DEFAULT_MODEL"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$DEFAULT_MODEL"
fi
if [ -n "$DEFAULT_HAIKU_MODEL" ]; then
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$DEFAULT_HAIKU_MODEL"
fi
if [ -n "$THINK_MODEL" ]; then
    export ANTHROPIC_THINK_MODEL="$THINK_MODEL"
fi
if [ -n "$LONG_CONTEXT_MODEL" ]; then
    export ANTHROPIC_LONG_CONTEXT_MODEL="$LONG_CONTEXT_MODEL"
fi
if [ -n "$API_TIMEOUT_MS" ]; then
    export API_TIMEOUT_MS="$API_TIMEOUT_MS"
fi
# 第三方模型（如 deepseek-v4-flash）不在 Claude Code 已知模型表内，默认按 200k 上下文做 auto-compact。
# 通过 CONTEXT_TOKENS 显式声明真实窗口，避免提前压缩。
if [ -n "$CONTEXT_TOKENS" ]; then
    export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$CONTEXT_TOKENS"
fi
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# ── 代理变量：优先使用 NEXUS_PROXY（server.js 注入），其次继承环境 ──
_proxy="${NEXUS_PROXY:-${HTTP_PROXY:-}}"
if [ -n "$_proxy" ]; then
    export HTTP_PROXY="$_proxy"
    export HTTPS_PROXY="$_proxy"
    export ALL_PROXY="$_proxy"
    export http_proxy="$_proxy"
    export https_proxy="$_proxy"
fi
unset _proxy

cd "$PROJECT"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Nexus · Claude Session"
echo "║  Profile : ${LABEL:-$PROFILE}"
echo "║  Project : $PROJECT"
if [ -z "$BASE_URL" ]; then
    echo "║  API     : Anthropic (官方)"
elif [[ "$BASE_URL" == *"kimi"* ]]; then
    echo "║  API     : Kimi"
elif [[ "$BASE_URL" == *"openrouter"* ]]; then
    echo "║  API     : OpenRouter"
else
    echo "║  API     : 自定义"
fi
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 主循环：退出后提示续接 ──
# 宕机恢复时 nexus-resume-claude.sh 注入以下环境变量以精确接续对话：
#   NEXUS_RESUME_SESSION=<uuid>  → claude --resume <uuid>（精确匹配到特定对话）
#   NEXUS_RESUME=1               → claude --continue（回退到 cwd 最近一条对话）
# kimi 不支持 claude -c 的 conversation resume，跳过。
_resume_arg=""
if [ -n "${NEXUS_RESUME_SESSION:-}" ] && [[ "$BASE_URL" != *kimi* ]]; then
    _resume_arg="--resume ${NEXUS_RESUME_SESSION}"
    echo "[Nexus] 宕机恢复：精确接续对话 (claude --resume ${NEXUS_RESUME_SESSION})"
elif [ -n "${NEXUS_RESUME:-}" ] && [[ "$BASE_URL" != *kimi* ]]; then
    _resume_arg="--continue"
    echo "[Nexus] 宕机恢复：接续最近对话 (claude --continue)"
fi
while true; do
    "$CLAUDE_BIN" $_resume_arg --dangerously-skip-permissions || true
    _resume_arg=""   # 仅首次接续，手动重启(r)为全新会话
    echo ""
    echo "[Nexus] Claude exited.  r=restart  b=shell  q=quit window"
    read -r REPLY
    case "$REPLY" in
        b) exec "$INTERACTIVE_SHELL" -i ;;
        q) break ;;
    esac
done

echo "[Nexus] Session ended."
# 退出后启动交互 shell 保持窗口打开（优先 zsh，回退 bash）
exec "$INTERACTIVE_SHELL" -i
