// timeAgo(when, {compact?, fallback?}) -> relative-time string.
// when: ISO string | epoch-ms number | Date.
// compact: '5m ago' / default: '5 min ago'. fallback returned on unparseable input.
export function timeAgo(when, { compact = false, fallback = '' } = {}) {
  let t;
  if (when instanceof Date) t = when.getTime();
  else if (typeof when === 'number') t = when;
  else if (typeof when === 'string' && when) t = Date.parse(when);
  else t = NaN;
  if (!Number.isFinite(t)) return fallback;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (compact) {
    if (m < 60) return Math.round(m) + 'm ago';
    const h = m / 60;
    if (h < 24) return Math.round(h) + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
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
