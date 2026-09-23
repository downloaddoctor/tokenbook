// Tiny DOM helpers. No framework, no globals.

export function el(id) {
  return document.getElementById(id);
}

// Attach a listener and return a remover.
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

// Collector for listener teardown. Mirrors the previous bindOff() pattern
// (used by every Pages.* module): mount binds, unmount calls off().
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

export function setText(node, text) {
  if (node) node.textContent = text;
}

export function setClass(node, cls, on) {
  if (!node) return;
  if (on) node.classList.add(cls);
  else node.classList.remove(cls);
}

// Relative time lives in core/time.js; re-exported here for existing callers.
export { timeAgo } from '../core/time.js';
