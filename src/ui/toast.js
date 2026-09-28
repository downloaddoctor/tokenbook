// Bottom-left auto-dismiss toast (5s). New toast replaces the current one.
// kind: 'ok' | 'err' | 'warn' | undefined (colors the left border).
// Default export = singleton; named toast/clearToast are bound methods.

const TOAST_MS = 5000;
const HISTORY_MAX = 100;

class Toast {
  constructor() {
    this._timer = null;
    // Ring of recent messages. Lets the Log dialog show what the operator saw,
    // even after toasts auto-dismiss. Not persisted (session-only).
    this._history = [];
  }

  // Recent { at, kind, text } entries, oldest first.
  history() {
    return this._history.slice();
  }

  _remember(text, kind) {
    this._history.push({ at: Date.now(), kind: kind || '', text });
    if (this._history.length > HISTORY_MAX) this._history.shift();
  }

  show(text, kind) {
    const host = document.getElementById('toast-host');
    if (!host) return;
    if (text == null || text === '') {
      host.replaceChildren();
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      return;
    }
    this._remember(text, kind);
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
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      el.remove();
    });
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      el.classList.remove('in');
      setTimeout(() => el.remove(), 200);
    }, TOAST_MS);
  }

  clear() {
    const host = document.getElementById('toast-host');
    if (host) host.replaceChildren();
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

const toast = new Toast();

// Bound named exports so `import { toast, clearToast }` keeps working.
const show = toast.show.bind(toast);
const clearToast = toast.clear.bind(toast);
const toastHistory = toast.history.bind(toast);

export { show as toast, clearToast, toastHistory };
export default toast;
