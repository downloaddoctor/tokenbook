// Reusable refund dialog: pick a refund tier for a visit.
// Self-contained — resolves <dialog id="refund-dialog"> lazily so it can be
// opened from any page. openRefundDialog(visit) -> Promise<string|null>
// ('0'..'3' on Save, null on cancel/dismiss).

import db from '../core/db.js';
import { refundAmountFor, REFUND_TIER_STEP } from '../core/billing.js';
import { el, showModal } from './dom.js';
import { openRevisions } from './revisions.js';

// Render the tier <option>s from billing's canonical step so the label can
// never drift from the amount the DB actually applies. Idempotent — safe to
// call on every dialog open.
function ensureTierOptions(sel) {
  const want = ['0', '1', '2', '3'];
  const have = Array.from(sel.options).map((o) => o.value);
  if (have.length === want.length && want.every((v, i) => have[i] === v)) {
    // already rendered — still refresh the labels (step may have changed)
  } else {
    sel.replaceChildren();
    for (const v of want) sel.appendChild(new Option('', v));
  }
  for (const o of sel.options) {
    const tier = Number(o.value);
    if (tier === 0) {
      o.textContent = 'None';
      continue;
    }
    const amt = refundAmountFor(tier);
    o.textContent = tier === 3 ? `R — ₹${amt} (full)` : `R${tier} — ₹${amt}`;
  }
}

// Show the refund dialog. Does NOT write — callers apply the tier via
// db.setVisitRefund (or use openRefundFor which does both).
export function openRefundDialog(visit) {
  return new Promise((resolve) => {
    const dlg = el('refund-dialog');
    const sub = el('refund-sub');
    const sel = el('refund-tier');
    if (!dlg || !sub || !sel) return resolve(null);

    ensureTierOptions(sel);
    const baseFee = visit.fee != null ? Number(visit.fee) : 0;
    sub.textContent = `Token ${visit.token} · ${visit.name} · Fee ₹${baseFee}`;
    sel.value = String(visit.refundTier || '0');
    // Remove is offered for today's tokens only. Free follow-ups can be
    // removed but not refunded (tier select disabled, Save hidden).
    const rmBtn = dlg.querySelector('#refund-remove');
    if (rmBtn) rmBtn.hidden = visit.date !== db.localDay() || visit.followup;
    const svBtn = dlg.querySelector('#refund-save');
    sel.disabled = !!visit.followup;
    if (svBtn) svBtn.hidden = !!visit.followup;

    const prev = el('refund-preview');
    const paintPreview = () => {
      if (!prev) return;
      const amt = db.refundAmountFor(sel.value);
      if (amt <= 0) {
        prev.textContent = `Refund ₹0 — fee stays ₹${baseFee}`;
        return;
      }
      const net = Math.max(0, baseFee - amt);
      prev.textContent = `Fee ₹${baseFee} → ₹${net} (refund ₹${amt})`;
    };
    paintPreview();

    const saveBtn = dlg.querySelector('#refund-save');
    const histBtn = dlg.querySelector('#refund-history');
    // Repaint the preview; keep focus on the select (Tab reaches Save).
    const onSelChange = () => {
      paintPreview();
    };
    // "History" opens the revision timeline for this visit's root.
    const onHistory = () => {
      if (visit.rootId != null) openRevisions('visit', visit.rootId);
    };
    // Esc must close the dialog even while the <select> has focus (a focused
    // native select eats the first Escape to close its dropdown). Handle it
    // explicitly at the dialog level.
    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dlg.returnValue = '';
        dlg.close();
      }
    };
    // Teardown of this dialog's extra listeners on close; the result comes from
    // showModal()'s resolved returnValue.
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('keydown', onKeydown);
      sel.removeEventListener('change', onSelChange);
      if (histBtn) histBtn.removeEventListener('click', onHistory);
    };
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('keydown', onKeydown);
    sel.addEventListener('change', onSelChange);
    if (histBtn) histBtn.addEventListener('click', onHistory);
    showModal(dlg).then((v) => resolve(v === 'save' ? sel.value : v === 'remove' ? 'remove' : null));
    // Enter on the tier select; Tab then flows through the footer as laid out.
    sel.focus();
  });
}

// Settle an unpaid visit: pick Cash / UPI and Save. Resolves '0' | '1' | null.
export function openSettleDialog(visit) {
  return new Promise((resolve) => {
    const dlg = el('settle-dialog');
    const sub = el('settle-sub');
    const sel = el('settle-pay');
    if (!dlg || !sub || !sel) return resolve(null);
    sub.textContent = `Token ${visit.token} · ${visit.name} · Fee ₹${visit.fee != null ? visit.fee : 0}`;
    sel.value = '0';
    showModal(dlg).then((v) => resolve(v === 'save' ? sel.value : null));
    sel.focus();
  });
}

// Confirm-and-remove for today's token (soft delete). Returns 'removed' or null.
export async function removeVisitFlow(visit) {
  if (!visit || visit.hidden || visit.date !== db.localDay()) return null;
  const dlg = el('remove-dialog');
  const sub = el('remove-sub');
  if (!dlg || !sub) return null;
  sub.textContent = `Token ${visit.token} · ${visit.name} · ${visit.mob}`;
  const v = await showModal(dlg);
  if (v !== 'remove') return null;
  await db.hideVisit(visit.rootId);
  return 'removed';
}

export function refundLabel(tier) {
  const amt = db.refundAmountFor(tier);
  return amt > 0 ? `₹${amt}` : '';
}

// Show the dialog AND persist the choice. Returns the new tier (string) or null
// if cancelled/unchanged. Callers only need to refresh their own view.
// Route the visit to exactly one dialog by state:
//  - non-today / removed -> nothing (caller shows view-only)
//  - unpaid today        -> settle dialog (Cash/UPI)
//  - free follow-up today-> remove only
//  - paid today          -> refund dialog (tier + optional Remove)
export async function openRefundFor(visit) {
  if (!visit) return null;
  const isToday = visit.date === db.localDay();
  if (visit.hidden || !isToday) return null;

  // Unpaid: settle first, no refund until paid.
  if (visit.payment === 2) {
    const choice = await openSettleDialog(visit);
    if (choice == null) return null;
    await db.setVisitBilling(visit.rootId, { payment: Number(choice) === 1 ? 1 : 0 });
    return 'settled';
  }

  // Free follow-up: nothing to refund, only remove is offered.
  if (visit.followup) {
    return removeVisitFlow(visit);
  }

  // Paid: refund tier dialog (with an optional Remove button).
  const choice = await openRefundDialog(visit);
  if (choice == null) return null;
  if (choice === 'remove') return removeVisitFlow(visit);
  await db.setVisitRefund(visit.rootId, choice);
  return choice;
}
