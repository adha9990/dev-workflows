#!/usr/bin/env bash
# loops-workflow statusline wrapper：跑 claude-hud，並用 --extra-cmd 附上 loops 進度 segment。
#
# 設定法（settings.json）：
#   "statusLine": { "type": "command",
#     "command": "bash \"<此檔絕對路徑>\"" }
#
# 沒裝 claude-hud 也能用：claude-hud 找不到時，退化成只印 loops 進度。

NODE=$(command -v node || echo "/c/nvm4w/nodejs/node")
SELF=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
LOOPS_CMD="node \"${SELF}/hud-status.mjs\""   # claude-hud 在 cmd.exe 跑此命令；node 走 PATH

HUD=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/claude-hud/claude-hud/*/ 2>/dev/null \
  | awk -F/ '{ print $(NF-1) "\t" $0 }' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-)

if [ -n "$HUD" ] && [ -f "${HUD}dist/index.js" ]; then
  exec "$NODE" "${HUD}dist/index.js" --extra-cmd "$LOOPS_CMD"
else
  # 沒 claude-hud：直接印 loops 進度 label（讀 stdin 丟棄）
  cat >/dev/null 2>&1
  "$NODE" "${SELF}/hud-status.mjs" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).label||"")}catch{process.stdout.write("")}})'
fi
