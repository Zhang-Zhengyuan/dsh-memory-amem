#!/usr/bin/env bash
# Install dsh-memory-amem into a local DeepSeek Harness checkout.
#
# Usage:
#   bash scripts/install_into_dsh.sh /path/to/deepseek-harness
#
# Steps performed:
#   1. pnpm install in this plugin (build dependencies)
#   2. pnpm run build (tsc → dist/)
#   3. pnpm link --global (register @yourname/dsh-memory-amem)
#   4. cd into DSH, pnpm link --global @yourname/dsh-memory-amem
#   5. Print the dsh invocation the user should run.

set -euo pipefail

DSH_DIR="${1:-}"
if [ -z "$DSH_DIR" ]; then
  echo "Usage: bash scripts/install_into_dsh.sh /path/to/deepseek-harness"
  exit 1
fi
if [ ! -d "$DSH_DIR" ]; then
  echo "Not a directory: $DSH_DIR"
  exit 1
fi
if [ ! -f "$DSH_DIR/package.json" ]; then
  echo "No package.json in $DSH_DIR (is it a DSH checkout?)"
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo ">>> Building plugin in $HERE"
(cd "$HERE" && pnpm install && pnpm run build)

echo ">>> Registering global link"
(cd "$HERE" && pnpm link --global)

echo ">>> Linking into DSH at $DSH_DIR"
(cd "$DSH_DIR" && pnpm link --global @yourname/dsh-memory-amem)

cat <<EOF

Installation complete. To enable the plugin:

  cd "$DSH_DIR"
  pnpm dsh web --patch "$HERE/cordis.patch.yml"

Or, for the MCP-server variant (no DSH monorepo linkage required):

  pnpm dsh web --patch "$HERE/cordis-mcp.cordis.yml"
EOF
