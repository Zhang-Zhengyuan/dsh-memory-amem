#!/usr/bin/env node
/**
 * Dump all memory notes + stats to a single JSON file for offline browsing.
 *
 * Usage:
 *   node scripts/dump_memory.js [storage_dir] [out_path]
 *
 * Defaults:
 *   storage_dir = ~/.dsh/memory-amem
 *   out_path    = web/dump.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const storageDir = process.argv[2]
  || path.join(os.homedir(), '.dsh', 'memory-amem');
const outPath = process.argv[3] || path.join('web', 'dump.json');

const notesDir = path.join(storageDir, 'notes');
let files = [];
try { files = await fs.readdir(notesDir); }
catch (err) {
  console.error(`Cannot read ${notesDir}: ${err.message}`);
  process.exit(1);
}

const notes = [];
for (const file of files) {
  if (!file.endsWith('.json')) continue;
  try {
    const raw = await fs.readFile(path.join(notesDir, file), 'utf-8');
    const note = JSON.parse(raw);
    notes.push({
      id: note.id,
      content: note.content,
      context: note.context,
      keywords: note.keywords || [],
      tags: note.tags || [],
      links: (note.links || []).length,
      createdAt: note.createdAt,
    });
  } catch (err) {
    console.error(`Skip ${file}: ${err.message}`);
  }
}

notes.sort((a, b) => b.createdAt - a.createdAt);

const total = notes.length;
const withLinks = notes.filter((n) => n.links > 0).length;
const avgLinks = total === 0 ? 0 : notes.reduce((acc, n) => acc + n.links, 0) / total;
const timestamps = notes.map((n) => n.createdAt).filter(Boolean);
const stats = {
  total,
  withLinks,
  avgLinks,
  oldest: timestamps.length ? Math.min(...timestamps) : 0,
  newest: timestamps.length ? Math.max(...timestamps) : 0,
};

const recent = notes.slice(0, 20);
const dump = { stats, recent, notes };

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(dump, null, 2));

console.log(`Wrote ${total} notes + stats to ${outPath}`);
