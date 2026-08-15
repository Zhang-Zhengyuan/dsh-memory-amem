#!/usr/bin/env node
/**
 * Link dsh-memory-amem into the global DSH profile node_modules
 * (~/.dsh/profiles/node_modules/@yourname) so the loader resolves the
 * package name `@yourname/dsh-tool-memory-amem` at boot.
 *
 * Why this is needed (mirrors zhu1090093659/dsh-web-ui's link-profile.mjs):
 *   The dsh loader resolves plugin rows (cordis.patch.yml `name:` entries)
 *   by Node package resolution from the profile directory. The resolution
 *   walk climbs: ~/.dsh/profiles/web/node_modules → ~/.dsh/profiles/node_modules
 *   → ~/.dsh/node_modules → home. The official @deepseek-ai/* packages live
 *   in ~/.dsh/profiles/node_modules. A `dsh plugin add link:<pkg>` puts the
 *   package into the profile's own node_modules, but for out-of-tree plugins
 *   that bundle transitive deps (or for repeated runs across profiles)
 *   linking to the global layer is the durable path.
 *
 *   We symlink this single plugin into ~/.dsh/profiles/node_modules/@yourname/
 *   so every profile (`web`, `headless`, future ones) can resolve it without
 *   a per-profile install.
 *
 * Idempotent and safe to rerun: stale links pointing elsewhere are replaced,
 * unrelated entries are left untouched. Real files or directories at the link
 * path are never removed — they are reported and skipped.
 *
 * Usage:
 *   node scripts/link-profile.mjs            # link/refresh
 *   node scripts/link-profile.mjs --dry-run  # report without changing
 *   node scripts/link-profile.mjs --unlink   # remove the symlink
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolvePath(SCRIPT_DIR, '..')

/** Scope our package publishes under; the link dir must match. */
const SCOPE = '@yourname/'
/** Package name without scope, mirrored here for the script's own use. */
const PACKAGE_NAME = 'dsh-tool-memory-amem'

function report(msg) {
  console.log(`[link-profile] ${msg}`)
}

/** Pure decision logic for one link path — kept side-effect-free for testability. */
export function decideLinkAction(existing, target, currentTarget) {
  if (existing === 'missing') return 'create'
  if (existing === 'symlink') {
    return currentTarget === target ? 'keep' : 'replace'
  }
  // Real file or directory: never unlink it, just report and leave it alone.
  return 'skip-report'
}

function main() {
  const DRY = process.argv.includes('--dry-run')
  const UNLINK = process.argv.includes('--unlink')

  const HOME = process.env.HOME || homedir()
  if (!HOME) {
    report('cannot determine home directory (HOME is unset and os.homedir() is empty)')
    process.exit(1)
  }
  const PROFILES_NM = join(HOME, '.dsh', 'profiles', 'node_modules')
  const LINK_DIR = join(PROFILES_NM, SCOPE)
  const LINK_PATH = join(LINK_DIR, PACKAGE_NAME)
  const WIN32 = process.platform === 'win32'

  if (UNLINK) {
    if (!existsSync(LINK_PATH)) {
      report(`not linked, nothing to remove: ${LINK_PATH}`)
      return
    }
    let st
    try { st = lstatSync(LINK_PATH) } catch { return }
    if (!st.isSymbolicLink()) {
      report(`not a symlink, leaving untouched: ${LINK_PATH}`)
      return
    }
    if (DRY) { report(`would unlink ${LINK_PATH}`); return }
    // Windows junctions are directory reparse points; unlink EPERMs, so rmdir.
    if (WIN32 && st.isDirectory()) rmdirSync(LINK_PATH)
    else unlinkSync(LINK_PATH)
    report(`unlinked ${LINK_PATH}`)
    return
  }

  // Keep the symlink relative so the link follows the repo wherever it sits
  // (mirrors the official packages' convention).
  const target = WIN32 ? REPO_ROOT : relative(LINK_DIR, REPO_ROOT)

  if (!existsSync(PROFILES_NM)) {
    if (DRY) { report(`would create profiles node_modules: ${PROFILES_NM}`); return }
    mkdirSync(PROFILES_NM, { recursive: true })
    report(`created profiles node_modules: ${PROFILES_NM}`)
  }
  if (!existsSync(LINK_DIR)) {
    if (DRY) { report(`would create link dir: ${LINK_DIR}`); return }
    mkdirSync(LINK_DIR, { recursive: true })
    report(`created link dir: ${LINK_DIR}`)
  }

  let existing = 'missing'
  let linkIsJunctionDir = false
  try {
    const st = lstatSync(LINK_PATH)
    existing = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file'
    if (existing === 'symlink' && st.isDirectory()) linkIsJunctionDir = true
  } catch {}
  let current = null
  if (existing === 'symlink') {
    try { current = readlinkSync(LINK_PATH) } catch {}
  }
  const action = decideLinkAction(existing, target, current)
  if (action === 'keep') {
    report(`already linked: ${LINK_PATH} -> ${current}`)
    return
  }
  if (action === 'skip-report') {
    report(`skipped (not a symlink, untouched): ${LINK_PATH}`)
    return
  }
  if (action === 'create') {
    if (DRY) { report(`would link ${PACKAGE_NAME} -> ${target}`); return }
    symlinkSync(target, LINK_PATH, WIN32 ? 'junction' : undefined)
    report(`linked ${PACKAGE_NAME} -> ${target}`)
  } else {
    if (DRY) { report(`would replace ${PACKAGE_NAME} -> ${current ?? '(broken)'}`); return }
    if (linkIsJunctionDir) rmdirSync(LINK_PATH)
    else unlinkSync(LINK_PATH)
    symlinkSync(target, LINK_PATH, WIN32 ? 'junction' : undefined)
    report(`replaced ${PACKAGE_NAME} -> ${target} (was ${current ?? '(broken)'})`)
  }
}

// Run only when invoked as the entry script, so the module can be imported
// (e.g. by tests) without touching the real profile.
if (resolvePath(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main()
}
