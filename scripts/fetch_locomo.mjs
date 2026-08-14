#!/usr/bin/env node
// Fetch LoCoMo dataset via Node's native fetch (which uses the system's
// CA bundle more reliably than Python on macOS). Falls back to git
// raw via a CDN. This bypasses Python's CERTIFICATE_VERIFY_FAILED.
//
// Usage:
//   node scripts/fetch_locomo.mjs
//   node scripts/fetch_locomo.mjs /path/to/output.json

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultOut = resolve(__dirname, '..', 'data', 'locomo10.json');

const MIRRORS = [
  'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
  'https://raw.githubusercontent.com/WujiangXu/A-mem/main/data/locomo10.json',
  // jsDelivr is sometimes more lenient than raw.githubusercontent.com
  'https://cdn.jsdelivr.net/gh/snap-research/locomo@main/data/locomo10.json',
  'https://cdn.jsdelivr.net/gh/WujiangXu/A-mem@main/data/locomo10.json',
];

async function tryFetch(url) {
  try {
    console.log(`Trying ${url}...`);
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) {
      console.log(`  HTTP ${r.status}`);
      return null;
    }
    const text = await r.text();
    if (!text.trim().startsWith('[') && !text.trim().startsWith('{')) {
      console.log('  not JSON, skipping');
      return null;
    }
    return text;
  } catch (e) {
    console.log(`  failed: ${e.message}`);
    return null;
  }
}

async function validate(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data) && typeof data !== 'object') {
    throw new Error('top-level must be array or object');
  }
  const items = Array.isArray(data) ? data : Object.values(data);
  if (items.length === 0) throw new Error('empty');
  const first = items[0];
  if (!first.qa && !Array.isArray(first.qa)) {
    throw new Error('first item missing "qa"');
  }
  let totalConv = 0;
  for (const it of items) {
    if (it.conversation) totalConv++;
  }
  return { conversationCount: totalConv, total: items.length };
}

const outPath = process.argv[2] ? resolve(process.argv[2]) : defaultOut;
await mkdir(dirname(outPath), { recursive: true });

let text = null;
for (const url of MIRRORS) {
  text = await tryFetch(url);
  if (text) {
    try {
      const meta = await validate(text);
      console.log(`  ✓ valid JSON with ${meta.total} items, ${meta.conversationCount} with conversation`);
      break;
    } catch (e) {
      console.log(`  invalid: ${e.message}`);
      text = null;
    }
  }
}

if (!text) {
  console.error('\nAll mirrors failed.');
  console.error('Try: curl -L --cacert /etc/ssl/cert.pem <url> > data/locomo10.json');
  console.error('Or download manually from https://github.com/snap-research/locomo');
  process.exit(1);
}

await writeFile(outPath, text);
const kb = Math.round(text.length / 1024);
console.log(`\n✓ Saved ${outPath} (${kb} KB)`);