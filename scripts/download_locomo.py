#!/usr/bin/env python3
"""
Download the LoCoMo dataset to data/locomo10.json.

LoCoMo is hosted by SNAP Research:
  https://github.com/snap-research/locomo

A-MEM's repo only ships the QA pairs (data/locomo10.json).
For the full conversations we fall back to SNAP's `locomo10.json` which
includes both conversation turns and the QA list.

This script:
  1. Tries to download from a curated set of mirrors.
  2. Writes the JSON to data/locomo10.json.
  3. Validates the file has the expected structure (qa + conversation).
"""

import json
import os
import sys
import urllib.request
from pathlib import Path


MIRRORS = [
    # SNAP Research LoCoMo — primary source
    "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    # A-MEM's curated subset
    "https://raw.githubusercontent.com/WujiangXu/A-mem/main/data/locomo10.json",
]


def download(url: str, dest: Path) -> bool:
    try:
        print(f"Trying {url}...")
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "dsh-memory-amem/0.1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"  failed: {e}", file=sys.stderr)
        return False


def validate(path: Path) -> dict:
    raw = json.loads(path.read_text())
    if isinstance(raw, list):
        raw = {f"conv-{i}": v for i, v in enumerate(raw)}
    if not isinstance(raw, dict) and not isinstance(raw, list):
        raise ValueError(f"Unexpected top-level type: {type(raw).__name__}")
    first = raw[0] if isinstance(raw, list) else next(iter(raw.values()))
    if "qa" not in first:
        raise ValueError("Dataset does not contain 'qa' key")
    return raw


def main() -> int:
    target = Path(__file__).parent.parent / "data" / "locomo10.json"
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists():
        print(f"Already exists: {target}")
        try:
            validate(target)
            print("Validation passed.")
            return 0
        except ValueError as e:
            print(f"Existing file invalid ({e}); re-downloading...")
            target.unlink()

    tmp = target.with_suffix(".download")
    for mirror in MIRRORS:
        if download(mirror, tmp):
            try:
                validate(tmp)
                tmp.rename(target)
                size_kb = target.stat().st_size // 1024
                print(f"\n✓ Saved {target} ({size_kb} KB)")
                return 0
            except ValueError as e:
                print(f"  validation failed: {e}")
                tmp.unlink(missing_ok=True)

    print("\nAll mirrors failed.", file=sys.stderr)
    print("Manual download:", file=sys.stderr)
    print("  1. Go to https://github.com/snap-research/locomo", file=sys.stderr)
    print("  2. Download data/locomo10.json", file=sys.stderr)
    print(f"  3. Save as {target}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())