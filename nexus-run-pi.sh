#!/bin/bash
# nexus-run-pi.sh — 以指定 profile 启动 pi（https://pi.dev）
# 用法: nexus-run-pi.sh <profile_id> <project_absolute_path>
#
# 与 nexus-run-claude.sh 的关系：结构镜像，但两处关键差异 ——
#   1. pi 没有「读 ANTHROPIC_BASE_URL」这回事，第三方 endpoint 要写进 models.json；
#   2. pi 的配置目录用独立的 ~/.pi/agent-nexus，绝不碰用户自己的 ~/.pi/agent
#      （那个是 pi-durable / 手工 pi 用的），两边互不引用。
# Nexus 的 profile（data/configs/*.json）仍按原样读，不动 profile 格式。

set -e

PROFILE="$1"
PROJECT="$2"
INTERACTIVE_SHELL="$(command -v zsh || command -v bash || echo /bin/sh)"

if [ -z "$PROFILE" ] || [ -z "$PROJECT" ]; then
    echo "[Nexus] Usage: nexus-run-pi.sh <profile> <project_path>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/data/configs/${PROFILE}.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[Nexus] Config profile '${PROFILE}' not found at ${CONFIG_FILE}"
    exit 1
fi

# ── 依赖定位 ──────────────────────────────────────────────────────────────
NODE_BIN="${NEXUS_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "[Nexus] 未找到 node，无法读取 profile 配置：${CONFIG_FILE}"
    exit 1
fi

# ── pi 二进制定位 ─────────────────────────────────────────────────────────
# 装法不同路径不同：npm -g（nvm/fnm/volta）→ <node 版本目录>/bin/pi；
# 系统 node → /usr/local/bin/pi；也可用 NEXUS_PI_BIN 显式覆盖。
# 注意：nexus 进程的 PATH 里有 fnm 的 bin，但 tmux 会话未必有 —— 这里探测的是
# 「跑 nexus 的那个 node」的全局 bin，正是 npm -g 装 pi 的落点。
resolve_pi() {
    local found
    if [ -n "${NEXUS_PI_BIN:-}" ] && [ -x "${NEXUS_PI_BIN}" ]; then
        printf '%s' "${NEXUS_PI_BIN}"; return 0
    fi
    found="$(command -v pi 2>/dev/null || true)"
    if [ -n "$found" ] && [ -x "$found" ]; then
        printf '%s' "$found"; return 0
    fi
    # 跑着 nexus 的这个 node 自带的全局 bin
    found="$("$NODE_BIN" -e 'process.stdout.write(require("path").join(process.execPath,"..","pi"))' 2>/dev/null || true)"
    if [ -n "$found" ] && [ -x "$found" ]; then
        printf '%s' "$found"; return 0
    fi
    local prefix
    prefix="$("$NODE_BIN" -e 'process.stdout.write(require("path").dirname(process.execPath))' 2>/dev/null || true)"
    for found in "$prefix/pi" "$HOME/.local/bin/pi" "/usr/local/bin/pi" "/opt/homebrew/bin/pi"; do
        if [ -x "$found" ]; then printf '%s' "$found"; return 0; fi
    done
    return 1
}

PI_BIN="$(resolve_pi || true)"
if [ -z "$PI_BIN" ]; then
    echo "[Nexus] 未找到 pi CLI。请安装：npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
    echo "[Nexus] 或用 NEXUS_PI_BIN=/path/to/pi 指定。"
    exit 1
fi
PI_DIR="$(cd "$(dirname "$PI_BIN")" && pwd)"

# ── agent 目录（独立，绝不碰 ~/.pi/agent）──────────────────────────────────
PI_AGENT_DIR="${NEXUS_PI_AGENT_DIR:-$HOME/.pi/agent-nexus}"
mkdir -p "$PI_AGENT_DIR"
chmod 700 "$PI_AGENT_DIR"

