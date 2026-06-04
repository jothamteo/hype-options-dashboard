/**
 * Derive (formerly Lyra) public REST API client + static-snapshot loader.
 *
 * All endpoints used here are public market-data (no auth, no API key). BUT:
 * the Derive API (api.lyra.finance) does NOT send an Access-Control-Allow-Origin
 * header, so a browser on a public origin (e.g. GitHub Pages) cannot call it
 * directly — the fetch is blocked by CORS. (curl/server-side has no such
 * restriction, which is why the live functions below work in Node and in CI.)
 *
 * So the deployed dashboard does NOT hit the API live. Instead a GitHub Action
 * (scripts/fetch_chain.py) fetches the chain server-side every few minutes and
 * commits a static snapshot to data/chain.json; getFullChain() reads that
 * same-origin file (no CORS) and decodes it with the same logic the live path
 * uses. The live functions (getFullChainLive, getChainForExpiry, …) remain for
 * the CI fetcher and the smoke test.
 *
 * Docs: https://docs.derive.xyz/reference/
 *
 * Data model notes that drove this client's design:
 *
 *  - `public/get_instruments` lists every live option as a flat array. Strike,
 *    type and expiry live under `option_details`, and are also encoded in the
 *    instrument name `HYPE-YYYYMMDD-<strike>-<C|P>`.
 *
 *  - `public/get_tickers` is the workhorse. It is filtered by `expiry_date`
 *    (YYYYMMDD integer) and returns the WHOLE chain for that expiry in one
 *    call, using an abbreviated wire format (single-letter keys) to keep the
 *    payload small. Crucially it carries, per instrument:
 *       option_pricing.{d,t,g,v,i,r,f,m}  → delta,theta,gamma,vega,iv,rho,fwd,mark
 *       stats.oi                            → open interest (contracts)
 *       I                                   → underlying index price
 *    IV is already a DECIMAL (1.14 = 114%), unlike Deribit which returns %.
 *    Forward price is per-option — so we never need a separate futures fetch.
 *
 * One get_tickers call per expiry (≈11 for HYPE) covers the entire surface.
 * We track the cumulative call budget so the operator (or a recruiter reading
 * the source) can see we're polite to the public endpoint.
 *
 * @module derive
 */

const BASE_URL = "https://api.lyra.finance";

const INSTRUMENTS_CACHE_KEY = "derive:instruments:HYPE:option";
// Instrument listings only change when a new expiry lists — refetching the
// full instrument set every 30s alongside the chain is wasteful.
const INSTRUMENTS_TTL_MS = 5 * 60 * 1000;

const _stats = { totalCalls: 0, lastCallTs: 0, errors: 0 };

/** The underlying this dashboard tracks. Swap to "ETH"/"BTC" to retarget. */
export const CURRENCY = "HYPE";

/**
 * Internal POST helper. Derive's public API is JSON-over-POST with a
 * `{ result, error }` envelope (JSON-RPC flavoured). Throws on network error,
 * non-2xx, or an `error` field.
 *
 * @param {string} path  Path including leading slash, e.g. "/public/get_tickers"
 * @param {Record<string, unknown>} [body]
 * @returns {Promise<any>} The `result` field of the envelope
 */
async function _post(path, body = {}) {
  _stats.totalCalls += 1;
  _stats.lastCallTs = Date.now();

  let resp;
  try {
    resp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    _stats.errors += 1;
    throw new Error(`Derive network error: ${err.message}`);
  }

  if (!resp.ok) {
    _stats.errors += 1;
    throw new Error(`Derive HTTP ${resp.status} on ${path}`);
  }

  const env = await resp.json();
  if (env.error) {
    _stats.errors += 1;
    const e = env.error;
    throw new Error(`Derive API error ${e.code}: ${e.message}${e.data ? ` (${e.data})` : ""}`);
  }
  return env.result;
}

/**
 * Parse a Derive option instrument name into its components.
 * Format: `HYPE-20260612-25-C` → { underlying, expiryDate: 20260612, strike: 25, type: "call" }
 * Returns null if the name doesn't match the option pattern.
 *
 * @param {string} name
 * @returns {{underlying: string, expiryDate: number, strike: number, type: "call"|"put"} | null}
 */
export function parseInstrumentName(name) {
  const m = /^([A-Z0-9]+)-(\d{8})-([\d.]+)-([CP])$/.exec(name);
  if (!m) return null;
  return {
    underlying: m[1],
    expiryDate: Number(m[2]),
    strike: Number(m[3]),
    type: m[4] === "C" ? "call" : "put",
  };
}

