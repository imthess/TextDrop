// TextDrop - popup: manage the list and settings

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let items = [];
let maxItems = 20;
let lastSaved = '';
let lastDeleted = null;
let undoTimer = 0;
let currentHost = '';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const fmt = (n) => n.toLocaleString();

/* ---------- storage ---------- */

function persist() {
  lastSaved = JSON.stringify(items);
  return api.storage.local.set({ items });
}

let saveTimer = 0;
function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 120);
}

// Popups can close at any moment, so write pending edits right away on the way out.
function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  persist();
}
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

async function load() {
  const s = await api.storage.local.get(null);
  items = Array.isArray(s.items) ? s.items : [];
  maxItems = typeof s.maxItems === 'number' ? s.maxItems : 20;
  lastSaved = JSON.stringify(items);

  $('maxItems').value = maxItems;
  $('powerToggle').checked = s.enabled !== false;
  $('offNote').hidden = s.enabled !== false;
  $('showPanel').checked = !s.panelHidden;
  $('startState').value = s.startState || 'remember';
  const mode = s.insertMode || 'cursor';
  document.querySelectorAll('input[name="insertMode"]').forEach((r) => { r.checked = r.value === mode; });
  $('pressEnter').checked = !!s.pressEnter;
  $('typeMode').checked = !!s.typeMode;
  $('typeDelay').value = typeof s.typeDelay === 'number' ? s.typeDelay : 12;
  $('delayField').hidden = !s.typeMode;
  $('unlockAll').checked = !!s.unlockAll;
  $('unlockSite').checked = !!currentHost && (s.unlockHosts || []).includes(currentHost);
  render();
}

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.items) return;
  if (JSON.stringify(changes.items.newValue ?? []) === lastSaved) return;
  if (document.activeElement && document.activeElement.matches('.list textarea')) return;
  items = changes.items.newValue ?? [];
  lastSaved = JSON.stringify(items);
  render();
});

/* ---------- rendering ---------- */

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 130) + 'px';
}

function updateCount() {
  const c = $('count');
  c.textContent = `${items.length} of ${maxItems} used`;
  c.classList.toggle('full', items.length >= maxItems);
  const full = items.length >= maxItems;
  $('addBtn').disabled = full;
  const hint = $('addHint');
  hint.classList.toggle('bad', full);
  hint.textContent = full ? 'List is full. Delete an item or raise the limit.' : 'Ctrl+Enter to add';
  $('empty').hidden = items.length > 0;
}

function iconButton(label, glyph, cls, onClick, disabled) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ib ' + (cls || '');
  b.textContent = glyph;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.disabled = !!disabled;
  b.addEventListener('click', onClick);
  return b;
}

function render() {
  const list = $('list');
  list.textContent = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');

    const ta = document.createElement('textarea');
    ta.value = item.text;
    ta.rows = 2;
    ta.setAttribute('aria-label', `Item ${i + 1}`);
    ta.addEventListener('input', () => {
      item.text = ta.value;
      len.textContent = `${fmt(ta.value.length)} characters`;
      autosize(ta);
      persistSoon();
    });

    const len = document.createElement('span');
    len.className = 'len';
    len.textContent = `${fmt(item.text.length)} characters`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.append(
      len,
      iconButton('Move up', '↑', '', () => move(i, -1), i === 0),
      iconButton('Move down', '↓', '', () => move(i, 1), i === items.length - 1),
      iconButton('Delete', '×', 'del', () => remove(i)),
    );

    li.append(ta, meta);
    list.append(li);
    autosize(ta);
  });
  updateCount();
}

/* ---------- actions ---------- */

function add() {
  const ta = $('newText');
  if (!ta.value.trim() || items.length >= maxItems) return;
  items.push({ id: uid(), text: ta.value });
  ta.value = '';
  persist();
  render();
  ta.focus();
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  persist();
  render();
}

function remove(i) {
  lastDeleted = { item: items[i], index: i };
  items.splice(i, 1);
  persist();
  render();
  $('undo').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { $('undo').hidden = true; lastDeleted = null; }, 8000);
}

function undo() {
  if (!lastDeleted) return;
  if (items.length < maxItems) {
    items.splice(Math.min(lastDeleted.index, items.length), 0, lastDeleted.item);
    persist();
    render();
  }
  lastDeleted = null;
  $('undo').hidden = true;
}

$('addBtn').addEventListener('click', add);
$('newText').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); add(); }
});
$('undoBtn').addEventListener('click', undo);

/* ---------- settings ---------- */

$('maxItems').addEventListener('change', () => {
  const n = Math.min(500, Math.max(1, Math.round(Number($('maxItems').value) || 20)));
  $('maxItems').value = n;
  maxItems = n;
  api.storage.local.set({ maxItems: n });
  updateCount();
});

$('powerToggle').addEventListener('change', () => {
  const enabled = $('powerToggle').checked;
  $('offNote').hidden = enabled;
  api.storage.local.set({ enabled });
});

$('showPanel').addEventListener('change', () => {
  api.storage.local.set({ panelHidden: !$('showPanel').checked });
});

$('pressEnter').addEventListener('change', () => {
  api.storage.local.set({ pressEnter: $('pressEnter').checked });
});

$('startState').addEventListener('change', () => {
  api.storage.local.set({ startState: $('startState').value });
});

document.querySelectorAll('input[name="insertMode"]').forEach((r) => {
  r.addEventListener('change', () => { if (r.checked) api.storage.local.set({ insertMode: r.value }); });
});

$('typeMode').addEventListener('change', () => {
  $('delayField').hidden = !$('typeMode').checked;
  api.storage.local.set({ typeMode: $('typeMode').checked });
});

$('typeDelay').addEventListener('change', () => {
  const n = Math.min(500, Math.max(0, Math.round(Number($('typeDelay').value) || 0)));
  $('typeDelay').value = n;
  api.storage.local.set({ typeDelay: n });
});

$('unlockAll').addEventListener('change', () => {
  api.storage.local.set({ unlockAll: $('unlockAll').checked });
});

$('unlockSite').addEventListener('change', async () => {
  if (!currentHost) return;
  const { unlockHosts = [] } = await api.storage.local.get('unlockHosts');
  const set = new Set(unlockHosts);
  if ($('unlockSite').checked) set.add(currentHost);
  else set.delete(currentHost);
  await api.storage.local.set({ unlockHosts: [...set] });
});

/* ---------- start ---------- */

(async function start() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') currentHost = u.hostname;
  } catch {}
  if (currentHost) {
    $('host').textContent = currentHost;
  } else {
    $('unlockSite').disabled = true;
    $('host').textContent = 'this site (open a website first)';
  }
  await load();
})();
