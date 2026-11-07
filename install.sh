#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_TARGET="$DSH_HOME/plugin-sources/dsh-okx-tradingagents"
SKILL_TARGET="$DSH_HOME/skills/okx-tradingagents"
DATA_ROOT="$DSH_HOME/okx-tradingagents"

echo "DSH home: $DSH_HOME"
[ -d "$REPO_ROOT/plugin" ] || { echo "plugin/ not found" >&2; exit 1; }
[ -f "$REPO_ROOT/skill/SKILL.md" ] || { echo "skill/SKILL.md not found" >&2; exit 1; }

rm -rf "$PLUGIN_TARGET"
mkdir -p "$PLUGIN_TARGET" "$SKILL_TARGET" "$DATA_ROOT/reports" "$DATA_ROOT/paper"
cp -R "$REPO_ROOT/plugin/." "$PLUGIN_TARGET/"
cp "$REPO_ROOT/skill/SKILL.md" "$SKILL_TARGET/SKILL.md"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Node 20+ is required but 'node' was not found on PATH." >&2
  exit 1
fi

cat > "$PLUGIN_TARGET/cordis.patch.yml" <<EOF
- insert:
    - id: okx-tradingagents-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: okx
        transport: stdio
        command: '$NODE_BIN'
        args:
          - '$PLUGIN_TARGET/server.mjs'
        cwd: '$PLUGIN_TARGET'
        env:
          OKX_REPORT_DIR: '$DATA_ROOT/reports'
          OKX_PAPER_STATE: '$DATA_ROOT/paper/account.json'
          OKX_LIVE_STATE: '$DATA_ROOT/live/state.json'
        toolCallTimeoutMs: 180000
        failOnStartupError: true
EOF

cat "$PLUGIN_TARGET/preset.patch.yml" >> "$PLUGIN_TARGET/cordis.patch.yml"

echo ""
echo "Installed:"
echo "  plugin: $PLUGIN_TARGET"
echo "  skill:  $SKILL_TARGET"
echo "  data:   $DATA_ROOT"
echo ""
echo "Next:"
echo "  1. Open DSH -> Settings -> Plugin Manager -> Install local bundle"
echo "  2. Choose: $PLUGIN_TARGET"
echo "  3. In chat: /okx-tradingagents"
