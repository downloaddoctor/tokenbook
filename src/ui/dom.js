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

// Relative time, GitHub-style: 'just now', '5 min ago', '2 hours ago', etc.
// Accepts an ISO string (or ms/Date). Returns '' if unparseable.
export function timeAgo(when) {
  const t = typeof when === 'number' ? when : Date.parse(when || '');
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.round(m) + ' min ago';
  const h = m / 60;
  if (h < 24) return Math.round(h) + (Math.round(h) === 1 ? ' hour ago' : ' hours ago');
  const d = h / 24;
  if (d < 30) return Math.round(d) + (Math.round(d) === 1 ? ' day ago' : ' days ago');
  const mo = d / 30;
  if (mo < 12) return Math.round(mo) + (Math.round(mo) === 1 ? ' month ago' : ' months ago');
  const y = Math.round(mo / 12);
  return y + (y === 1 ? ' year ago' : ' years ago');
}
