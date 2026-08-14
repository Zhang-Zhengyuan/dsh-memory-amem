#!/usr/bin/env bash
# Robust LoCoMo dataset downloader. Tries multiple strategies to bypass
# SSL / proxy / firewall issues on macOS.
#
# Usage:
#   ./scripts/fetch_locomo.sh
#   ./scripts/fetch_locomo.sh /path/to/output.json
#
# Strategies tried, in order:
#   1. curl with system CA bundle
#   2. curl with -k (insecure, last resort)
#   3. wget (if installed)
#   4. Node.js fetch (already proven to work on some macOS)
#   5. Manual instruction

set -uo pipefail

OUT="${1:-$(dirname "$0")/../data/locomo10.json}"
mkdir -p "$(dirname "$OUT")"

URLS=(
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
  "https://raw.githubusercontent.com/WujiangXu/A-mem/main/data/locomo10.json"
  "https://cdn.jsdelivr.net/gh/snap-research/locomo@main/data/locomo10.json"
)

is_valid_json() {
  python3 -c "
import json, sys
data = json.load(open('$1'))
items = data if isinstance(data, list) else list(data.values())
print(f'OK: {len(items)} items', file=sys.stderr)
print(f'  first item keys: {list(items[0].keys())}', file=sys.stderr)
import json as _j
print(_j.dumps({'items': len(items), 'has_conv': sum(1 for it in items if 'conversation' in it)}))
" 2>&1
}

download_with_curl() {
  local url="$1"
  local out="$2"
  local insecure="${3:-}"

  if ! command -v curl >/dev/null; then
    return 1
  fi

  echo "  curl ${insecure:+-k } $url"

  # Try with system CA bundle first
  local cert=""
  for candidate in /etc/ssl/cert.pem /usr/local/etc/openssl/cert.pem /opt/homebrew/etc/openssl/cert.pem; do
    if [[ -f "$candidate" ]]; then
      cert="$candidate"
      break
    fi
  done

  if [[ -n "$cert" && -z "$insecure" ]]; then
    if curl -fsSL --cacert "$cert" "$url" -o "$out" 2>/dev/null; then
      echo "    ✓ used cert: $cert"
      return 0
    fi
  fi

  if curl -fsSL ${insecure:-} "$url" -o "$out" 2>/dev/null; then
    return 0
  fi

  return 1
}

download_with_wget() {
  local url="$1"
  local out="$2"
  local insecure="${3:-}"

  if ! command -v wget >/dev/null; then
    return 1
  fi

  echo "  wget ${insecure:+--no-check-certificate } $url"
  if wget -q ${insecure:-} "$url" -O "$out" 2>/dev/null; then
    return 0
  fi
  return 1
}

download_with_node() {
  local url="$1"
  local out="$2"

  if ! command -v node >/dev/null; then
    return 1
  fi

  echo "  node fetch $url"
  node -e "
    import('node:fs/promises').then(async ({writeFile}) => {
      try {
        const r = await fetch('$url', { redirect: 'follow' });
        if (!r.ok) { console.log('    HTTP ' + r.status); process.exit(1); }
        const t = await r.text();
        await writeFile('$out', t);
      } catch (e) { console.log('    ' + e.message); process.exit(1); }
    });
  " 2>&1
}

# ── Try each URL with each strategy ────────────────────────────────

SUCCESS=0
for url in "${URLS[@]}"; do
  echo "URL: $url"
  # Skip if already downloaded and valid
  if [[ -f "$OUT" ]] && is_valid_json "$OUT" >/dev/null 2>&1; then
    echo "  ✓ already have valid file at $OUT"
    SUCCESS=1
    break
  fi

  # Strategy 1: curl with system CA
  if download_with_curl "$url" "$OUT"; then
    echo "    ✓ curl OK"
    SUCCESS=1
    break
  fi

  # Strategy 2: curl -k (insecure)
  if download_with_curl "$url" "$OUT" "-k"; then
    echo "    ✓ curl -k OK (insecure)"
    SUCCESS=1
    break
  fi

  # Strategy 3: wget
  if download_with_wget "$url" "$OUT"; then
    echo "    ✓ wget OK"
    SUCCESS=1
    break
  fi

  # Strategy 4: wget --no-check-certificate
  if download_with_wget "$url" "$OUT" "--no-check-certificate"; then
    echo "    ✓ wget (insecure) OK"
    SUCCESS=1
    break
  fi

  # Strategy 5: node fetch
  if download_with_node "$url" "$OUT"; then
    echo "    ✓ node OK"
    SUCCESS=1
    break
  fi
done

if [[ $SUCCESS -eq 0 ]]; then
  echo ""
  echo "❌ All automatic downloads failed."
  echo ""
  echo "Try these in order:"
  echo ""
  echo "  # A) Tell Python to use the system cert bundle (most likely fix on macOS)"
  echo "  /Applications/Python\\ 3.14/Install\\ Certificates.command"
  echo ""
  echo "  # B) Open Python and run this command"
  echo "  python3 -m certifi"
  echo "  # Then set SSL_CERT_FILE env var to the printed path"
  echo ""
  echo "  # C) Manual download in browser, then move the file:"
  echo "  open https://github.com/snap-research/locomo/blob/main/data/locomo10.json"
  echo "  # Click Raw, save as: $OUT"
  echo ""
  echo "  # D) Use a VPN / different network"
  echo ""
  exit 1
fi

# Validate
echo ""
echo "Validating..."
RESULT=$(is_valid_json "$OUT" 2>&1)
echo "$RESULT"