// Reusable refund dialog: pick a refund tier for a visit.
// Self-contained — resolves <dialog id="refund-dialog"> lazily so it can be
// opened from any page. openRefundDialog(visit) -> Promise<string|null>
// ('0'..'3' on Save, null on cancel/dismiss).

import db from '../core/db.js';
import { openRevisions } from './revisions.js';

function el(id) {
  return document.getElementById(id);
}

// Show the refund dialog. Does NOT write — callers apply the tier via
// db.setVisitRefund (or use openRefundFor which does both).
export function openRefundDialog(visit) {
  return new Promise((resolve) => {
    const dlg = el('refund-dialog');
    const sub = el('refund-sub');
    const sel = el('refund-tier');
    if (!dlg || !sub || !sel) return resolve(null);

    const baseFee = visit.fee != null ? Number(visit.fee) : 0;
    sub.textContent = `Token ${visit.token} · ${visit.name} · Fee ₹${baseFee}`;
    sel.value = String(visit.refundTier || '0');

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
    // After picking a tier, jump focus to Save (Tab/Shift+Tab then reaches Cancel).
    const onSelChange = () => {
      paintPreview();
      if (saveBtn) saveBtn.focus();
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
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('keydown', onKeydown);
      sel.removeEventListener('change', onSelChange);
      if (histBtn) histBtn.removeEventListener('click', onHistory);
      resolve(dlg.returnValue === 'save' ? sel.value : null);
    };

    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('keydown', onKeydown);
    sel.addEventListener('change', onSelChange);
    if (histBtn) histBtn.addEventListener('click', onHistory);
    dlg.showModal();
    // Focus Save, NOT the select: a focused native <select> swallows the first
    // Escape (it closes the dropdown), so Esc would not close the dialog.
    (saveBtn || dlg).focus();
  });
}

export function refundLabel(tier) {
  const amt = db.refundAmountFor(tier);
  return amt > 0 ? `₹${amt}` : '';
}

// Show the dialog AND persist the choice. Returns the new tier (string) or null
// if cancelled/unchanged. Callers only need to refresh their own view.
export async function openRefundFor(visit) {
  if (!visit) return null;
  if (visit.followup) return null; // free follow-ups have nothing to refund
  const choice = await openRefundDialog(visit);
  if (choice == null) return null;
  // v3: the visit's stable key is rootId (rows come from visitsProj).
  await db.setVisitRefund(visit.rootId, choice);
  return choice;
}
