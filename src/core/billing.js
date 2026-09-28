// Single source of truth for the follow-up window and default fee.
// Consumed by BOTH the register form (applyFollowupRule) and the DB write path
// (_resolveBilling) so the form and the committed row can never diverge.

// Built-in defaults. The live values come from app settings (meta key
// 'settings'), loaded at boot via setConfig(). These constants are ONLY the
// fallback when no setting is stored.
export const FOLLOWUP_WINDOW_DAYS = 6;
export const DEFAULT_FEE = 300;

// ---- live config (settings-backed) ----
// billing stays synchronous: app.js loads settings from the DB and pushes them
// here once at boot (and again after each Settings save).
let _defaultFee = DEFAULT_FEE;
let _followupWindowDays = FOLLOWUP_WINDOW_DAYS;

export function setConfig({ defaultFee, followupWindowDays } = {}) {
  if (defaultFee != null) {
    const n = Number(defaultFee);
    if (Number.isFinite(n) && n >= 0) _defaultFee = n;
  }
  if (followupWindowDays != null) {
    const n = Number(followupWindowDays);
    if (Number.isFinite(n) && n >= 0) _followupWindowDays = n;
  }
}
export function defaultFee() {
  return _defaultFee;
}
export function followupWindowDays() {
  return _followupWindowDays;
}
export function getConfig() {
  return { defaultFee: _defaultFee, followupWindowDays: _followupWindowDays };
}

// Refund tier N -> amount N * REFUND_TIER_STEP. 0 = no refund.
// Single source for the form, DB write path, log codec, and Tokens page.
export const REFUND_TIER_STEP = 100;
export function refundAmountFor(tier) {
  return normalizeRefundTier(tier) * REFUND_TIER_STEP;
}
export function normalizeRefundTier(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '' || s === '0') return 0;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A paid visit within [0, FOLLOWUP_WINDOW_DAYS] days of the target date is a
// free follow-up. Returns false for null/negative/NaN day gaps.
export function isWithinFollowupWindow(days) {
  return days != null && Number.isFinite(days) && days >= 0 && days <= _followupWindowDays;
}

// Days remaining before the window closes (for UI notes). Clamped at 0.
export function followupDaysLeft(days) {
  if (!isWithinFollowupWindow(days)) return 0;
  return _followupWindowDays - days;
}

// Decide followup + fee for a visit, given the day-gap to the last PAID visit.
//   lastPaidDays: number | null  (null = no prior paid visit)
//   explicit:     0 | 1 | null   (user toggle; null = let the rule decide)
//   baseFee:      number         (fee to charge when the visit is paid)
// Mirrors db._resolveBilling exactly.
export function evaluateFollowup({ lastPaidDays = null, explicit = null, baseFee } = {}) {
  if (baseFee == null) baseFee = _defaultFee;
  const auto = lastPaidDays != null && isWithinFollowupWindow(lastPaidDays);
  const followup = explicit === 0 || explicit === 1 ? explicit : auto ? 1 : 0;
  const fee = followup === 1 ? 0 : baseFee;
  return { followup, fee, auto };
}

// Normalize a user-supplied fee to a positive number, else the default.
export function normalizeFee(fee) {
  const n = Number(fee);
  return Number.isFinite(n) && n > 0 ? n : _defaultFee;
}
