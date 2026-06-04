/**
 * Entry point. Refresh loop, header, context strip, and per-feature dispatch.
 *
 * Data flow (Derive): one getFullChain() pulls every expiry's chain (≈11
 * get_tickers calls). From that single payload we derive everything — GEX,
 * OI walls, max pain, the forward curve, and the IV surface. No separate
 * futures fetch (Derive hands us per-option forwards).
 *
 * @module main
 */

import { getFullChain, getCallStats, CURRENCY } from "./derive.js";
import {
  prepareOptions,
  gexByStrike,
  gexCurve,
  totalGex,
  findZeroGammaFlip,
  oiStats,
  oiByStrike,
} from "./gex.js";
import { buildForwardCurve, forwardAt } from "./forwards.js";
import { fitSvi } from "./svi.js";
import { yearsToExpiry } from "./black_scholes.js";
import {
  renderGexByStrike,
  renderGexVsSpot,
  renderOiByStrike,
} from "./plots/gex_chart.js";
import {
  renderIvSurface,
  renderIvSlices,
} from "./plots/iv_surface.js";
import { atmTermStructure } from "./term_structure.js";
import { skewTermStructure } from "./skew.js";
import {
  renderAtmTermStructure,
  renderSkewTermStructure,
} from "./plots/term_structure_chart.js";
import { maxPainPerExpiry } from "./max_pain.js";
import { renderMaxPain } from "./plots/max_pain_chart.js";

const REFRESH_MS = 30_000;

const lastUpdated = document.getElementById("last-updated");
const apiBudget = document.getElementById("api-budget");
const pauseBtn = document.getElementById("pause");
const contextStrip = document.getElementById("context-strip");

let paused = false;

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "resume refresh" : "pause refresh";
  pauseBtn.classList.toggle("bg-rose-700", paused);
  pauseBtn.classList.toggle("bg-zinc-800", !paused);
});

function renderApiBudget() {
  const s = getCallStats();
  apiBudget.textContent = `snapshot loads: ${s.totalCalls}${s.errors ? ` (${s.errors} err)` : ""}`;
}
setInterval(renderApiBudget, 1000);
renderApiBudget();

// Max-pain UI state — kept across ticks so the active tab survives a refresh.
let mpActiveExpiryMs = null;
let mpLastExpirySet = "";
let mpLastSpot = NaN;
/** @type {Array<import("./max_pain.js").ExpiryPain>} */
let mpLastSlices = [];

function renderMaxPainPanel(painSlices, spot) {
  mpLastSlices = painSlices;
  mpLastSpot = spot;

  const tabsEl = document.getElementById("max-pain-tabs");
  const chartEl = document.getElementById("max-pain-chart");
  if (!tabsEl || !chartEl) return;

  if (painSlices.length === 0) {
    tabsEl.innerHTML = "";
    chartEl.innerHTML = `<div class="text-zinc-500 text-sm font-mono p-4">no expiries with options</div>`;
    return;
  }

  // Default active expiry: the nearest one (first in sorted order)
  if (mpActiveExpiryMs == null || !painSlices.find((p) => p.expirationMs === mpActiveExpiryMs)) {
    mpActiveExpiryMs = painSlices[0].expirationMs;
  }

  // Only rebuild tab DOM if the expiry set changed (avoid flicker)
  const expirySetKey = painSlices.map((p) => p.expirationMs).join(",");
  if (expirySetKey !== mpLastExpirySet) {
    tabsEl.innerHTML = "";
    for (const p of painSlices) {
      const btn = document.createElement("button");
      btn.dataset.exp = String(p.expirationMs);
      btn.className = "px-2.5 py-1 rounded font-mono text-xs border border-zinc-800";
      btn.textContent = `${p.dte.toFixed(1)}d`;
      btn.title = new Date(p.expirationMs).toISOString();
      btn.addEventListener("click", () => {
        mpActiveExpiryMs = p.expirationMs;
        applyMaxPainTabs();
        const active = mpLastSlices.find((s) => s.expirationMs === mpActiveExpiryMs);
        if (active) renderMaxPain("max-pain-chart", active, mpLastSpot);
      });
      tabsEl.appendChild(btn);
    }
    mpLastExpirySet = expirySetKey;
  }
  applyMaxPainTabs();

  const active = painSlices.find((p) => p.expirationMs === mpActiveExpiryMs);
  if (active) renderMaxPain("max-pain-chart", active, spot);
}

function applyMaxPainTabs() {
  const tabsEl = document.getElementById("max-pain-tabs");
  if (!tabsEl) return;
  for (const btn of tabsEl.querySelectorAll("button")) {
    const isActive = Number(btn.dataset.exp) === mpActiveExpiryMs;
    btn.classList.toggle("bg-violet-600", isActive);
    btn.classList.toggle("text-white", isActive);
    btn.classList.toggle("bg-zinc-900", !isActive);
    btn.classList.toggle("text-zinc-400", !isActive);
    btn.classList.toggle("hover:bg-zinc-800", !isActive);
  }
}

