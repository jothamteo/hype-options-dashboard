/**
 * Per-expiry forward price extraction.
 *
 * For each option expiry timestamp, we want the forward F used in
 * k = ln(K / F). Derive's option pricer returns a per-option `forward_price`
 * directly in get_tickers, so unlike the Deribit build we do NOT need a
 * separate futures fetch — we extract one forward per expiry from the option
 * chain itself. Within an expiry every option carries the same forward (it's a
 * function of expiry, not strike), so we take the median across that expiry's
 * options to shrug off the occasional stale/zero outlier.
 *
 * Why this matters: using spot S in place of F shifts every smile
 * horizontally by ln(F/S) — the basis. The shift is smooth in T, so within
 * a single expiry the smile shape is unchanged. But across expiries, mixing
 * spot-based and forward-based moneyness contaminates term-structure
 * comparisons (slope, ATM IV, skew).
 *
 * @module forwards
 */

/**
 * @typedef {object} FuturePoint
 * @property {number} expirationMs
 * @property {number} forward
 */

/**
 * Build a sorted forward curve from the decoded Derive option chain. Groups by
 * expiry and takes the median per-option forward as that expiry's forward.
 *
 * @param {Array<import("./derive.js").DeriveOptionRow>} rows  from getFullChain()
 * @returns {Array<FuturePoint>}
 */
export function buildForwardCurve(rows) {
  /** @type {Map<number, number[]>} */
  const byExpiry = new Map();
  for (const r of rows) {
    const f = r.forward;
    if (!Number.isFinite(f) || f <= 0) continue;
    const arr = byExpiry.get(r.expiration_ms) ?? [];
    arr.push(f);
    byExpiry.set(r.expiration_ms, arr);
  }
  /** @type {FuturePoint[]} */
  const points = [];
  for (const [expirationMs, fwds] of byExpiry) {
    fwds.sort((a, b) => a - b);
    const mid = fwds[Math.floor(fwds.length / 2)];
    points.push({ expirationMs, forward: mid });
  }
  points.sort((a, b) => a.expirationMs - b.expirationMs);
  return points;
}

/**
 * Forward at an arbitrary expiry timestamp. Exact match returns that
 * future's mark; otherwise linearly interpolates between the bracketing
 * points. Outside the curve range, extrapolates from the nearest endpoint
 * (flat — preferable to hallucinating a slope from two distant points).
 *
 * @param {Array<FuturePoint>} curve
 * @param {number} expiryMs
 * @param {number} [spotFallback]  if provided, returned when curve is empty
 * @returns {number}  NaN if no curve and no fallback
 */
export function forwardAt(curve, expiryMs, spotFallback) {
  if (curve.length === 0) return Number.isFinite(spotFallback) ? spotFallback : NaN;
  if (curve.length === 1) return curve[0].forward;

  if (expiryMs <= curve[0].expirationMs) return curve[0].forward;
  if (expiryMs >= curve[curve.length - 1].expirationMs) return curve[curve.length - 1].forward;

  // Binary search the bracketing pair
  let lo = 0, hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].expirationMs <= expiryMs) lo = mid;
    else hi = mid;
  }
  const a = curve[lo], b = curve[hi];
  if (a.expirationMs === expiryMs) return a.forward;
  const t = (expiryMs - a.expirationMs) / (b.expirationMs - a.expirationMs);
  return a.forward + t * (b.forward - a.forward);
}
