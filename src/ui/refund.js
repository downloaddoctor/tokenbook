// Reusable refund dialog: pick a refund tier for a visit.
// Self-contained — resolves the <dialog id="refund-dialog"> from index.html
// lazily so it can be opened from any page (Tokens click/Enter, Register Alt+R).
//
// openRefundDialog(visit) -> Promise<string|null>
//   resolves the chosen tier as a string ('0'..'3') on Save, or null if the
//   dialog was cancelled / dismissed.

import db from '../core/db.js';

function el(id) {
  return document.getElementById(id);
}

// Show the refund dialog for `visit`. Does not write to the DB — callers
// apply the returned tier via db.setVisitRefund.
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
    // Once a tier is picked, jump focus to Save. Tab from Save goes to Cancel
    // (DOM order: Cancel then Save; Shift+Tab from Save also reaches Cancel).
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

// Convenience: show the dialog AND persist the choice. Returns the new tier
// (string) or null if cancelled / unchanged. Callers only need to refresh
// their own view — the DB write happens here.
export async function openRefundFor(visit) {
  if (!visit) return null;
  if (visit.followup) return null; // free follow-ups have nothing to refund
  const choice = await openRefundDialog(visit);
  if (choice == null) return null;
  await db.setVisitRefund(visit.id, choice);
  return choice;
}
