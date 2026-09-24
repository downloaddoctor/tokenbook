// Tiny DOM helpers — no framework, no globals.

export function el(id) {
  return document.getElementById(id);
}

// Attach a listener; returns a remover.
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
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

export function setText(node, text) {
  if (node) node.textContent = text;
}

export function setClass(node, cls, on) {
  if (!node) return;
  if (on) node.classList.add(cls);
  else node.classList.remove(cls);
}

// Re-export; canonical location is core/time.js.
export { timeAgo } from '../core/time.js';
