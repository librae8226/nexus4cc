#!/bin/bash
# nexus-run-claude.sh — 以指定配置 profile 启动 claude
# 用法: nexus-run-claude.sh <profile_id> <project_absolute_path>

set -e

PROFILE="$1"
PROJECT="$2"

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

# 用 python3 读取 JSON 配置（python3 已在 cc:nexus 中安装）
cfg() {
    python3 -c "import json; d=json.load(open('${CONFIG_FILE}')); print(d.get('$1',''))"
}

BASE_URL=$(cfg BASE_URL)
AUTH_TOKEN=$(cfg AUTH_TOKEN)
API_KEY=$(cfg API_KEY)
DEFAULT_MODEL=$(cfg DEFAULT_MODEL)
THINK_MODEL=$(cfg THINK_MODEL)
LONG_CONTEXT_MODEL=$(cfg LONG_CONTEXT_MODEL)
DEFAULT_HAIKU_MODEL=$(cfg DEFAULT_HAIKU_MODEL)
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
while true; do
    # kimi 不支持 claude -c 的 conversation resume，直接启动（历史通过左侧 Sessions 面板访问）
    claude --dangerously-skip-permissions || true
    echo ""
    echo "[Nexus] Claude exited.  r=restart  b=bash shell  q=quit window"
    read -r REPLY
    case "$REPLY" in
        b) exec bash -i ;;
        q) break ;;
    esac
done

echo "[Nexus] Session ended."
# 退出后启动 bash 保持窗口打开（防止用户意外关闭窗口）
exec bash -i
