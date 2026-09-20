// Non-blocking toast in the bottom-left corner. Auto-dismisses after 5s.
// A new toast replaces any existing one and restarts the timer.
// kind: 'ok' | 'err' | undefined (border-left color only).

const TOAST_MS = 5000;
let timer = null;

export function toast(text, kind) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  if (text == null || text === '') {
    host.replaceChildren();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return;
  }
  host.replaceChildren();
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  const close = document.createElement('button');
  close.className = 't-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  const body = document.createElement('span');
  body.textContent = text;
  el.append(close, body);
  close.addEventListener('click', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    el.remove();
  });
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    el.classList.remove('in');
    setTimeout(() => el.remove(), 200);
  }, TOAST_MS);
}

export function clearToast() {
  const host = document.getElementById('toast-host');
  if (host) host.replaceChildren();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
