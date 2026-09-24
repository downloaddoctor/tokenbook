// Reusable refund dialog: pick a refund tier for a visit.
// Self-contained — resolves <dialog id="refund-dialog"> lazily so it can be
// opened from any page. openRefundDialog(visit) -> Promise<string|null>
// ('0'..'3' on Save, null on cancel/dismiss).

import db from '../core/db.js';

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

    sub.textContent = `Token ${visit.token} · ${visit.name} · Fee ₹${
      visit.fee != null ? visit.fee : 0
    }`;
    sel.value = String(visit.refundTier || '0');

    const saveBtn = dlg.querySelector('#refund-save');
    // After picking a tier, jump focus to Save (Tab/Shift+Tab then reaches Cancel).
    const onSelChange = () => {
      if (saveBtn) saveBtn.focus();
    };
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      sel.removeEventListener('change', onSelChange);
      resolve(dlg.returnValue === 'save' ? sel.value : null);
    };

    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    sel.addEventListener('change', onSelChange);
    dlg.showModal();
    sel.focus();
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
  await db.setVisitRefund(visit.id, choice);
  return choice;
}
