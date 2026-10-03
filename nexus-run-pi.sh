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

# pi 包根目录 —— 只为去读它内置的模型 catalog（生成器的 host→provider 映射，见下）。
# PI_BIN 一般是指向 <root>/dist/bundle/cli.js 的软链，所以从真实路径往上三级。
# 推不出来也不要紧：生成器会退回自造 provider（老行为）。
PI_REAL="$(readlink -f "$PI_BIN" 2>/dev/null || true)"
PI_PKG_ROOT="$(cd "$(dirname "$PI_REAL")/../.." 2>/dev/null && pwd || true)"

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
const dir = process.argv[1], agentDir = process.argv[2], profile = process.argv[3], pkgRoot = process.argv[4];

// profile id → 环境变量名：非字母数字一律换成下划线并大写
const envName = (id) => "NEXUS_PI_KEY_" + id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();

// ── pi 内置 catalog 索引：host → [{ provider, models }] ────────────────────
// 目的：profile 指向的 endpoint 如果 pi 本来就认识（deepseek / moonshotai-cn /
// openrouter …），就**别再造 provider**，把 profile 交回给 pi 的内置 provider，
// 我们只注入密钥。这样 baseUrl / api / 模型清单 / 能力字段全部由 pi 的 catalog
// 提供 —— pi 升级加字段我们自动跟上，零维护，也不再需要手抄能力表。
//
// 索引是从 pi 包内的数据文件现读的（内部布局）。**读不到就整体退回自造
// provider**（下面的兜底分支，功能完整），不报错 —— 升级 pi 换了目录最多是
// 退回兜底，不会挂。
const CATALOG_DIR = path.join(
  pkgRoot || "", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"
);
const byHost = {};
let catalogRead = false;
try {
  for (const f of fs.readdirSync(CATALOG_DIR)) {
    if (!f.endsWith(".json")) continue;
    const prov = f.replace(/\.json$/, "");
    const doc = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), "utf8"));
    const models = new Set(), hosts = new Set();
    for (const grp of Object.values(doc)) {
      for (const v of Object.values(grp)) {
        if (!v || typeof v !== "object") continue;
        if (v.id) models.add(v.id);
        if (v.baseUrl) {
          try { hosts.add(new URL(v.baseUrl.replace(/\{[^}]*\}/g, "x")).host) } catch { /* 模板 URL 跳过 */ }
        }
      }
    }
    for (const h of hosts) (byHost[h] = byHost[h] || []).push({ prov, models });
  }
  catalogRead = true;
} catch { /* 读不到 catalog：所有 profile 走兜底 */ }

/**
 * profile 能不能交给 pi 的内置 provider。返回 provider id，或 null（= 自造）。
 * 判据两条：host 对得上，**且该 provider 的 catalog 里真有这个模型 id**。
 * 第二条不能省：模型不在 catalog 里的话（如 openrouter 的 x-ai/grok-4.1-fast
 * 已被上游下线），交给内置 provider 会让 pi 在启动时找不到模型而直接失败，
 * 比留在兜底分支（窗口起码能开）更糟。
 */
function builtinFor(baseUrl, model) {
  if (!catalogRead) return null;
  let host; try { host = new URL(baseUrl).host } catch { return null; }
  const hit = (byHost[host] || []).find((c) => c.models.has(model));
  return hit ? hit.prov : null;
}

