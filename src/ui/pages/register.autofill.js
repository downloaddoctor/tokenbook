// Register autofill: name/mobile suggest list, person pick, identity revalidation,
// token + date handling. Reads DOM from register.ctx; calls billing + orchestrator
// functions through the ctx hook registry to avoid circular imports.

import db from '../../core/db.js';
import { timeAgo } from '../../core/time.js';
import { getB, getFlags, call } from './register.ctx.js';
import {
  applyFollowupRule,
  refreshPreview,
  setFollowupNote,
} from './register.billing.js';

let nameTimer = null;
let activeList = null; // { ul, items, pick, hi }

function setHighlight(list, i) {
  list.hi = i;
  const lis = list.ul.children;
  for (let k = 0; k < lis.length; k++) lis[k].classList.toggle('hl', k === i);
  if (i >= 0 && lis[i]) lis[i].scrollIntoView({ block: 'nearest' });
}

function renderSuggest(ul, items, pick) {
  ul.replaceChildren();
  if (!items.length) {
    ul.hidden = true;
    if (activeList && activeList.ul === ul) activeList = null;
    return;
  }
  const list = { ul, items, pick, hi: -1 };
  items.forEach((p, i) => {
    const li = document.createElement('li');

    const main = document.createElement('span');
    main.className = 's-main';
    const name = document.createElement('span');
    name.className = 's-name';
    name.textContent = p.name;
    const ago = document.createElement('span');
    ago.className = 's-ago';
    ago.textContent = timeAgo(p.lastVisitAt || p.createdAt) || '';
    main.append(name, ago);

    const sub = document.createElement('span');
    sub.className = 's-sub';
    const mob = document.createElement('span');
    mob.className = 's-mob';
    mob.textContent = p.mob || '';
    const age = document.createElement('span');
    age.className = 's-age';
    age.textContent = p.age != null && p.age !== '' ? String(p.age) : '';
    sub.append(mob, age);

    li.append(main, sub);
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pick(p);
    });
    li.addEventListener('mouseenter', () => setHighlight(list, i));
    ul.appendChild(li);
  });
  ul.hidden = false;
  activeList = list;
}

export function hideSuggests() {
  const b = getB();
  if (b.nameSuggest) b.nameSuggest.hidden = true;
  activeList = null;
}

function pickPerson(p, focus = true) {
  const b = getB();
  b.fName.value = (p.name || '').toUpperCase();
  b.fMob.value = p.mob || '';
  if (p.age != null && p.age !== '') b.fAge.value = String(p.age);
  b.fGender.value = p.gender || '';
  if (b.fWeight) b.fWeight.value = p.weight != null && p.weight !== '' ? String(p.weight) : '';
  b.fPatientId.value = p.rootId != null ? String(p.rootId) : '';
  hideSuggests();
  if (focus) b.saveBtn && b.saveBtn.focus();
  applyFollowupRule(p.rootId);
  refreshPreview();
}

