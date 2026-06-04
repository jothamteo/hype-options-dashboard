# HYPE Options Dashboard

Live dealer-gamma (GEX), open-interest walls, implied-vol surface, skew, and max-pain dashboard for **HYPE** options on [Derive](https://derive.xyz) (formerly Lyra).

**Browser-only. No backend, no build step, no API key, no npm.** Open `index.html` and it talks straight to Derive's public API. All the math — Black-Scholes greeks, SVI smile fits, GEX, max pain — runs locally in your browser.

🔗 **Live:** https://jothamteo.github.io/hype-options-dashboard/
📐 **Methodology:** every formula is derived in [docs/methodology.html](docs/methodology.html)

---

## What it shows

| Panel | What it tells you |
|---|---|
| **Context strip** | HYPE spot, total OI (call/put split), put/call ratio, priced strikes, dealer-gamma regime, zero-gamma flip |
| **Dealer Gamma Exposure** | GEX by strike (calls +, puts −) and total GEX vs hypothetical spot, with the zero-gamma flip annotated |
| **Open Interest walls** | Raw call OI (resistance) above spot, put OI (support) below — the positioning GEX acts on |
| **IV surface** | SVI-fitted implied-vol surface plus per-expiry smile slices with fit residuals |
| **ATM term structure** | At-the-money IV across expiries |
| **25Δ skew** | Risk-reversal and butterfly term structures |
| **Max pain** | Per-expiry pain curve and the max-pain strike |

### Reading the dealer-gamma regime

- **Long γ** (GEX > 0 at spot): dealers sell rallies / buy dips to stay hedged → vol gets *damped*, tape mean-reverts and pins toward high-OI strikes.
- **Short γ** (GEX < 0 at spot): dealers chase the move → vol gets *amplified*, tape trends and is squeeze-prone.

The **zero-gamma flip** is the spot at which that sign flips. Its distance from spot is your runway before the regime changes — the single most actionable number on the page for short-dated positioning.

---

## Data source

[Derive](https://docs.derive.xyz/) public market-data API at `api.lyra.finance` — no auth required for market data.

- `get_instruments` enumerates live expiries (cached 5 min).
- `get_tickers` (one call per expiry, ≈11 for HYPE) returns each expiry's **entire** chain in one abbreviated-format response: per-strike greeks (delta/gamma/vega/theta), IV, mark, **per-option forward price**, index price, and open interest.

≈11 requests per 30s refresh (~0.4 req/s) — well within Derive's public limits. The header shows a live call counter.

Because Derive returns the forward per option, there's no separate futures fetch (a Deribit build needs one). IV comes back as a decimal, not a percentage.

---

## Run locally

It's static files — any HTTP server works. ES modules need to be served over `http://`, not opened as `file://`.

```bash
git clone https://github.com/jothamteo/hype-options-dashboard.git
cd hype-options-dashboard
python3 -m http.server 8080
# open http://localhost:8080
```

No install step. The only external runtime deps are the Tailwind and Plotly CDNs (loaded in `index.html`).

---

## Architecture

```
index.html              layout + CDN deps (Tailwind, Plotly)
js/
  derive.js             Derive API client + abbreviated-format decoder
  black_scholes.js      BS greeks, N(x) via Abramowitz-Stegun
  gex.js                GEX, zero-gamma flip, OI stats, OI walls
  forwards.js           per-expiry forward curve from option forwards
  svi.js                raw SVI fit (Nelder-Mead, hand-rolled)
  max_pain.js           per-expiry max-pain curves
  term_structure.js     ATM IV term structure from SVI fits
  skew.js               25Δ risk-reversal / butterfly
  main.js               refresh loop + render dispatch
  plots/                Plotly render modules
docs/                   methodology (Markdown + rendered HTML w/ KaTeX)
tests/                  browser test pages (BS, SVI, GEX, skew, max-pain)
                        + a live Derive API smoke test
```

### Tests

Open any page under `tests/` in a served browser. The math tests (`test_black_scholes`, `test_svi`, `test_gex`, `test_skew`, `test_max_pain`) run against fixed inputs with known answers. `test_derive_dump.html` hits the live API and prints the decoded shapes.

---

## Retargeting to another underlying

Derive lists more than HYPE. Change the `CURRENCY` constant in `js/derive.js` (e.g. `"ETH"`, `"BTC"`) and update the labels in `index.html`. Everything else is currency-agnostic.

---

## Disclaimer

For research and education. Dealer-positioning sign conventions (SqueezeMetrics +calls/−puts) are assumptions, not ground truth — see Methodology §3.4 for why they're less certain on a crypto venue. **Not financial advice.**

## License

MIT — see [LICENSE](LICENSE).
