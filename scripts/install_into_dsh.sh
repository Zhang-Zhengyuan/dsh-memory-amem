#!/usr/bin/env bash
# install_into_dsh.sh — Install dsh-memory-amem into a DeepSeek Harness
# web profile, mirroring the canonical flow from
# https://github.com/zhu1090093659/dsh-web-ui (the 1.8k-star DSH plugin
# family). The four steps the upstream docs document:
#
#   1. clone
#   2. pnpm install && pnpm run build
#   3. node scripts/link-profile.mjs
#      dsh plugin --profile web add link:<repo>
#   4. dsh web
#
# This script runs steps 2–3 against an existing dsh-memory-amem checkout
# and an existing deepseek-harness checkout. Step 4 is deliberately left
# to the caller (you want to start DSH yourself with your own flags).
#
# Usage:
#   bash scripts/install_into_dsh.sh [path/to/deepseek-harness]
#   bash scripts/install_into_dsh.sh --unlink [path/to/deepseek-harness]
#
# Default DSH dir: ../../deepseek-harness relative to this repo.
#
# Re-runnable: every step is idempotent. `--unlink` removes the link and
# `dsh plugin remove` entry so the plugin disappears cleanly.

set -euo pipefail

DSH_DIR=""
UNLINK="false"
for arg in "$@"; do
  case "$arg" in
    --unlink) UNLINK="true" ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *)        DSH_DIR="$arg" ;;
  esac
done

if [ -z "${DSH_DIR}" ]; then
  DSH_DIR="$(cd ../../deepseek-harness 2>/dev/null && pwd || true)"
fi
if [ -z "${DSH_DIR}" ] || [ ! -d "${DSH_DIR}" ]; then
  echo "usage: $0 [path/to/deepseek-harness]"
  echo "  default: ../../deepseek-harness relative to this repo"
  exit 1
fi
if [ ! -d "${DSH_DIR}/apps/cli" ]; then
  echo "ERROR: ${DSH_DIR} does not look like a deepseek-harness checkout"
  echo "       (expected apps/cli/ to exist)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_NAME="@yourname/dsh-tool-memory-amem"

cd "${REPO_ROOT}"

# --- ensure deps on first run ---
if [ ! -d node_modules ] || [ ! -d node_modules/tsdown ]; then
  echo ">> pnpm install (first run)"
  pnpm install
fi

# --- step 2: build ---
echo ">> pnpm run build"
pnpm run build

# --- link / unlink ---
if [ "${UNLINK}" = "true" ]; then
  echo ">> unlink"
  node scripts/link-profile.mjs --unlink
  echo ">> unhide from web profile (best-effort)"
  (cd "${DSH_DIR}" && pnpm dsh plugin --profile web remove "${PKG_NAME}" 2>&1 | tail -3) || true
  echo "OK — uninstalled. Restart DSH to drop the plugin."
  exit 0
fi

# --- step 3a: link this package into the global profiles node_modules ---
echo ">> link this package into ~/.dsh/profiles/node_modules"
node scripts/link-profile.mjs

# --- step 3b: register it as a bundle layer in the web profile ---
echo ">> add ${PKG_NAME} as a bundle layer via dsh plugin"
(
  cd "${DSH_DIR}"
  # Use the absolute path so pnpm's cwd-relative path handling can't
  # silently resolve inside the profile directory (which would self-link).
  pnpm dsh plugin --profile web add "link:${REPO_ROOT}"
)

# --- verify ---
echo ">> verify the bundle layer is present"
if (cd "${DSH_DIR}" && pnpm dsh --profile web --dump-config 2>/dev/null) | grep -q "tool-memory-amem"; then
  echo "OK — bundle layer confirmed in profile 'web'"
  echo ""
  echo "Boot the web GUI with:"
  echo "  cd ${DSH_DIR}"
  echo "  pnpm dsh web"
  echo ""
  echo "After it starts, open the browser and ask the agent:"
  echo "  'use memory_search to recall what I told you last time'"
  echo ""
  echo "To uninstall later:"
  echo "  bash ${REPO_ROOT}/scripts/install_into_dsh.sh --unlink ${DSH_DIR}"
else
  echo "WARNING — could not confirm via --dump-config."
  echo "(The package may still load; restart pnpm dsh web and inspect tools.)"
  echo "If it failed with 'ERR_PNPM_IGNORED_BUILDS', see the README troubleshooting section."
fi
