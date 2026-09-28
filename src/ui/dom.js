// Tiny DOM helpers — no framework, no globals.

// getElementById shorthand. The one shared lookup primitive.
export function el(id) {
  return document.getElementById(id);
}

// Mount/unmount listener collector. Pages call on(...) in mount, off() in unmount.
export function bindOff() {
  const offs = [];
  return {
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      offs.push([target, type, fn, opts]);
    },
    off() {
      for (const [target, type, fn, opts] of offs) target.removeEventListener(type, fn, opts);
      offs.length = 0;
    },
  };
}

// Keyboard row-highlight helper for list/table pages. Toggles `cls` on exactly
// one element and scrolls it into view. Returns the clamped index, or -1 when
// `rows` is empty. Callers keep their own active-index state.
export function highlightRow(rows, i, cls = 'active') {
  if (!rows.length) return -1;
  i = Math.max(0, Math.min(i, rows.length - 1));
  for (let k = 0; k < rows.length; k++) rows[k].classList.toggle(cls, k === i);
  rows[i].scrollIntoView({ block: 'nearest' });
  return i;
}

export function clearHighlight(rows, cls = 'active') {
  for (const r of rows) r.classList.remove(cls);
}

// True when the event target is a text-entry field. Page-level keydown handlers
// defer to the field (arrows move the caret, Enter submits, etc.).
export function isTypingTarget(t) {
  return !!(
    t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'SELECT' ||
      t.tagName === 'TEXTAREA' ||
      t.isContentEditable)
  );
}

// True when the target is any interactive control. List-nav handlers must yield
// to it so Enter/Space hit the control (button, link) instead of the list.
export function isInteractiveTarget(t) {
  return !!(
    t &&
    (isTypingTarget(t) ||
      t.tagName === 'BUTTON' ||
      t.tagName === 'A' ||
      (t.closest && t.closest('button, a, [role="tablist"]')))
  );
}

// True when any modal <dialog> is open; page-level keys must yield to it.
export function isDialogOpen() {
  return !!document.querySelector('dialog[open]');
}

// Show/hide an inline error element. showError(node, null) clears it.
export function showError(node, msg) {
  if (!node) return;
  if (msg == null || msg === '') {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = msg;
  node.hidden = false;
}

// Open a <dialog> and resolve with its returnValue when it closes. The value is
// cleared first so a stale returnValue never leaks in. Callers may attach their
// own `close` listener for extra teardown.
export function showModal(dlg) {
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue);
    };
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

// Re-export; canonical location is core/time.js.
export { timeAgo } from '../core/time.js';
