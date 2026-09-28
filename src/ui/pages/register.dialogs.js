// Register dialogs: identity-change / reassign prompts. Pure DOM — no shared
// module state, so they live apart from the form orchestrator.
// askIdentityChange -> 'update' | 'new' | 'cancel'
// askReassign       -> 'reassign' | 'cancel'

import { showModal } from '../dom.js';

// Ask how to proceed when the form's identity differs from the linked patient.
export function askIdentityChange(person, current) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('pat-id-confirm');
    const sub = document.getElementById('pat-id-confirm-sub');
    const body = document.getElementById('pat-id-confirm-body');
    if (!dlg || !sub || !body) {
      console.warn('pat-id-confirm dialog markup missing; skipping prompt');
      return resolve('update');
    }

    sub.textContent = `Currently linked to patient #${person.rootId}.`;
    body.replaceChildren();
    const dl = document.createElement('dl');
    const row = (label, from, to) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      const f = from == null || from === '' ? '—' : String(from);
      const t = to == null || to === '' ? '—' : String(to);
      dd.textContent = f === t ? f : `${f} → ${t}`;
      dl.append(dt, dd);
    };
    row('Name', person.name, current.name);
    row('Mobile', person.mob, current.mob);
    row('Age', person.age, current.age);
    row('Gender', person.gender || '', current.gender || '');
    body.appendChild(dl);

    // Empty returnValue means Esc (or close without a button) -> cancel.
    showModal(dlg).then((v) => resolve(v === 'update' || v === 'new' ? v : 'cancel'));
  });
}

// Variant: form identity matches an EXISTING patient (not the linked one).
// "Update" would collide, so only Reassign or Cancel are offered. Reuses the
// same dialog element; falls back to 'reassign' if markup is missing.
export function askReassign(linked, other, current) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('pat-id-confirm');
    const title = document.getElementById('pat-id-confirm-title');
    const sub = document.getElementById('pat-id-confirm-sub');
    const body = document.getElementById('pat-id-confirm-body');
    const actions = document.getElementById('pat-id-confirm-actions');
    if (!dlg || !sub || !body || !actions) return resolve('reassign');
    if (title) title.textContent = 'Reassign to existing patient?';
    // Replace action buttons for this variant: Cancel + Reassign.
    actions.replaceChildren();
    const cancel = document.createElement('button');
    cancel.type = 'submit';
    cancel.value = 'cancel';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.value = 'reassign';
    ok.className = 'primary';
    ok.textContent = 'Reassign';
    actions.append(cancel, ok);
    sub.textContent = `Currently linked to patient #${linked.rootId}. A different patient already has this name + mobile.`;
    body.replaceChildren();
    const dl = document.createElement('dl');
    const row = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value == null || value === '' ? '—' : String(value);
      dl.append(dt, dd);
    };
    row('Currently linked', `#${linked.rootId} ${linked.name}`);
    row('Reassign to', `#${other.rootId} ${other.name}`);
    row('Mobile', other.mob);
    body.appendChild(dl);
    const restore = () => {
      if (title) title.textContent = 'Update patient?';
      actions.replaceChildren();
      const c = document.createElement('button');
      c.type = 'submit';
      c.value = 'cancel';
      c.textContent = 'Cancel';
      const n = document.createElement('button');
      n.type = 'submit';
      n.value = 'new';
      n.textContent = 'Use as new patient';
      const u = document.createElement('button');
      u.type = 'submit';
      u.value = 'update';
      u.className = 'primary';
      u.textContent = 'Update patient';
      actions.append(c, n, u);
    };
    showModal(dlg).then((v) => {
      restore();
      resolve(v === 'reassign' ? 'reassign' : 'cancel');
    });
  });
}