const providers = {};
/** profile id → 内置 provider id（没映射上就不在表里） */
const mapped = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
  const id = f.replace(/\.json$/, "");
  let baseUrl = (cfg.BASE_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl) continue;   // 无 BASE_URL（Anthropic 官方）走 pi 内置 provider，见下
  const model = (cfg.DEFAULT_MODEL || "").trim();
  if (!model) continue;

  // ① 首选：交回 pi 的内置 provider。只写 apiKey，其它（baseUrl / api / 模型清单 /
  //    能力字段）全部由 pi 的 catalog 提供 —— 这就是「零维护」的全部代价。
  //    两个 profile 指向同一个内置 provider 时（都是 openrouter 之类）共用一条，
  //    先到的那条的密钥生效；一个 provider 本来就只能有一份凭据。
  const builtin = builtinFor(baseUrl, model);
  if (builtin) {
    mapped[id] = builtin;
    providers[builtin] = providers[builtin] || { apiKey: "$" + envName(id) };
    continue;
  }

  // ② 兜底：自造 provider。catalog 里没这个 host（公司网关、自建反代…），
  //    或 catalog 里没这个模型 id。这时只能自己写全 —— 代价是能力字段要手抄。

  // endpoint 协议：OpenRouter 是 OpenAI 格式，其余（deepseek/kimi 的 /anthropic）是 Anthropic 格式
  const api = /openrouter\.ai/i.test(baseUrl) ? "openai-completions" : "anthropic-messages";
  // pi 对 openai-completions 是「baseUrl + /chat/completions」拼法，baseUrl 必须带 /v1。
  // 实测 openrouter.ai/api → 404，openrouter.ai/api/v1 → 通；profile 里的写法是给 claude 用的，
  // 不能直接照搬，这里补一次（已经是 /v1 结尾的不动）。
  if (api === "openai-completions" && !/\/v1$/.test(baseUrl)) baseUrl += "/v1";
  // 【兜底分支专属】能力字段必须写全。models[] 里的条目是**整体替换** catalog 条目，不是打补丁
  // （provider-composer.js: applyModelsJson → models[i] = modelFromJson(...)，而
  // modelFromJson 里 reasoning 默认 false、input 默认 ["text"]、maxTokens 默认 16384）。
  // 漏写 = 对 pi 声明「这个模型不支持思考、不能看图、输出上限 16K」，而 pi 会照信 ——
  // 表现就是 thinking level 永远 off 且改不了。
  //
  // 下面的值抄自 pi 内置 catalog：
  //   node_modules/@earendil-works/pi-ai/dist/providers/data/<provider>.json
  // pi 升级后能力若有变，对着那份 JSON 更新这里（这是唯一需要手工跟进的地方）。
  //
  // thinkingLevelMap 不是装饰：getSupportedThinkingLevels() 里 **xhigh / max 只有在
  // map 里显式写了才出现**，没有 map 时最高只到 high —— 想要「最高档 = max」就必须带上它。
  const CAPS = {
    "deepseek-flash": {
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
      input: ["text", "image"],
      maxTokens: 384000,
      contextWindow: 1000000,
    },
    "kimi-k3": {
      reasoning: true,
      thinkingLevelMap: {
        off: null, minimal: null, low: "low", medium: null,
        high: "high", xhigh: null, max: "max",
      },
      input: ["text", "image"],
      maxTokens: 1048576,
      contextWindow: 1048576,
    },
    "google/gemma-4-31b-it": {
      reasoning: true,
      input: ["text", "image"],
      maxTokens: 16384,
      contextWindow: 262144,
    },
  };
  const def = { id: model, ...(CAPS[model] || {}) };
  // profile 里显式声明的上下文窗口优先（那是运维的意图），否则用 catalog 值
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
  //
  // defaultThinkingLevel：新会话的起始思考档位（pi 默认 medium）。给最高档 ——
  // 模型不支持 max 时 pi 会自己往下夹到它支持的最高档（clampThinkingLevel），不会报错。
  settings: JSON.stringify({ defaultProjectTrust: "always", defaultThinkingLevel: "max" }, null, 2),
};

// 原子写：同目录临时文件 + rename，权限 600
for (const [key, name] of [["models", "models.json"], ["settings", "settings.json"]]) {
  const tmp = path.join(agentDir, "." + name + ".tmp" + process.pid);
  fs.writeFileSync(tmp, out[key] + "\n", { mode: 0o600 });
  fs.renameSync(tmp, path.join(agentDir, name));
}

// 当前 profile 用哪个 provider / model / 密钥环境变量
const cur = JSON.parse(fs.readFileSync(path.join(dir, profile + ".json"), "utf8"));
const curBase = (cur.BASE_URL || "").trim();
const line = (k, v) => process.stdout.write(k + "=" + v + "\n");
if (!curBase) {
  // 官方 Anthropic：走 pi 内置 provider，凭据来自 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
  line("PI_PROVIDER", "anthropic");
} else {
  // 映射上内置 provider 就用它的 id；没映射上就是自造的那个（恰好 = profile id）
  line("PI_PROVIDER", mapped[profile] || profile);
}
line("PI_MODEL", (cur.DEFAULT_MODEL || "").trim());
line("PI_KEY_ENV", envName(profile));
// 让 launcher 能对「catalog 没读到 → 全体退回兜底」出声，而不是静默降级
line("PI_CATALOG", catalogRead ? "ok" : "missing");
' "$SCRIPT_DIR/data/configs" "$PI_AGENT_DIR" "$PROFILE" "$PI_PKG_ROOT")"

PI_PROVIDER="$(printf '%s\n' "$PI_META" | sed -n 's/^PI_PROVIDER=//p')"
PI_MODEL="$(printf '%s\n' "$PI_META" | sed -n 's/^PI_MODEL=//p')"
PI_KEY_ENV="$(printf '%s\n' "$PI_META" | sed -n 's/^PI_KEY_ENV=//p')"
PI_CATALOG="$(printf '%s\n' "$PI_META" | sed -n 's/^PI_CATALOG=//p')"
if [ "$PI_CATALOG" != "ok" ]; then
    echo "[Nexus] 读不到 pi 的内置 catalog，本次所有 profile 退回自造 provider（老行为，功能完整，只是能力字段要手抄）。"
fi

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