/**
 * Convert a YYYYMMDD integer to the UTC expiry timestamp in ms. Derive options
 * settle at 08:00 UTC; the exact intraday minute matters little for DTE but we
 * use 08:00 to match Derive's listed expiry time.
 *
 * @param {number} yyyymmdd
 * @returns {number} epoch ms
 */
export function expiryDateToMs(yyyymmdd) {
  const y = Math.floor(yyyymmdd / 10000);
  const mo = Math.floor((yyyymmdd % 10000) / 100);
  const d = yyyymmdd % 100;
  return Date.UTC(y, mo - 1, d, 8, 0, 0);
}

/**
 * Live option instruments for the tracked currency. Cached in sessionStorage
 * for 5 min. We use this only to enumerate the distinct expiries to poll —
 * all the per-strike data comes from get_tickers.
 *
 * @returns {Promise<Array<object>>}
 */
export async function getInstruments() {
  const cached = sessionStorage.getItem(INSTRUMENTS_CACHE_KEY);
  if (cached) {
    try {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < INSTRUMENTS_TTL_MS) return data;
    } catch {
      /* fall through to refetch */
    }
  }
  const result = await _post("/public/get_instruments", {
    currency: CURRENCY,
    instrument_type: "option",
    expired: false,
  });
  const data = Array.isArray(result) ? result : result?.instruments ?? [];
  sessionStorage.setItem(
    INSTRUMENTS_CACHE_KEY,
    JSON.stringify({ ts: Date.now(), data })
  );
  return data;
}

/**
 * Distinct, sorted list of live expiries for the tracked currency.
 *
 * @returns {Promise<Array<{expiryDate: number, expirationMs: number}>>}
 */
export async function getExpiries() {
  const insts = await getInstruments();
  const set = new Set();
  for (const inst of insts) {
    const parsed = parseInstrumentName(inst.instrument_name);
    if (parsed) set.add(parsed.expiryDate);
  }
  return [...set]
    .sort((a, b) => a - b)
    .map((expiryDate) => ({ expiryDate, expirationMs: expiryDateToMs(expiryDate) }));
}

/**
 * Fetch the full option chain for a single expiry via the bulk get_tickers
 * endpoint and decode the abbreviated wire format into rich rows.
 *
 * @param {number} expiryDate  YYYYMMDD integer
 * @returns {Promise<{rows: Array<DeriveOptionRow>, indexPrice: number, ts: number}>}
 */
export async function getChainForExpiry(expiryDate) {
  const result = await _post("/public/get_tickers", {
    currency: CURRENCY,
    instrument_type: "option",
    expiry_date: expiryDate,
  });
  return decodeTickers(result?.tickers ?? {}, expiryDate);
}

/**
 * Decode a single expiry's abbreviated `tickers` map (as returned by
 * get_tickers, or as stored in the data snapshot) into rich rows. Pure — no
 * network — so it serves both the live path and the snapshot path.
 *
 * @param {Record<string, any>} tickers
 * @param {number} expiryDate  YYYYMMDD
 * @returns {{rows: Array<DeriveOptionRow>, indexPrice: number, ts: number}}
 */
export function decodeTickers(tickers, expiryDate) {
  const expirationMs = expiryDateToMs(expiryDate);

  /** @type {Array<DeriveOptionRow>} */
  const rows = [];
  let indexPrice = NaN;
  let ts = 0;

  for (const [name, tk] of Object.entries(tickers)) {
    const parsed = parseInstrumentName(name);
    if (!parsed) continue;

    const op = tk.option_pricing ?? {};
    const stats = tk.stats ?? {};

    const iv = num(op.i);
    const idx = num(tk.I);
    if (Number.isFinite(idx)) indexPrice = idx;
    if (Number.isFinite(num(tk.t))) ts = Math.max(ts, num(tk.t));

    rows.push({
      instrument_name: name,
      strike: parsed.strike,
      option_type: parsed.type,
      expiration_ms: expirationMs,
      expiry_date: expiryDate,
      oi: num(stats.oi) || 0,
      markIv: iv, // already decimal
      forward: num(op.f),
      markPrice: num(op.m ?? tk.M),
      indexPrice: idx,
      // Greeks straight from Derive's pricer — handy for cross-checks and for
      // the API-greek code path. GEX recomputes gamma via BS for self-consistency
      // with the spot-shift curve, but we surface these too.
      apiDelta: num(op.d),
      apiGamma: num(op.g),
      apiVega: num(op.v),
      apiTheta: num(op.t),
      volume24h: num(stats.v) || 0,
    });
  }

  return { rows, indexPrice, ts };
}

