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

// Keyboard dispatch: run the action bound to e.key, if any. The action returns
// false to DECLINE the key (no preventDefault, event propagates); any other
// return means handled -> e.preventDefault() is called. Removes the
// repeated if/else-if key ladder across pages.
export function onKeys(e, bindings) {
  const fn = bindings[e.key];
  if (!fn) return;
  if (fn(e) === false) return;
  e.preventDefault();
}

// Re-export; canonical location is core/time.js.
export { timeAgo } from '../core/time.js';