/**
 * Dealer gamma regime from the sign of total GEX at spot. Positive ⇒ dealers
 * net-long gamma: they sell rallies / buy dips to stay hedged, damping realized
 * vol (mean-reverting tape). Negative ⇒ short gamma: they chase the move,
 * amplifying vol (trending / squeeze-prone tape). The zero-gamma flip is the
 * spot at which this sign flips.
 */
function dealerRegime(totalGexAtSpot) {
  if (!Number.isFinite(totalGexAtSpot)) return { label: "—", cls: "text-zinc-500", note: "" };
  if (totalGexAtSpot >= 0) {
    return {
      label: "LONG γ",
      cls: "text-teal-400",
      note: "vol-dampening · dips bought, rips sold",
    };
  }
  return {
    label: "SHORT γ",
    cls: "text-rose-400",
    note: "vol-amplifying · moves chased",
  };
}

function renderContextStrip(spot, oi, flip, regime) {
  const pct = (n) => Number.isFinite(n) ? n.toFixed(2) : "—";
  const fmtUsd = (n) => Number.isFinite(n) ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";
  const fmt = (n) => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—";

  contextStrip.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-6 gap-4 font-mono text-sm">
      <div>
        <div class="text-zinc-500 text-xs uppercase tracking-wider">${CURRENCY} spot</div>
        <div class="text-2xl font-bold text-zinc-100">${fmtUsd(spot)}</div>
      </div>
      <div>
        <div class="text-zinc-500 text-xs uppercase tracking-wider">Total OI (contracts)</div>
        <div class="text-2xl font-bold text-zinc-100">${fmt(oi.totalOi)}</div>
        <div class="text-xs text-zinc-500">
          <span class="text-teal-400">calls ${fmt(oi.callOi)}</span> /
          <span class="text-rose-400">puts ${fmt(oi.putOi)}</span>
        </div>
      </div>
      <div>
        <div class="text-zinc-500 text-xs uppercase tracking-wider">P/C ratio (OI)</div>
        <div class="text-2xl font-bold text-zinc-100">${pct(oi.putCallRatioOi)}</div>
      </div>
      <div>
        <div class="text-zinc-500 text-xs uppercase tracking-wider">Priced strikes</div>
        <div class="text-2xl font-bold text-zinc-100">${fmt(oi.totalCount)}</div>
      </div>
      <div>
        <div class="text-zinc-500 text-xs uppercase tracking-wider">Dealer gamma</div>
        <div class="text-2xl font-bold ${regime.cls}">${regime.label}</div>
        <div class="text-xs text-zinc-500">${regime.note}</div>
      </div>
      <div>
        <div class="text-zinc-500 text-xs uppercase tracking-wider">Zero-gamma flip</div>
        <div class="text-2xl font-bold ${flip != null ? "text-amber-400" : "text-zinc-500"}">${flip != null ? fmtUsd(flip) : "—"}</div>
        <div class="text-xs text-zinc-500">${flip != null && Number.isFinite(spot) ? `Δ vs spot: ${((flip - spot) / spot * 100).toFixed(2)}%` : ""}</div>
      </div>
    </div>
  `;
}

/**
 * Group options by expiry, fit SVI per expiry, and return slices ready for
 * the IV surface and slice-grid renderers. Drops slices with < 5 points
 * (not enough for a stable 5-param fit).
 *
 * @param {Array<import("./gex.js").OptionRow>} opts
 * @param {Array<import("./forwards.js").FuturePoint>} fwdCurve
 * @param {number} spot
 * @param {number} nowMs
 * @returns {Array<import("./plots/iv_surface.js").ExpirySlice>}
 */
function buildSlices(opts, fwdCurve, spot, nowMs) {
  /** @type {Map<number, import("./plots/iv_surface.js").ExpirySlice>} */
  const byExpiry = new Map();
  for (const o of opts) {
    const T = yearsToExpiry(o.expiration_ms, nowMs);
    if (T <= 0) continue;
    const F = forwardAt(fwdCurve, o.expiration_ms, spot);
    if (!Number.isFinite(F) || F <= 0) continue;
    const k = Math.log(o.strike / F);
    const slice = byExpiry.get(o.expiration_ms) ?? {
      expirationMs: o.expiration_ms,
      T,
      forward: F,
      points: [],
      svi: null,
      fit: null,
    };
    slice.points.push({ k, iv: o.markIv, type: o.option_type, strike: o.strike });
    byExpiry.set(o.expiration_ms, slice);
  }

  const slices = [...byExpiry.values()].sort((a, b) => a.expirationMs - b.expirationMs);
  for (const s of slices) {
    if (s.points.length < 5) continue;
    // SVI fits total variance w(k) = IV² · T
    const ptsW = s.points.map((p) => ({ k: p.k, w: p.iv * p.iv * s.T }));
    const fit = fitSvi(ptsW);
    s.svi = fit.params;
    s.fit = { rmse: fit.rmse, maxResid: fit.maxResid };
  }
  return slices;
}

/**
 * One refresh tick. Single fetch, then progressive render: GEX/OI/max-pain
 * paint first (above the fold), the IV surface is deferred to the next frame.
 */
async function tick() {
  if (paused) return;
  const t0 = performance.now();

  let payload;
  try {
    payload = await getFullChain();
  } catch (err) {
    console.error("chain fetch failed:", err);
    contextStrip.innerHTML = `<div class="text-rose-400 text-sm font-mono">Derive fetch error: ${err.message}</div>`;
    lastUpdated.textContent = `tick failed: ${err.message}`;
    lastUpdated.classList.remove("text-zinc-400");
    lastUpdated.classList.add("text-rose-500");
    return;
  }

  const nowMs = Date.now();
  const spot = payload.indexPrice;
  const opts = prepareOptions(payload.rows, nowMs);

  // ── GEX / OI / max-pain (above the fold) ──
  try {
    const oi = oiStats(opts);
    const byStrike = gexByStrike(opts, spot, nowMs);
    const curve = gexCurve(opts, spot, undefined, undefined, nowMs);
    const flip = findZeroGammaFlip(curve);
    const regime = dealerRegime(totalGex(opts, spot, nowMs));

    const painSlices = maxPainPerExpiry(opts, nowMs);
    const nearestMaxPain = painSlices.length > 0 ? painSlices[0].maxPainStrike : null;

    renderContextStrip(spot, oi, flip, regime);
    renderGexByStrike("gex-by-strike", byStrike, { spot, flip, maxPain: nearestMaxPain });
    renderGexVsSpot("gex-vs-spot", curve, { spot, flip });
    renderOiByStrike("oi-by-strike", oiByStrike(opts), { spot, maxPain: nearestMaxPain });
    renderMaxPainPanel(painSlices, spot);
  } catch (err) {
    console.error("GEX render failed:", err);
    contextStrip.innerHTML = `<div class="text-rose-400 text-sm font-mono">GEX error: ${err.message}</div>`;
  }

  // ── IV surface + term structure + skew ──
  try {
    const fwdCurve = buildForwardCurve(payload.rows);
    const slices = buildSlices(opts, fwdCurve, spot, nowMs);

    renderIvSlices("iv-slices", slices, nowMs);
    renderAtmTermStructure("term-structure", atmTermStructure(slices, nowMs));
    renderSkewTermStructure("skew", skewTermStructure(slices, spot, nowMs));

    requestAnimationFrame(() => {
      renderIvSurface("iv-surface", slices, nowMs);
    });
  } catch (err) {
    console.error("IV render failed:", err);
    const slicesEl = document.getElementById("iv-slices");
    if (slicesEl) {
      slicesEl.innerHTML = `<div class="text-amber-400 text-sm font-mono">IV surface error: ${err.message}</div>`;
    }
  }

  // Snapshot age — the data is as fresh as the last GitHub Action run, not
  // this render. Surface it honestly, and warn when stale.
  const ageMin = Number.isFinite(payload.fetchedAt)
    ? Math.round((Date.now() - payload.fetchedAt) / 60000)
    : null;
  const ageStr = ageMin == null ? "" : ageMin < 1 ? "just now" : `${ageMin}m ago`;
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  lastUpdated.textContent = payload.stale
    ? `data ${ageStr} — STALE (refresh Action may be paused)`
    : `data ${ageStr} · rendered ${stamp} UTC · ${payload.expiries} expiries`;
  lastUpdated.classList.toggle("text-rose-500", !!payload.stale);
  lastUpdated.classList.toggle("text-amber-400", false);
  lastUpdated.classList.toggle("text-zinc-400", !payload.stale);
}

/**
 * Plotly is loaded with `defer`. Module scripts also defer, and deferred
 * scripts execute in document order, so Plotly *should* be defined by the
 * time this module runs. But on slow connections the script tag could still
 * be in flight when the first tick fires. Cheap poll until it's there.
 */
async function waitForPlotly(timeoutMs = 10_000) {
  const start = performance.now();
  while (typeof window.Plotly === "undefined") {
    if (performance.now() - start > timeoutMs) {
      throw new Error("Plotly failed to load within 10s");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

(async () => {
  await waitForPlotly();
  await tick();
  setInterval(tick, REFRESH_MS);
})();

export function isPaused() {
  return paused;
}
