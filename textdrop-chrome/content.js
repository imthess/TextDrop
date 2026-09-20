// TextDrop - content script (runs in every frame of every page)
//
// Why this gets around "no paste" sites: the text is never pasted. It is
// inserted through the browser's own text-editing command (the same path a
// keystroke takes), so no `paste` event exists for the site to cancel.
// Ctrl+V, right-click and clipboard handlers on the page are never involved.

(() => {
  'use strict';
  if (window.__textDropLoaded) return;
  window.__textDropLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const IS_TOP = window === window.top;

  const DEFAULTS = {
    items: [],
    maxItems: 20,
    panelHidden: false,
    collapsed: true,
    pos: null, // { r, b } distance from right / bottom edge
    typeMode: false,
    typeDelay: 12,
    unlockAll: false,
    unlockHosts: [],
    pressEnter: false, // press Enter after inserting
    insertMode: 'cursor', // cursor | append | replaceLast | replaceAll
    startState: 'remember', // remember | open | collapsed
  };
  const state = { ...DEFAULTS };

  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function send(msg) {
    try {
      return await api.runtime.sendMessage(msg);
    } catch {
      markStale();
      return { ok: false, reason: 'TextDrop was updated. Click the reload icon in the list to refresh this page.' };
    }
  }

  // After the extension is reloaded or updated, scripts already on open pages are
  // cut off from it. Detect that so the list can say so and offer a reload.
  let stale = false;
  let staleTimer = 0;
  const extensionAlive = () => {
    try { return !!(api.runtime && api.runtime.id); } catch { return false; }
  };
  function markStale() {
    if (stale) return;
    stale = true;
    clearInterval(staleTimer);
    if (typeof renderPanel === 'function') renderPanel();
    if (typeof toast === 'function') toast('TextDrop was updated. Reload this page to keep using it.', 'bad', 9000);
  }

  function saveSettings(patch) {
    try {
      const p = api.storage.local.set(patch);
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }

  /* =====================================================================
   * 1. Unlock mode: stop pages from blocking right-click / copy / paste
   * ===================================================================== */

  let unlockOn = false;
  let unlockStyle = null;

  const BLOCKABLE = [
    'contextmenu', 'copy', 'cut', 'paste', 'selectstart', 'dragstart',
    'beforecopy', 'beforecut', 'beforepaste',
  ];
  for (const t of BLOCKABLE) {
    window.addEventListener(t, (e) => { if (unlockOn) e.stopImmediatePropagation(); }, true);
  }
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick']) {
    window.addEventListener(t, (e) => {
      if (unlockOn && e.button === 2) e.stopImmediatePropagation();
    }, true);
  }
  window.addEventListener('keydown', (e) => {
    if (unlockOn && (e.ctrlKey || e.metaKey) && ['c', 'v', 'x', 'a'].includes((e.key || '').toLowerCase())) {
      e.stopImmediatePropagation();
    }
  }, true);

  function updateUnlock() {
    unlockOn = !!(state.unlockAll || (state.unlockHosts || []).includes(location.hostname));
    if (unlockOn && !unlockStyle) {
      unlockStyle = document.createElement('style');
      unlockStyle.textContent =
        '*,*::before,*::after{-webkit-user-select:text!important;user-select:text!important}';
      const parent = document.head || document.documentElement;
      if (parent) parent.appendChild(unlockStyle);
      else document.addEventListener('DOMContentLoaded', () => unlockStyle && document.documentElement.appendChild(unlockStyle), { once: true });
    } else if (!unlockOn && unlockStyle) {
      unlockStyle.remove();
      unlockStyle = null;
    }
  }

  /* =====================================================================
   * 2. Finding and tracking text boxes
   * ===================================================================== */

  const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  let target = null; // last text box the user was in
  let savedRange = null; // last caret position inside a contenteditable

  const isControl = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
    if (el instanceof HTMLInputElement) {
      return TEXT_TYPES.has((el.type || 'text').toLowerCase()) && !el.disabled && !el.readOnly;
    }
    return el.isContentEditable === true;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function deepActive(root = document) {
    let a = root.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function collectEditables(root = document, out = []) {
    for (const el of root.querySelectorAll('input,textarea,[contenteditable]')) {
      if (isEditable(el) && isVisible(el)) out.push(el);
    }
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) collectEditables(host.shadowRoot, out);
    }
    if (root === document) {
      // drop nested contenteditables, keep the outer editor
      return out.filter((e) => !out.some((o) => o !== e && o.contains(e)));
    }
    return out;
  }

  document.addEventListener('focusin', () => {
    const a = deepActive();
    if (a && isEditable(a)) {
      target = a;
      send({ type: 'focused' });
    }
  }, true);

  // Remember where the caret / selection was in each plain text box, so that if we
  // have to re-focus it (and the site reacts by selecting everything) we can put it back.
  const selMemory = new WeakMap();
  document.addEventListener('focusout', (e) => {
    const n = e.composedPath()[0];
    if (isControl(n)) {
      try {
        if (typeof n.selectionStart === 'number') selMemory.set(n, { start: n.selectionStart, end: n.selectionEnd });
      } catch {}
    }
  }, true);

  document.addEventListener('selectionchange', () => {
    const a = deepActive();
    if (a && a === target && !isControl(a) && a.isContentEditable) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
    }
  });

  function currentTarget() {
    const a = deepActive();
    if (a && isEditable(a)) return a;
    if (target && target.isConnected && isEditable(target) && isVisible(target)) return target;
    return null;
  }

  function focusTarget(el) {
    if (deepActive() !== el) {
      el.focus({ preventScroll: true });
      if (isControl(el)) {
        const m = selMemory.get(el);
        if (m) { try { el.setSelectionRange(m.start, m.end); } catch {} }
      } else if (el.isContentEditable) {
        restoreCaret(el);
      }
    }
    if (!isControl(el) && el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).commonAncestorContainer)) restoreCaret(el);
    }
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
  }

  function restoreCaret(el) {
    const sel = window.getSelection();
    if (!sel) return;
    let range = null;
    if (savedRange && el.contains(savedRange.commonAncestorContainer)) {
      range = savedRange;
    } else {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* =====================================================================
   * 3. Inserting text
   * ===================================================================== */

  function exec(cmd, value) {
    try { return document.execCommand(cmd, false, value); } catch { return false; }
  }

  function fallbackSetValue(el, text) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    let start = null, end = null;
    try { start = el.selectionStart; end = el.selectionEnd; } catch {}
    const value = el.value;
    if (start == null || end == null) { start = end = value.length; }
    let next = value.slice(0, start) + text + value.slice(end);
    if (el.maxLength > 0 && next.length > el.maxLength) {
      text = text.slice(0, Math.max(0, el.maxLength - (value.length - (end - start))));
      next = value.slice(0, start) + text + value.slice(end);
    }
    setter.call(el, next); // bypass framework value trackers (React etc.)
    try { el.setSelectionRange(start + text.length, start + text.length); } catch {}
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertIntoControl(el, text) {
    const before = el.value;
    const ok = exec('insertText', text);
    if (!ok || el.value === before) fallbackSetValue(el, text);
  }

  function fallbackEditable(el, str, isBreak) {
    const sel = window.getSelection();
    let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !el.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    const node = isBreak ? document.createElement('br') : document.createTextNode(str);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: isBreak ? 'insertLineBreak' : 'insertText',
      data: isBreak ? null : str,
    }));
  }

  function insertIntoEditable(el, text) {
    const lines = text.split(/\r\n|\r|\n/);
    lines.forEach((line, i) => {
      if (line && !exec('insertText', line)) fallbackEditable(el, line, false);
      if (i < lines.length - 1 && !exec('insertLineBreak')) fallbackEditable(el, '', true);
    });
  }

  function insertRaw(el, str) {
    if (isControl(el)) insertIntoControl(el, str);
    else insertIntoEditable(el, str);
  }

  /* Insert modes (Settings > "When a text box already has text"):
   *   cursor      add at the caret (replaces only what the user has selected)
   *   append      always add at the very end
   *   replaceLast swap out the text this extension inserted last time in this box
   *   replaceAll  clear the box first, then insert
   */
  const lastInsert = new WeakMap(); // element -> { start, end, text } or { range, text }

  function hasSelectionApi(el) {
    try { return typeof el.selectionStart === 'number'; } catch { return false; }
  }

  function clearValue(el) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  }

  function prepareSelection(el, mode) {
    if (mode !== 'append' && mode !== 'replaceAll' && mode !== 'replaceLast') return;
    const rec = lastInsert.get(el);
    if (isControl(el)) {
      const has = hasSelectionApi(el);
      const len = el.value.length;
      if (mode === 'append' && has) el.setSelectionRange(len, len);
      else if (mode === 'replaceAll') { if (has) el.setSelectionRange(0, len); else if (len) clearValue(el); }
      else if (mode === 'replaceLast' && has && rec && rec.text && el.value.slice(rec.start, rec.end) === rec.text) {
        el.setSelectionRange(rec.start, rec.end);
      }
      return;
    }
    const sel = window.getSelection();
    if (!sel) return;
    if (mode === 'append' || mode === 'replaceAll') {
      const r = document.createRange();
      r.selectNodeContents(el);
      if (mode === 'append') r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    } else if (rec && rec.range && !rec.range.collapsed && el.contains(rec.range.commonAncestorContainer)
      && rec.range.toString() === rec.text) {
      sel.removeAllRanges();
      sel.addRange(rec.range.cloneRange());
    }
  }

  const readText = (el) => (isControl(el) ? el.value : el.textContent || '');

  function rememberStart(el) {
    if (isControl(el)) {
      return hasSelectionApi(el) ? { start: el.selectionStart } : null;
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(true);
      return { range: r };
    }
    return null;
  }

  function rememberEnd(el, begin) {
    if (!begin) { lastInsert.delete(el); return null; }
    let rec = null;
    if (isControl(el)) {
      if (hasSelectionApi(el)) {
        const end = el.selectionEnd;
        rec = { start: begin.start, end, text: el.value.slice(begin.start, end) };
      }
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const cur = sel.getRangeAt(0);
        try { begin.range.setEnd(cur.endContainer, cur.endOffset); } catch {}
        rec = { range: begin.range, text: begin.range.toString() };
      }
    }
    if (rec) lastInsert.set(el, rec); else lastInsert.delete(el);
    return rec;
  }

  // Some sites select the text they just received, or react to it in other ways.
  // Give them a moment, put the caret after our text, and check the text stayed.
  async function settleAndVerify(el, text, before, rec, mode) {
    await sleep(60);
    try {
      if (rec && deepActive() === el) {
        if (isControl(el)) {
          if (rec.end > rec.start && el.selectionStart === rec.start && el.selectionEnd === rec.end) {
            el.setSelectionRange(rec.end, rec.end);
          }
        } else if (rec.range) {
          const sel = window.getSelection();
          if (sel && sel.rangeCount && !sel.isCollapsed) {
            const cur = sel.getRangeAt(0);
            if (cur.compareBoundaryPoints(Range.START_TO_START, rec.range) === 0 &&
                cur.compareBoundaryPoints(Range.END_TO_END, rec.range) === 0) sel.collapseToEnd();
          }
        }
      }
    } catch {}

    const after = readText(el);
    const sample = (text.split(/\r\n|\r|\n/).find((l) => l.trim()) || '').trim().slice(0, 30);
    if (!sample) return '';
    const replacing = mode === 'replaceAll' || mode === 'replaceLast';
    const unchanged = after === before;
    const vanished = !replacing && !after.includes(sample) && after.length <= before.length;
    if (unchanged || vanished) {
      return state.typeMode
        ? 'The text box did not keep the text. The site may be rejecting or clearing it.'
        : 'The text box did not keep the text. The site may be rejecting or clearing it. Try "Insert one character at a time" in Settings.';
    }
    return '';
  }

  // Presses Enter in a text box the way a keyboard would. Pages that listen for the
  // Enter key (chat boxes, search bars) get the key events. If the page did not
  // handle it, we do what the browser would: add a new line, or submit the form.
  async function pressEnter(el, text) {
    await sleep(80);
    if (!el.isConnected) return;
    if (deepActive() !== el) { try { el.focus({ preventScroll: true }); } catch {} }

    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const handled = !el.dispatchEvent(new KeyboardEvent('keydown', init));
    let pressHandled = handled;
    if (!handled) pressHandled = !el.dispatchEvent(new KeyboardEvent('keypress', init));

    if (!pressHandled) {
      // Only fall back to the browser's default if the text is still in the box;
      // if the page just sent and cleared it, adding a new line would be wrong.
      const sample = (text.split(/\r\n|\r|\n/).find((l) => l.trim()) || '').trim().slice(0, 30);
      const stillThere = !sample || readText(el).includes(sample);
      if (stillThere) {
        if (el instanceof HTMLTextAreaElement) {
          insertIntoControl(el, '\n');
        } else if (el instanceof HTMLInputElement) {
          const form = el.form;
          if (form) {
            const btn = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="image"]'))
              .find((b) => !b.disabled && ((b.type || 'submit').toLowerCase() === 'submit' || b.type === 'image'));
            if (btn) btn.click();
            else if (typeof form.requestSubmit === 'function') form.requestSubmit();
          }
        } else if (!exec('insertParagraph') && !exec('insertLineBreak')) {
          fallbackEditable(el, '', true);
        }
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // Returns a warning string if the site threw the text away, otherwise ''.
  async function doInsert(el, text) {
    focusTarget(el);
    const mode = state.insertMode;
    const before = readText(el);
    try { prepareSelection(el, mode); } catch {}
    const begin = rememberStart(el);

    if (state.typeMode) {
      for (const ch of Array.from(text)) {
        insertRaw(el, ch);
        if (state.typeDelay > 0) await sleep(state.typeDelay);
      }
    } else {
      insertRaw(el, text);
    }

    const rec = rememberEnd(el, begin);
    const warn = await settleAndVerify(el, text, before, rec, mode);
    // Never press Enter if the site rejected the text: that would submit an empty box.
    if (!warn && state.pressEnter) await pressEnter(el, text);
    return warn;
  }

  async function insertText(text) {
    if (typeof text !== 'string' || text === '') return { ok: false, reason: 'That item is empty.' };
    let el = currentTarget();
    if (!el) {
      const found = collectEditables();
      if (found.length === 0) {
        return { ok: false, reason: 'No text box found. Click into one first.' };
      }
      if (found.length === 1) {
        el = found[0];
      } else {
        startPick(text);
        return { ok: true, pending: true };
      }
    }
    target = el;
    const warn = await doInsert(el, text);
    return warn ? { ok: true, warn } : { ok: true };
  }

  /* =====================================================================
   * 4. Pick mode: choose between several text boxes
   * ===================================================================== */

  let pick = null;

  const PICK_CSS = `
    :host{all:initial}
    .box{position:fixed;box-sizing:border-box;padding:0;margin:0;background:rgba(43,72,217,.10);
      border:2px dashed #2b48d9;border-radius:6px;cursor:pointer;pointer-events:auto;font:0/0 system-ui}
    .box:hover{background:rgba(43,72,217,.22);border-style:solid}
    .tag{position:absolute;left:-2px;top:-22px;background:#2b48d9;color:#fff;font:600 12px/18px system-ui,sans-serif;
      padding:0 7px;border-radius:5px 5px 5px 0;pointer-events:none}
    .bar{position:fixed;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;
      background:#1a2230;color:#fff;font:13px/1 system-ui,sans-serif;padding:9px 10px 9px 14px;border-radius:10px;
      box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:auto}
    .bar button{font:600 12px system-ui,sans-serif;color:#fff;background:rgba(255,255,255,.16);border:0;
      border-radius:6px;padding:5px 9px;cursor:pointer}
    .bar button:hover{background:rgba(255,255,255,.28)}
  `;

  function makeHost(name) {
    const host = document.createElement(name);
    for (const [k, v] of Object.entries({
      display: 'block', position: 'fixed', top: '0', left: '0', width: '0', height: '0',
      'z-index': '2147483647', margin: '0', padding: '0', border: '0', overflow: 'visible',
    })) host.style.setProperty(k, v, 'important');
    return host;
  }

  function startPick(pending) {
    cancelPick();
    const cands = collectEditables();
    if (!cands.length) return false;

    const host = makeHost('textdrop-pick');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PICK_CSS;
    root.append(style);

    const boxes = cands.map((el, i) => {
      const b = document.createElement('button');
      b.className = 'box';
      b.dataset.act = 'choose';
      b.dataset.i = String(i);
      b.setAttribute('aria-label', `Text box ${i + 1}`);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = String(i + 1);
      b.append(tag);
      root.append(b);
      return { el, b };
    });

    const bar = document.createElement('div');
    bar.className = 'bar';
    const msg = document.createElement('span');
    msg.textContent = pending == null ? 'Click the text box to use' : 'Click the text box for your text';
    const cancel = document.createElement('button');
    cancel.dataset.act = 'cancel';
    cancel.textContent = 'Cancel (Esc)';
    bar.append(msg, cancel);
    root.append(bar);

    (document.documentElement || document.body).appendChild(host);
    pick = { host, boxes, cands, pending, raf: 0 };

    const tick = () => {
      if (!pick) return;
      for (const { el, b } of pick.boxes) {
        const r = el.getBoundingClientRect();
        const visible = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        b.style.display = visible ? '' : 'none';
        b.style.left = r.left + 'px';
        b.style.top = r.top + 'px';
        b.style.width = r.width + 'px';
        b.style.height = r.height + 'px';
      }
      pick.raf = requestAnimationFrame(tick);
    };
    tick();
    return true;
  }

  function cancelPick() {
    if (!pick) return;
    cancelAnimationFrame(pick.raf);
    pick.host.remove();
    pick = null;
  }

  async function choosePick(i) {
    if (!pick) return;
    const el = pick.cands[i];
    const text = pick.pending;
    cancelPick();
    send({ type: 'pickDone' });
    if (!el || !el.isConnected) return;
    target = el;
    focusTarget(el);
    send({ type: 'focused' });
    if (text != null) {
      const warn = await doInsert(el, text);
      if (warn) {
        if (IS_TOP) toast(warn, 'bad', 7000);
        else send({ type: 'toast', text: warn, kind: 'bad' });
      }
    }
  }

  window.addEventListener('keydown', (e) => {
    if (pick && e.key === 'Escape') {
      e.stopImmediatePropagation();
      e.preventDefault();
      cancelPick();
      send({ type: 'pickDone' });
    }
  }, true);

  /* =====================================================================
   * 5. The on-page list (top frame only)
   * ===================================================================== */

  let ui = null;
  let toastTimer = 0;
  let drag = null;
  let dragMoved = false;

  const PANEL_CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .wrap{--paper:#f3f5f9;--ink:#1a2230;--mute:#65718a;--line:#d6dce8;--accent:#2b48d9;--accent-ink:#fff;
      --ok:#17784f;--bad:#b83227;--hover:rgba(43,72,217,.10);
      position:fixed;right:16px;bottom:16px;font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}
    @media (prefers-color-scheme:dark){
      .wrap{--paper:#171d29;--ink:#e6eaf3;--mute:#8d99b3;--line:#2b3446;--accent:#8ea2ff;--accent-ink:#0f1524;
        --ok:#59d19a;--bad:#ff8d82;--hover:rgba(142,162,255,.14)}
    }
    .card{width:300px;max-height:min(62vh,460px);display:flex;flex-direction:column;overflow:hidden;
      background:var(--paper);border:1px solid var(--line);border-radius:12px;
      box-shadow:0 12px 32px rgba(15,25,60,.25)}
    .collapsed .card{display:none}
    .wrap:not(.collapsed) .pill{display:none}
    .bar{display:flex;align-items:center;gap:2px;padding:7px 6px 7px 12px;border-bottom:1px solid var(--line);cursor:grab;user-select:none}
    .title{font-weight:650;flex:1;letter-spacing:.005em}
    .count{color:var(--mute);font-variant-numeric:tabular-nums;margin-right:6px;font-size:12px}
    .ib{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:7px;background:transparent;
      color:var(--mute);cursor:pointer;padding:0}
    .ib:hover{background:var(--hover);color:var(--ink)}
    .stale .ib[data-act="reload"]{background:var(--accent);color:var(--accent-ink)}
    .ib svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .list{overflow:auto;margin:0;padding:4px;list-style:none}
    .item{display:flex;align-items:baseline;gap:10px;width:100%;padding:8px 9px;border:0;border-radius:8px;
      background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
    .item:hover{background:var(--hover)}
    .item.flash{background:var(--accent);color:var(--accent-ink)}
    .item.flash .len{color:inherit}
    .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .len{color:var(--mute);font-size:11px;font-variant-numeric:tabular-nums}
    .empty{margin:0;padding:14px 14px 16px;color:var(--mute)}
    .pill{display:flex;align-items:center;gap:8px;border:0;cursor:pointer;padding:9px 14px 9px 11px;border-radius:999px;
      background:var(--accent);color:var(--accent-ink);font:650 12px system-ui,sans-serif;
      box-shadow:0 6px 18px rgba(15,25,60,.3)}
    .pill svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .toast{position:absolute;right:0;bottom:calc(100% + 8px);width:max-content;max-width:300px;padding:8px 12px;
      border-radius:9px;background:var(--ink);color:var(--paper);font-size:12.5px;box-shadow:0 8px 22px rgba(15,25,60,.3);
      pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .15s,transform .15s}
    .toast.show{opacity:1;transform:none}
    .toast.ok{background:var(--ok);color:#fff}
    .toast.bad{background:var(--bad);color:#fff}
    @media (prefers-reduced-motion:reduce){.toast{transition:none}}
  `;

  const ICONS = {
    clip: '<svg viewBox="0 0 24 24"><rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9.5 4.5h5v2h-5zM9 11h6M9 15h4"/></svg>',
    target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    reload: '<svg viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5"/><path d="M19.5 4.5v4.5H15"/></svg>',
  };

  function h(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v; // only ever static icon markup
      else if (k.startsWith('data-')) n.dataset[k.slice(5)] = v;
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  }

  const fmtLen = (n) => (n < 1000 ? String(n) : n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(n / 1000) + 'k');

  function buildPanel() {
    if (!IS_TOP || ui || !document.documentElement) return;
    if (document.contentType && document.contentType !== 'text/html' && document.contentType !== 'application/xhtml+xml') return;

    const host = makeHost('textdrop-root');
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', {}, PANEL_CSS));

    const titleEl = h('span', { class: 'title' }, 'TextDrop');
    const countEl = h('span', { class: 'count' });
    const pillCount = h('span', {});
    const list = h('ul', { class: 'list' });
    const empty = h('p', { class: 'empty' }, 'No text yet. Click the toolbar icon to add some, or select text on a page and press Alt+Shift+S.');
    const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });

    const card = h('div', { class: 'card' },
      h('div', { class: 'bar', 'data-act': 'drag' },
        titleEl,
        countEl,
        h('button', { class: 'ib', 'data-act': 'reload', title: 'Reload this page', 'aria-label': 'Reload this page', html: ICONS.reload }),
        h('button', { class: 'ib', 'data-act': 'pick', title: 'Choose which text box to use', 'aria-label': 'Choose text box', html: ICONS.target }),
        h('button', { class: 'ib', 'data-act': 'add', title: 'Save selected text to the list', 'aria-label': 'Save selected text', html: ICONS.plus }),
        h('button', { class: 'ib', 'data-act': 'collapse', title: 'Collapse', 'aria-label': 'Collapse', html: ICONS.minus }),
      ),
      list,
      empty,
    );
    const pill = h('button', { class: 'pill', 'data-act': 'expand', title: 'Open your list' },
      h('span', { html: ICONS.clip, style: 'display:grid' }), pillCount);
    const wrap = h('div', { class: 'wrap collapsed' }, toastEl, card, pill);
    root.append(wrap);

    document.documentElement.appendChild(host);
    ui = { host, root, wrap, list, empty, countEl, pillCount, toastEl, titleEl };
    renderPanel();
    if (stale) toast('TextDrop was updated. Reload this page to keep using it.', 'bad', 9000);
  }

  function renderPanel() {
    if (!ui) return;
    ui.host.style.setProperty('display', state.panelHidden ? 'none' : 'block', 'important');
    ui.wrap.classList.toggle('collapsed', !!state.collapsed && !stale);
    ui.wrap.classList.toggle('stale', stale);
    ui.titleEl.textContent = stale ? 'Reload needed' : 'TextDrop';
    const n = state.items.length;
    ui.countEl.textContent = `${n}/${state.maxItems}`;
    ui.pillCount.textContent = n ? `${n} saved` : 'TextDrop';
    ui.empty.style.display = n ? 'none' : '';
    ui.list.textContent = '';
    state.items.forEach((it, i) => {
      const text = String(it.text ?? '');
      const first = text.trim().split(/\r\n|\r|\n/, 1)[0].slice(0, 140) || '(blank)';
      const btn = h('button', { class: 'item', 'data-act': 'insert', 'data-i': String(i), title: text.slice(0, 400) },
        h('span', { class: 't' }, first),
        h('span', { class: 'len' }, fmtLen(text.length)),
      );
      ui.list.append(h('li', {}, btn));
    });
    positionPanel();
  }

  function positionPanel() {
    if (!ui) return;
    const p = state.pos || { r: 16, b: 16 };
    ui.wrap.style.right = clamp(p.r, 0, Math.max(0, innerWidth - 48)) + 'px';
    ui.wrap.style.bottom = clamp(p.b, 0, Math.max(0, innerHeight - 40)) + 'px';
  }

  function toast(text, kind = '', ms = 2800) {
    if (!ui) return;
    clearTimeout(toastTimer);
    ui.toastEl.textContent = text;
    ui.toastEl.className = 'toast show ' + kind;
    toastTimer = setTimeout(() => { ui && (ui.toastEl.className = 'toast'); }, ms);
  }

  function togglePanel() {
    if (state.panelHidden) {
      state.panelHidden = false;
      state.collapsed = false;
      saveSettings({ panelHidden: false, collapsed: false });
    } else {
      state.collapsed = !state.collapsed;
      saveSettings({ collapsed: state.collapsed });
    }
    renderPanel();
  }

  async function panelAction(act, node) {
    switch (act) {
      case 'expand':
        state.collapsed = false;
        saveSettings({ collapsed: false });
        renderPanel();
        break;
      case 'reload':
        location.reload();
        break;
      case 'collapse':
        state.collapsed = true;
        saveSettings({ collapsed: true });
        renderPanel();
        break;
      case 'pick': {
        const r = await send({ type: 'pick' });
        if (r && r.ok) toast('Click the text box you want to use.');
        else toast((r && r.reason) || 'No text boxes found.', 'bad');
        break;
      }
      case 'add': {
        const r = await send({ type: 'saveSelection' });
        if (r && r.ok) toast('Saved to your list.', 'ok');
        else toast((r && r.reason) || 'Could not save.', 'bad');
        break;
      }
      case 'insert': {
        const item = state.items[Number(node.dataset.i)];
        if (!item) return;
        node.classList.add('flash');
        setTimeout(() => node.classList.remove('flash'), 220);
        const r = await send({ type: 'insert', text: item.text });
        if (r && r.pending) toast('Several text boxes found. Click the one you want.');
        else if (r && r.warn) toast(r.warn, 'bad', 7000);
        else if (!r || !r.ok) toast((r && r.reason) || 'Could not insert.', 'bad');
        break;
      }
    }
  }

  // Panel drag: registered BEFORE the shared handler below so it always runs.
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = dragMoved = true;
    state.pos = {
      r: clamp(drag.r - dx, 0, Math.max(0, innerWidth - 48)),
      b: clamp(drag.b - dy, 0, Math.max(0, innerHeight - 40)),
    };
    positionPanel();
  }, true);
  window.addEventListener('mouseup', () => {
    if (drag && drag.moved) saveSettings({ pos: state.pos });
    drag = null;
  }, true);
  window.addEventListener('resize', positionPanel);

  // One capture-phase handler for everything inside our own UI. Handling clicks
  // here (before the page's listeners) means "click outside to close" popups on
  // the page never see the click, so they stay open and keep your text box focused.
  const OUR_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  function onOurEvent(e) {
    const path = e.composedPath();
    const inPanel = ui && path.includes(ui.host);
    const inPick = pick && path.includes(pick.host);
    if (!inPanel && !inPick) return;

    e.stopImmediatePropagation();
    const node = path.find((n) => n.dataset && n.dataset.act);
    const act = node && node.dataset.act;

    if (e.type === 'mousedown') {
      e.preventDefault(); // keeps the caret in the page's text box
      dragMoved = false;
      if (inPanel && e.button === 0 && (act === 'drag' || act === 'expand')) {
        const p = state.pos || { r: 16, b: 16 };
        drag = { x: e.clientX, y: e.clientY, r: p.r, b: p.b, moved: false };
      }
      return;
    }
    if (e.type !== 'click' || e.button !== 0 || !act) return;
    if (dragMoved) { dragMoved = false; return; }

    if (inPick) {
      if (act === 'choose') choosePick(Number(node.dataset.i));
      else if (act === 'cancel') { cancelPick(); send({ type: 'pickDone' }); }
    } else {
      panelAction(act, node);
    }
  }
  for (const t of OUR_EVENTS) window.addEventListener(t, onOurEvent, true);

  /* =====================================================================
   * 6. Wiring
   * ===================================================================== */

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'doInsert':
        insertText(msg.text).then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e) }));
        return true;
      case 'startPick':
        sendResponse({ ok: startPick(null) });
        return false;
      case 'cancelPick':
        cancelPick();
        return false;
      case 'togglePanel':
        if (IS_TOP) togglePanel();
        return false;
      case 'toast':
        if (IS_TOP) toast(msg.text, msg.kind);
        return false;
    }
    return false;
  });

  function applySettings(patch) {
    for (const k of Object.keys(DEFAULTS)) {
      if (k in patch) state[k] = patch[k] === undefined ? DEFAULTS[k] : patch[k];
    }
    if (!Array.isArray(state.items)) state.items = [];
    updateUnlock();
    renderPanel();
  }

  // Each page keeps its own open/collapsed state and position while it is open;
  // the saved values only decide how the NEXT page starts.
  const ready = (async function init() {
    try { applySettings(await api.storage.local.get(null)); } catch {}
    if (state.startState === 'open') state.collapsed = false;
    else if (state.startState === 'collapsed') state.collapsed = true;
    try {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const patch = {};
        for (const k in changes) patch[k] = changes[k].newValue;
        delete patch.collapsed;
        delete patch.pos;
        applySettings(patch);
      });
    } catch {}
  })();

  if (IS_TOP) {
    staleTimer = setInterval(() => { if (!extensionAlive()) markStale(); }, 1500);
    const go = () => ready.then(buildPanel);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }
})();