function onSuggestKey(e) {
  const list = activeList;
  if (!list || list.ul.hidden) return;
  const n = list.items.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setHighlight(list, list.hi < 0 ? 0 : Math.min(list.hi + 1, n - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setHighlight(list, list.hi < 0 ? n - 1 : Math.max(list.hi - 1, 0));
  } else if (e.key === 'Enter') {
    if (list.hi >= 0) {
      e.preventDefault();
      list.pick(list.items[list.hi]);
    }
  } else if (e.key === 'Tab') {
    const idx = list.hi >= 0 ? list.hi : 0;
    list.pick(list.items[idx], false);
  } else if (e.key === 'Escape') {
    hideSuggests();
  }
}

function onNameInput() {
  const b = getB();
  clearTimeout(nameTimer);
  const q = b.fName.value.trim();
  if (q.length < 2) {
    b.nameSuggest.hidden = true;
    return;
  }
  nameTimer = setTimeout(async () => {
    // Digit-first -> mobile search; else -> name search (same rule as Patients).
    // A phone number typed here finds the person; a name typed here finds by name.
    const items = await db.searchPeopleByPrefix(q, 8);
    renderSuggest(b.nameSuggest, items, pickPerson);
  }, 120);
}

function onDocMouseDown(e) {
  const b = getB();
  const t = e.target;
  if (b.nameSuggest.contains(t) || t === b.fName) return;
  hideSuggests();
}

// Re-evaluate the follow-up rule from the CURRENT form identity. Runs on
// name/mob blur. Resolution mirrors addVisit: explicit Pat ID wins, else match
// (name, mob). Unresolved -> new patient -> force paid.
let identityTimer = null;
function revalidateIdentity() {
  const b = getB();
  const flags = getFlags();
  clearTimeout(identityTimer);
  identityTimer = setTimeout(async () => {
    // A submit in flight owns the form; re-running the rule mid-submit would
    // mutate fee / follow-up while submitBill is awaiting a dialog choice.
    if (flags.submitting) return;
    const name = b.fName.value.trim().toUpperCase();
    const mob = b.fMob.value.trim();
    const patId = Number(b.fPatientId.value.trim());
    let personId = null;
    if (patId) {
      const p = await db.getPerson(patId).catch(() => null);
      if (p && p.name === name && p.mob === mob) personId = p.rootId;
    }
    if (!personId && name && mob) {
      const matches = await db.searchPeopleByName(name, 8).catch(() => []);
      const hit = matches.find((p) => p.name === name && p.mob === mob);
      if (hit) personId = hit.rootId;
    }
    applyFollowupRule(personId);
  }, 180);
}

export async function refreshNextToken() {
  const b = getB();
  const flags = getFlags();
  const day = b.fDate.value || db.localDay();
  const t = await db.nextTokenForDate(day);
  if (!b.fDate.value) b.fDate.value = day;
  b.fToken.value = String(t);
  flags.tokenEdited = false;
  flags.loadedVisitId = null;
}

// Token change: if a visit exists at (date, token), load it (edit mode).
// Otherwise keep the typed value; submit will create at that key.
async function onTokenChange() {
  const b = getB();
  const flags = getFlags();
  flags.tokenEdited = true;
  const day = b.fDate.value.trim();
  const token = Number(b.fToken.value);
  if (!day || !Number.isInteger(token) || token < 1) return;
  const found = await db.findVisitByDateToken(day, token);
  if (!found) {
    flags.loadedVisitId = null;
    call('setMsg', `Token ${token} is free on ${day}.`, 'ok');
    call('startNewBill', false, false); // keep the user's chosen day
    return;
  }
  const { visit, person } = found;
  setFollowupNote('');
  hideSuggests();
  call(
    'setMsg',
    `Editing token ${token} on ${day} — ${visit.name}${person ? ' (Patient #' + person.rootId + ')' : ''}.`,
    'ok'
  );
  call('loadVisitIntoForm', visit, person);
}

async function onTokenBlur() {
  const b = getB();
  if (b.fToken.value.trim() === '') {
    await refreshNextToken();
  }
}

// Wire the autofill handlers. Called from register.mount().
export function bindAutofill(off) {
  const b = getB();
  off.on(b.fName, 'input', onNameInput);
  off.on(b.fName, 'keydown', onSuggestKey);
  off.on(document, 'mousedown', onDocMouseDown);
  off.on(b.fToken, 'change', onTokenChange);
  off.on(b.fToken, 'blur', onTokenBlur);
  off.on(b.fName, 'blur', revalidateIdentity);
  off.on(b.fMob, 'blur', revalidateIdentity);
  off.on(b.fName, 'change', revalidateIdentity);
  off.on(b.fMob, 'change', revalidateIdentity);
  // Live revalidation while typing so the follow-up note appears without the
  // user having to leave the field. revalidateIdentity debounces internally and
  // yields to an in-flight submit.
  off.on(b.fName, 'input', revalidateIdentity);
  off.on(b.fMob, 'input', revalidateIdentity);
}