# ── 生成 models.json + settings.json ──────────────────────────────────────
# 用 node 一次读完 data/configs/*.json，把「所有 profile」都写成一个 provider。
# 为什么写全部而不是只写当前 profile：Nexus 是多窗口的，两个不同 profile 的
# 窗口共用一个 agent 目录；只写自己那个会让先启动的窗口在别人启动后丢掉自己的
# provider（/model 会重新读盘）。写全部 = 内容确定 = 并发写同内容，没有竞态。
#
# 密钥不落盘：apiKey 用 "$ENV" 插值，真正明文只存在于本进程的环境变量里。
PI_META="$("$NODE_BIN" -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1], agentDir = process.argv[2], profile = process.argv[3];

// profile id → 环境变量名：非字母数字一律换成下划线并大写
const envName = (id) => "NEXUS_PI_KEY_" + id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();

const providers = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
  const id = f.replace(/\.json$/, "");
  let baseUrl = (cfg.BASE_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl) continue;   // 无 BASE_URL（Anthropic 官方）走 pi 内置 provider，见下
  const model = (cfg.DEFAULT_MODEL || "").trim();
  if (!model) continue;
  // endpoint 协议：OpenRouter 是 OpenAI 格式，其余（deepseek/kimi 的 /anthropic）是 Anthropic 格式
  const api = /openrouter\.ai/i.test(baseUrl) ? "openai-completions" : "anthropic-messages";
  // pi 对 openai-completions 是「baseUrl + /chat/completions」拼法，baseUrl 必须带 /v1。
  // 实测 openrouter.ai/api → 404，openrouter.ai/api/v1 → 通；profile 里的写法是给 claude 用的，
  // 不能直接照搬，这里补一次（已经是 /v1 结尾的不动）。
  if (api === "openai-completions" && !/\/v1$/.test(baseUrl)) baseUrl += "/v1";
  const def = { id: model };
  const ctx = parseInt(cfg.CONTEXT_TOKENS, 10);
  if (Number.isFinite(ctx) && ctx > 0) def.contextWindow = ctx;
  providers[id] = {
    baseUrl,
    api,
    apiKey: "$" + envName(id),
    // profile 的 AUTH_TOKEN 语义是 Bearer（Anthropic 的 ANTHROPIC_AUTH_TOKEN 也是这样），
    // 所以显式发 Authorization: Bearer，交给 pi 按 x-api-key 猜会 401。
    authHeader: true,
    models: [def],
  };
}

const modelsJson = { providers };
const out = {
  models: JSON.stringify(modelsJson, null, 2),
  // 只有 settings.json 里的 defaultProjectTrust 能免掉无人值守窗口的信任提示
  // （等价于 claude 侧的 --dangerously-skip-permissions 在 Nexus 里的用法：自己的项目目录）。
  settings: JSON.stringify({ defaultProjectTrust: "always" }, null, 2),
};

// 原子写：同目录临时文件 + rename，权限 600
for (const [key, name] of [["models", "models.json"], ["settings", "settings.json"]]) {
  const tmp = path.join(agentDir, "." + name + ".tmp" + process.pid);
  fs.writeFileSync(tmp, out[key] + "\n", { mode: 0o600 });
  fs.renameSync(tmp, path.join(agentDir, name));
}

// 当前 profile 用哪个 provider / model / 密钥环境变量
const cfg = JSON.parse(fs.readFileSync(path.join(dir, profile + ".json"), "utf8"));
const baseUrl = (cfg.BASE_URL || "").trim();
const line = (k, v) => process.stdout.write(k + "=" + v + "\n");
if (baseUrl) {
  line("PI_PROVIDER", profile);
} else {
  // 官方 Anthropic：走 pi 内置 provider，凭据来自 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
  line("PI_PROVIDER", "anthropic");
}
line("PI_MODEL", (cfg.DEFAULT_MODEL || "").trim());
line("PI_KEY_ENV", envName(profile));
' "$SCRIPT_DIR/data/configs" "$PI_AGENT_DIR" "$PROFILE")"

PI_PROVIDER="$(printf '%s\n' "$PI_META" | sed -n 's/^PI_PROVIDER=//p')"
PI_MODEL="$(printf '%s\n' "$PI_META" | sed -n 's/^PI_MODEL=//p')"
PI_KEY_ENV="$(printf '%s\n' "$PI_META" | sed -n 's/^PI_KEY_ENV=//p')"

