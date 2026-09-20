// TextDrop - background script
// Routes "insert this text" requests from the on-page list to whichever frame
// (main page or iframe) holds the text box you last used, and handles shortcuts.

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULT_MAX = 20;
const frameKey = (tabId) => `frame:${tabId}`;

/* ---------- helpers ---------- */

async function getLastFrame(tabId) {
  try {
    const r = await api.storage.session.get(frameKey(tabId));
    return r[frameKey(tabId)] ?? 0;
  } catch {
    return 0;
  }
}

async function setLastFrame(tabId, frameId) {
  try {
    await api.storage.session.set({ [frameKey(tabId)]: frameId });
  } catch {}
}

async function toFrame(tabId, frameId, msg) {
  try {
    return await api.tabs.sendMessage(tabId, msg, { frameId });
  } catch {
    return undefined;
  }
}

async function toAllFrames(tabId, msg) {
  try {
    await api.tabs.sendMessage(tabId, msg);
  } catch {}
}

async function addItem(text) {
  const s = await api.storage.local.get(['items', 'maxItems']);
  const items = s.items ?? [];
  const max = s.maxItems ?? DEFAULT_MAX;
  if (items.length >= max) {
    return { ok: false, reason: `List is full (${max}). Delete an item or raise the limit.` };
  }
  items.push({ id: crypto.randomUUID(), text });
  await api.storage.local.set({ items });
  return { ok: true };
}

// Runs inside every frame of the page; must be self-contained.
function readSelection() {
  const a = document.activeElement;
  if (
    a &&
    (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') &&
    typeof a.selectionStart === 'number' &&
    a.selectionStart !== a.selectionEnd
  ) {
    return a.value.slice(a.selectionStart, a.selectionEnd);
  }
  return String(window.getSelection());
}

async function saveSelection(tabId) {
  let results;
  try {
    results = await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: readSelection,
    });
  } catch {
    return { ok: false, reason: 'This page does not allow extensions to read it.' };
  }
  const text = results.map((r) => r.result).find((t) => typeof t === 'string' && t.trim());
  if (!text) return { ok: false, reason: 'Select some text on the page first.' };
  return addItem(text);
}

/* ---------- messages from content scripts ---------- */

async function handle(msg, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false, reason: 'No tab.' };

  switch (msg.type) {
    case 'focused':
      await setLastFrame(tabId, sender.frameId);
      return { ok: true };

    case 'insert': {
      const fid = await getLastFrame(tabId);
      let res = await toFrame(tabId, fid, { type: 'doInsert', text: msg.text });
      if ((!res || !res.ok) && fid !== 0) {
        const top = await toFrame(tabId, 0, { type: 'doInsert', text: msg.text });
        if (top && (top.ok || !res)) res = top;
      }
      return res ?? { ok: false, reason: 'Could not reach the page. Refresh the tab and try again.' };
    }

    case 'pick': {
      const fid = await getLastFrame(tabId);
      const frames = fid === 0 ? [0] : [0, fid];
      const results = await Promise.all(frames.map((f) => toFrame(tabId, f, { type: 'startPick' })));
      return results.some((r) => r && r.ok)
        ? { ok: true }
        : { ok: false, reason: 'No text boxes found on this page.' };
    }

    case 'pickDone':
      await toAllFrames(tabId, { type: 'cancelPick' });
      return { ok: true };

    case 'toast':
      await toFrame(tabId, 0, { type: 'toast', text: msg.text, kind: msg.kind });
      return { ok: true };

    case 'saveSelection': {
      const res = await saveSelection(tabId);
      return res;
    }

    default:
      return { ok: false, reason: 'Unknown request.' };
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e) }));
  return true;
});

/* ---------- keyboard shortcuts ---------- */

api.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) {
    [tab] = await api.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) return;

  if (command === 'toggle-panel') {
    await toFrame(tab.id, 0, { type: 'togglePanel' });
  } else if (command === 'save-selection') {
    const res = await saveSelection(tab.id);
    await toFrame(tab.id, 0, {
      type: 'toast',
      text: res.ok ? 'Saved to your list.' : res.reason,
      kind: res.ok ? 'ok' : 'bad',
    });
  }
});

/* ---------- housekeeping ---------- */

api.runtime.onInstalled.addListener(async () => {
  const s = await api.storage.local.get(['items', 'maxItems']);
  const patch = {};
  if (!Array.isArray(s.items)) patch.items = [];
  if (typeof s.maxItems !== 'number') patch.maxItems = DEFAULT_MAX;
  if (Object.keys(patch).length) await api.storage.local.set(patch);
});

api.tabs.onRemoved.addListener((tabId) => {
  try {
    api.storage.session.remove(frameKey(tabId));
  } catch {}
});

api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    try {
      api.storage.session.remove(frameKey(tabId));
    } catch {}
  }
});
