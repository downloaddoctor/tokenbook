// Shared context for the register page modules. Holds the DOM bag (`b`), the
// cross-module hook registry, and a few mutable flags. This lets billing /
// autofill / dialogs modules share state WITHOUT circular imports: each module
// registers its public functions here and calls siblings by name.

let b = null;

const flags = {
  submitting: false,
  tokenEdited: false,
  loadedVisitId: null,
};

// Cross-module function registry. Modules call register.ctx.call('name', ...).
const hooks = new Map();

export function setB(next) {
  b = next;
}
export function getB() {
  return b;
}
export function getFlags() {
  return flags;
}
export function setHook(name, fn) {
  hooks.set(name, fn);
}
export function call(name, ...args) {
  const fn = hooks.get(name);
  if (!fn) throw new Error('register ctx: no hook registered for ' + name);
  return fn(...args);
}