# ── 读取 profile 字段 ─────────────────────────────────────────────────────
cfg() {
    CFG_KEY="$1" CFG_FILE="$CONFIG_FILE" "$NODE_BIN" -e \
        'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.env.CFG_FILE,"utf8"));const v=d[process.env.CFG_KEY];process.stdout.write(v==null?"":String(v))'
}

BASE_URL="$(cfg BASE_URL)"
AUTH_TOKEN="$(cfg AUTH_TOKEN)"
API_KEY="$(cfg API_KEY)"
LABEL="$(cfg label)"

export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

# ── 凭据：只导出本轮要用的那一个 ──────────────────────────────────────────
if [ -n "$BASE_URL" ]; then
    # 自定义 provider：apiKey 用 $ENV 插值，明文只在本进程环境里
    if [ -n "$AUTH_TOKEN" ]; then
        export "${PI_KEY_ENV}=${AUTH_TOKEN}"
    elif [ -n "$API_KEY" ]; then
        export "${PI_KEY_ENV}=${API_KEY}"
    fi
else
    # 内置 anthropic：按 pi 认的变量名导出
    if [ -n "$API_KEY" ]; then
        export ANTHROPIC_API_KEY="$API_KEY"
    fi
    if [ -n "$AUTH_TOKEN" ]; then
        export ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN"
    fi
fi

# ── 代理变量：优先 NEXUS_PROXY（server.js 注入），其次继承环境 ─────────────
_proxy="${NEXUS_PROXY:-${HTTP_PROXY:-}}"
if [ -n "$_proxy" ]; then
    export HTTP_PROXY="$_proxy"
    export HTTPS_PROXY="$_proxy"
    export ALL_PROXY="$_proxy"
    export http_proxy="$_proxy"
    export https_proxy="$_proxy"
fi
unset _proxy

export PI_CODING_AGENT_DIR="$PI_AGENT_DIR"

cd "$PROJECT"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Nexus · Pi Session"
echo "║  Profile : ${LABEL:-$PROFILE}"
echo "║  Project : $PROJECT"
echo "║  Model   : ${PI_PROVIDER}/${PI_MODEL}"
echo "║  Agent   : $PI_AGENT_DIR"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 续接参数（宕机恢复）──────────────────────────────────────────────────
#   NEXUS_RESUME_SESSION=<uuid> → pi --session <uuid>
#   NEXUS_RESUME=1              → pi --continue
_resume_arg=()
if [ -n "${NEXUS_RESUME_SESSION:-}" ]; then
    _resume_arg=(--session "$NEXUS_RESUME_SESSION")
    echo "[Nexus] 宕机恢复：接续 pi 会话 ($NEXUS_RESUME_SESSION)"
elif [ -n "${NEXUS_RESUME:-}" ]; then
    _resume_arg=(--continue)
    echo "[Nexus] 宕机恢复：接续最近 pi 会话"
fi

# ── 预置开场白（救援 agent 用）──
_prompt_arg=()
if [ -n "${NEXUS_INITIAL_PROMPT:-}" ]; then
    _prompt_arg=("$NEXUS_INITIAL_PROMPT")
    echo "[Nexus] 带预置任务启动（救援模式）"
fi

while true; do
    "$PI_BIN" --provider "$PI_PROVIDER" --model "$PI_MODEL" "${_resume_arg[@]}" "${_prompt_arg[@]}" || true
    _resume_arg=()   # 仅首次接续，手动重启(r)为全新会话
    _prompt_arg=()   # 预置开场白也只带一次
    echo ""
    echo "[Nexus] Pi exited.  r=restart  b=shell  q=quit window"
    read -r REPLY
    case "$REPLY" in
        b) exec "$INTERACTIVE_SHELL" -i ;;
        q) break ;;
    esac
done

echo "[Nexus] Session ended."
exec "$INTERACTIVE_SHELL" -i
