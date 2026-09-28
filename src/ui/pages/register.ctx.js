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

// Cross-module function registry. Typed: each hook has a fixed name and
// signature, so a typo at the call site is a NameError here instead of a
// silent misroute. Modules call `hooks.setMsg(...)`, `hooks.startNewBill(...)`.
const hooks = {
  // Display a toast in the register form.
  setMsg: null,
  // Reset the form for a new bill. (nextToken?, resetDate?)
  startNewBill: null,
  // Fill the form from a visit + person.
  loadVisitIntoForm: null,
};

export function setB(next) {
  b = next;
}
export function getB() {
  return b;
}
export function getFlags() {
  return flags;
}
// Register a hook by name. Throws if the name is not part of the typed set.
export function setHook(name, fn) {
  if (!(name in hooks)) throw new Error('register ctx: unknown hook ' + name);
  hooks[name] = fn;
}
export function getHooks() {
  return hooks;
}
// Direct access: `hooks.setMsg(...)`. Callers must go through getHooks() so the
// typed shape is the only public surface.
export function call(name, ...args) {
  if (!(name in hooks)) throw new Error('register ctx: unknown hook ' + name);
  const fn = hooks[name];
  if (!fn) throw new Error('register ctx: hook not registered yet: ' + name);
  return fn(...args);
}