/**
 * Path to the static chain snapshot, relative to the page. A GitHub Action
 * refreshes this every few minutes (see scripts/fetch_chain.py) because the
 * Derive API is not CORS-enabled for browsers — see the module header.
 */
export const SNAPSHOT_URL = "./data/chain.json";

/**
 * Load the ENTIRE surface from the static snapshot (same-origin, no CORS) and
 * decode it. This is the dashboard's primary data path. Returns a flat row
 * array plus the index price, the freshest per-instrument timestamp, the
 * snapshot's own fetch time, and the expiry count.
 *
 * @returns {Promise<{rows: Array<DeriveOptionRow>, indexPrice: number, ts: number, fetchedAt: number, expiries: number, stale: boolean}>}
 */
export async function getFullChain() {
  _stats.totalCalls += 1;
  _stats.lastCallTs = Date.now();
  let snap;
  try {
    // Cache-bust so a fresh Action commit shows up without a hard refresh.
    const resp = await fetch(`${SNAPSHOT_URL}?t=${Math.floor(Date.now() / 30000)}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`snapshot HTTP ${resp.status}`);
    snap = await resp.json();
  } catch (err) {
    _stats.errors += 1;
    throw new Error(`could not load chain snapshot (${err.message}). The data refresh Action may not have run yet.`);
  }
  return decodeSnapshot(snap);
}

/**
 * Decode a snapshot object (the parsed data/chain.json) into the getFullChain
 * return shape. Exposed for tests.
 *
 * @param {object} snap
 */
export function decodeSnapshot(snap) {
  const expiries = snap.expiries ?? [];
  /** @type {Array<DeriveOptionRow>} */
  const rows = [];
  let indexPrice = NaN;
  let ts = 0;
  for (const d of expiries) {
    const chain = snap.chains?.[String(d)];
    if (!chain) continue;
    const dec = decodeTickers(chain.tickers ?? {}, d);
    rows.push(...dec.rows);
    if (Number.isFinite(dec.indexPrice)) indexPrice = dec.indexPrice;
    ts = Math.max(ts, dec.ts);
  }
  const fetchedAt = num(snap.fetchedAt);
  // Older than 30 min ⇒ flag as stale (the Action refreshes every ~10 min).
  const stale = Number.isFinite(fetchedAt) && Date.now() - fetchedAt > 30 * 60 * 1000;
  return { rows, indexPrice, ts, fetchedAt, expiries: expiries.length, stale };
}

/**
 * Live full-chain fetch straight from the Derive API (no snapshot). Works only
 * where CORS allows it (server-side, or an allowlisted origin) — used by the
 * fetch script's logic and the smoke test, NOT by the deployed dashboard.
 *
 * @returns {Promise<{rows: Array<DeriveOptionRow>, indexPrice: number, ts: number, expiries: number}>}
 */
export async function getFullChainLive() {
  const expiries = await getExpiries();
  const chains = await Promise.all(expiries.map((e) => getChainForExpiry(e.expiryDate)));

  /** @type {Array<DeriveOptionRow>} */
  const rows = [];
  let indexPrice = NaN;
  let ts = 0;
  for (const c of chains) {
    rows.push(...c.rows);
    if (Number.isFinite(c.indexPrice)) indexPrice = c.indexPrice;
    ts = Math.max(ts, c.ts);
  }
  return { rows, indexPrice, ts, expiries: expiries.length };
}

/** Coerce Derive's string-encoded numbers to JS numbers; "" / null → NaN. */
function num(x) {
  if (x === null || x === undefined || x === "") return NaN;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Snapshot of the API call budget for the header readout.
 * @returns {{totalCalls: number, lastCallTs: number, errors: number}}
 */
export function getCallStats() {
  return { ..._stats };
}

/** Clear the cached instrument list (forces a re-enumeration of expiries). */
export function clearInstrumentsCache() {
  sessionStorage.removeItem(INSTRUMENTS_CACHE_KEY);
}

/**
 * @typedef {object} DeriveOptionRow
 * @property {string} instrument_name
 * @property {number} strike
 * @property {"call"|"put"} option_type
 * @property {number} expiration_ms
 * @property {number} expiry_date       YYYYMMDD
 * @property {number} oi                open interest, contracts (1 contract = 1 unit underlying)
 * @property {number} markIv            decimal (0.82 = 82%)
 * @property {number} forward           per-option forward price
 * @property {number} markPrice
 * @property {number} indexPrice
 * @property {number} apiDelta
 * @property {number} apiGamma
 * @property {number} apiVega
 * @property {number} apiTheta
 * @property {number} volume24h
 */
