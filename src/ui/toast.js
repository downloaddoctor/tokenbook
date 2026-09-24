// Bottom-left auto-dismiss toast (5s). New toast replaces the current one.
// kind: 'ok' | 'err' | 'warn' | undefined (colors the left border).
// Default export = singleton; named toast/clearToast are bound methods.

const TOAST_MS = 5000;

class Toast {
  constructor() {
    this._timer = null;
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

export { show as toast, clearToast };
export default toast;
export { Toast };
