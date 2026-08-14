/**
 * Memory panel client.
 *
 * Speaks JSON-RPC 2.0 over WebSocket (or HTTP if served by a backend that
 * proxies MCP HTTP). Tries the WebSocket endpoint configured at
 * window.MEMORY_CONFIG.url (defaults to /api/memory on the same origin).
 *
 * The panel exposes four operations to the user:
 *   - Browse recent
 *   - Search
 *   - Add manually
 *   - View stats
 *
 * If no backend is configured, it falls back to fetching JSON dumps from
 * the local filesystem via a static dump at `dump.json` — useful for
 * offline inspection of exported memories.
 */

const cfg = window.MEMORY_CONFIG || {};
const ENDPOINT = cfg.url || null;

const state = {
  notes: [],
  title: 'Recent memories',
  connected: false,
};

const el = {
  status: document.getElementById('status-dot'),
  storagePath: document.getElementById('storage-path'),
  statTotal: document.getElementById('stat-total'),
  statLinked: document.getElementById('stat-linked'),
  statAvg: document.getElementById('stat-avg'),
  statOldest: document.getElementById('stat-oldest'),
  statNewest: document.getElementById('stat-newest'),
  btnRecent: document.getElementById('btn-recent'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnSearch: document.getElementById('btn-search'),
  btnAdd: document.getElementById('btn-add'),
  searchInput: document.getElementById('search-input'),
  addContent: document.getElementById('add-content'),
  resultsTitle: document.getElementById('results-title'),
  resultsCount: document.getElementById('results-count'),
  results: document.getElementById('results'),
  empty: document.getElementById('empty'),
  emptyStorage: document.getElementById('empty-storage'),
  toast: ensureToast(),
};

function ensureToast() {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  return t;
}

function toast(message, kind = 'info') {
  el.toast.textContent = message;
  el.toast.className = kind === 'error' ? 'show error' : 'show';
  setTimeout(() => { el.toast.className = ''; }, 2500);
}

function setConnected(connected) {
  state.connected = connected;
  el.status.className = `dot ${connected ? 'dot-on' : 'dot-off'}`;
}

function relativeTime(ms) {
  if (!ms) return '–';
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function renderNotes(notes, title) {
  state.notes = notes;
  state.title = title;
  el.resultsTitle.textContent = title;
  el.resultsCount.textContent = notes.length === 0 ? '' : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;

  if (notes.length === 0) {
    el.results.innerHTML = '';
    el.empty.classList.remove('hidden');
    return;
  }
  el.empty.classList.add('hidden');

  el.results.innerHTML = notes.map((n) => {
    const tags = (n.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    return `
      <article class="note">
        <div class="note-header">
          <span class="note-id">${escapeHtml(n.id.slice(0, 8))}</span>
          <span class="note-time">${relativeTime(n.createdAt)}</span>
        </div>
        <div class="note-context">${escapeHtml(n.context || '')}</div>
        <div class="note-content">${escapeHtml(n.content || '').slice(0, 500)}</div>
        ${tags ? `<div class="note-tags">${tags}</div>` : ''}
        <div class="note-meta">
          <span>🔗 ${n.links || 0} links</span>
          <span>🏷 ${(n.tags || []).length} tags</span>
        </div>
      </article>
    `;
  }).join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ----- Backend transport -----
//
// We talk MCP over WebSocket when the host page exposes one (DSH web UI
// proxies /api/memory), otherwise we fall back to fetching a static
// dump.json produced by `node scripts/dump_memory.js`.

let socket = null;
let nextId = 1;
const pending = new Map();

function connectWebSocket() {
  if (!ENDPOINT) return false;
  const ws = new WebSocket(ENDPOINT);
  socket = ws;
  ws.addEventListener('open', () => {
    setConnected(true);
    refreshAll();
  });
  ws.addEventListener('close', () => {
    setConnected(false);
    setTimeout(() => { if (socket === ws) connectWebSocket(); }, 2000);
  });
  ws.addEventListener('error', () => { setConnected(false); });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const pending2 = pending.get(msg.id);
    if (pending2) {
      pending.delete(msg.id);
      pending2.resolve(msg.result);
    }
  });
  return true;
}

function rpc(method, params) {
  if (!socket || socket.readyState !== 1) {
    return Promise.reject(new Error('not connected'));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ----- Operations -----

async function loadStats() {
  try {
    let stats;
    if (socket) stats = await callTool('memory_stats', {});
    else stats = await loadFromDump('stats');
    el.statTotal.textContent = stats.total ?? 0;
    el.statLinked.textContent = stats.withLinks ?? 0;
    el.statAvg.textContent = (stats.avgLinks ?? 0).toFixed(1);
    el.statOldest.textContent = stats.oldest ? new Date(stats.oldest).toLocaleDateString() : '–';
    el.statNewest.textContent = stats.newest ? new Date(stats.newest).toLocaleDateString() : '–';
  } catch (err) {
    toast('Failed to load stats: ' + err.message, 'error');
  }
}

async function loadRecent() {
  try {
    let data;
    if (socket) data = await callTool('memory_recent', { limit: 20 });
    else data = await loadFromDump('recent');
    renderNotes(data.notes || [], 'Recent memories');
  } catch (err) {
    toast('Failed to load recent: ' + err.message, 'error');
  }
}

async function search(query) {
  try {
    let data;
    if (socket) data = await callTool('memory_search', { query, k: 20 });
    else data = await loadFromDump('search', query);
    renderNotes(data.notes || [], `Search: "${query}"`);
  } catch (err) {
    toast('Search failed: ' + err.message, 'error');
  }
}

async function addMemory(content) {
  try {
    await callTool('memory_add', { content });
    toast('Remembered.');
    el.addContent.value = '';
    await refreshAll();
  } catch (err) {
    toast('Add failed: ' + err.message, 'error');
  }
}

async function refreshAll() {
  await Promise.all([loadStats(), loadRecent()]);
}

// ----- Offline dump fallback -----
//
// When no WebSocket is configured, fetch `dump.json` shipped alongside
// the HTML. This makes the panel usable for static inspection of
// exported memory dumps.

async function loadFromDump(kind, query) {
  const res = await fetch('dump.json');
  if (!res.ok) throw new Error('dump.json not found');
  const data = await res.json();
  switch (kind) {
    case 'stats': return data.stats;
    case 'recent': return { notes: data.recent };
    case 'search': {
      const q = (query || '').toLowerCase();
      const hits = data.notes.filter((n) =>
        (n.content || '').toLowerCase().includes(q) ||
        (n.context || '').toLowerCase().includes(q) ||
        (n.tags || []).some((t) => t.toLowerCase().includes(q))
      );
      return { notes: hits };
    }
    default: throw new Error('unknown dump kind: ' + kind);
  }
}

// ----- Wiring -----

el.btnRecent.addEventListener('click', loadRecent);
el.btnRefresh.addEventListener('click', refreshAll);
el.btnSearch.addEventListener('click', () => {
  const q = el.searchInput.value.trim();
  if (q) search(q);
});
el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnSearch.click();
});
el.btnAdd.addEventListener('click', () => {
  const c = el.addContent.value.trim();
  if (c) addMemory(c);
});

// Boot
if (!connectWebSocket()) {
  setConnected(false);
  loadFromDump('stats').then((stats) => {
    el.statTotal.textContent = stats.total ?? 0;
    el.statLinked.textContent = stats.withLinks ?? 0;
    el.statAvg.textContent = (stats.avgLinks ?? 0).toFixed(1);
    el.statOldest.textContent = stats.oldest ? new Date(stats.oldest).toLocaleDateString() : '–';
    el.statNewest.textContent = stats.newest ? new Date(stats.newest).toLocaleDateString() : '–';
  }).catch(() => {
    el.emptyStorage.textContent = cfg.storageDir || '~/.dsh/memory-amem';
    el.empty.classList.remove('hidden');
  });
  loadFromDump('recent').then((data) => {
    renderNotes(data.notes || [], 'Recent memories');
  }).catch(() => {});
}
