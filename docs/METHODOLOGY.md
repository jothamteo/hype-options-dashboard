# Methodology

This document derives every formula computed in the dashboard. It is written for someone who knows Black-Scholes and basic options microstructure but wants to verify the implementation matches their understanding. Honest about assumptions; explicit about limitations.

Data source: [Derive](https://derive.xyz) (formerly Lyra), via the public market-data API at `api.lyra.finance`. The underlying tracked is **HYPE** (Hyperliquid's token); the same code retargets to any Derive underlying by changing one constant.

---

## 1. Black-Scholes greeks

Inputs: spot $S$, strike $K$, time-to-expiry $T$ (years), implied vol $\sigma$, risk-free rate $r$, dividend yield $q$. For HYPE we set $r = q = 0$; see §1.4 below.

$$d_1 = \frac{\ln(S/K) + (r - q + \sigma^2/2)\,T}{\sigma\sqrt{T}}, \qquad d_2 = d_1 - \sigma\sqrt{T}$$

### 1.1 Gamma

$$\Gamma = \frac{e^{-qT}\,\varphi(d_1)}{S\sigma\sqrt{T}}$$

where $\varphi$ is the standard normal pdf. With $q = 0$ this reduces to $\varphi(d_1) / (S\sigma\sqrt{T})$, which is what `bsGamma()` implements in `js/black_scholes.js`.

### 1.2 Delta (call / put)

$$\Delta_{\text{call}} = e^{-qT}\,N(d_1), \qquad \Delta_{\text{put}} = e^{-qT}\,(N(d_1) - 1)$$

We need $\Delta$ to find the $25\Delta$ put and call for risk-reversal / butterfly construction.

Derive's `/public/get_tickers` *does* return pricer greeks (delta, gamma, vega, theta) per instrument, unlike Deribit's book summary. We still recompute greeks locally from the mark IV for two reasons: (a) the zero-gamma flip requires repricing $\Gamma$ at hypothetical spot levels, which the API cannot give us — so for the at-spot snapshot to be *consistent* with the spot-shift curve, both must come from the same BS engine; (b) it keeps the dashboard fully backend-free and robust to occasional null greeks in the wings. The API greeks are still decoded (`apiGamma`, `apiDelta`, …) and available for cross-checks.

Note: Derive returns IV as a **decimal** (`0.82` = 82%), unlike Deribit which returns it as a percentage. No `/100` rescale is applied.

### 1.3 Implementation note — N(x)

We use the Abramowitz-Stegun approximation 26.2.17 for $N(x)$ (max error $< 7.5 \times 10^{-8}$), which is sufficient for IV space.

### 1.4 Why $r = 0$ for HYPE

There is no canonical risk-free rate for crypto. Using a USD T-bill rate distorts forwards because the basis isn't financed at T-bill — it's financed at perpetual funding. Using a perp-funding-derived rate is unstable (negative on bear days, positive on bull days, mean-reverting on hours). Using $r = 0$ pushes the basis information into $F$ instead, which Derive hands us directly per option (see §2). This is cleaner and more defensible than picking an arbitrary rate.

---

## 2. Forward F per expiry

For each option expiry $t_i$ we need the forward $F_i$ used in log-moneyness $k = \ln(K / F_i)$. Derive's option pricer returns a per-option `forward_price` directly in `get_tickers`, so — unlike a Deribit build — we do **not** need a separate futures fetch. Within an expiry the forward is a function of expiry, not strike, so every option of that expiry carries (essentially) the same forward; we take the **median** across the expiry's options to shrug off the occasional stale or zero outlier. `forwardAt()` interpolates linearly in time for any expiry timestamp not directly present, and extrapolates flat beyond the curve ends.

This is critical for the SVI fit: log-moneyness is $k = \ln(K / F_i)$, not $\ln(K / S)$. Using spot would bias $k$ by the basis, which drifts smoothly in time and would shift every smile horizontally without changing its shape — but term-structure comparisons across expiries would become noisy.

---

## 3. Dealer Gamma Exposure (GEX)

### 3.1 Per-option contribution

$$\text{GEX}_i = \Gamma_i \cdot \text{OI}_i \cdot \text{contractSize} \cdot S^2 \cdot 0.01 \cdot \epsilon_i$$

where $\epsilon_i = +1$ for calls and $\epsilon_i = -1$ for puts (SqueezeMetrics canonical assumption: dealers are net long calls, net short puts).

The factor $S^2 \cdot 0.01$ converts $\Gamma$ (dollar-gamma per share per dollar move) to the conventional GEX unit — dollar gamma per 1% spot move.

For Derive HYPE options, `contractSize = 1 HYPE` (1 contract = 1 unit of the underlying). OI is reported in contracts, so the product is in HYPE-denominated dollar exposure.

### 3.2 Aggregate by strike and zero-gamma flip

We sum $\text{GEX}_i$ across every live option at each strike, regardless of expiry, to get $\text{GEX}(K)$. The flip level is found by recomputing total GEX at hypothetical spot levels $S \in [0.80\,S_0, 1.20\,S_0]$ in 1% steps and locating the sign change (linearly interpolated). The flip is the spot at which dealers stop suppressing volatility: above flip → dealers long gamma → suppress; below → short gamma → amplify.

### 3.3 Dealer gamma regime

The sign of total GEX *at spot* gives the current regime, surfaced on the context strip:

- **Long gamma** (GEX > 0): dealers hedge against the move — sell rallies, buy dips — damping realized vol. Tape tends to mean-revert and pin.
- **Short gamma** (GEX < 0): dealers hedge with the move — buy rallies, sell dips — amplifying realized vol. Tape tends to trend and is squeeze-prone.

The zero-gamma flip is the spot at which this sign changes; its distance from spot (shown as a %) is a rough gauge of how much room price has before the regime flips.

### 3.4 Honest limits

- The SqueezeMetrics sign assumption was derived from SPX dealer flow circa 2015–2017. Derive's user mix is materially different — more prop, more directional retail, a vault-based AMM as counterparty. The sign of dealer positioning is genuinely less certain on a crypto venue, and HYPE option OI is small relative to TradFi underlyings.
- We surface this caveat and let the operator weigh the conclusions.
- An honest version of this dashboard would estimate dealer position from market-maker / vault quoting behavior. That's outside scope for a static, backend-free piece.

Citation: SqueezeMetrics, _The Implied Order Book and Gamma Exposure_, 2017.

---

## 4. Open Interest walls

Independently of gamma, we aggregate raw open interest by strike, split call vs put (`oiByStrike()`). Large call OI above spot tends to act as resistance / a dealer-supply zone; large put OI below spot tends to act as support. This complements GEX: GEX is the gamma-weighted hedging *pressure*, OI walls are the raw *positioning* that the pressure acts on. Calls are drawn upward, puts downward, with spot and nearest-expiry max-pain annotated.

---

## 5. SVI implied vol surface

### 5.1 Raw parameterization (Gatheral 2004)

For a single expiry $T$, total variance $w(k) = \sigma^2_{\text{IV}}(k) \cdot T$ is fit as

$$w(k) = a + b\bigl(\rho\,(k - m) + \sqrt{(k - m)^2 + \sigma^2}\bigr)$$

with five parameters $\{a, b, \rho, m, \sigma\}$ per expiry. Convex in $k$ when $b \ge 0$, $|\rho| < 1$, $\sigma > 0$.

### 5.2 Fitting

For each expiry we minimize

$$L(\theta) = \sum_i \bigl(w_i^{\text{market}} - w(k_i;\theta)\bigr)^2 + \lambda \cdot P(\theta)$$

where the penalty $P(\theta)$ enforces:

| Constraint | Penalty term |
|---|---|
| $b \ge 0$ | $\max(0, -b)^2$ |
| $|\rho| < 1$ | $\max(0, |\rho| - 0.999)^2$ |
| $\sigma > 0$ | $\max(0, 10^{-6} - \sigma)^2$ |
| $a + b\sigma\sqrt{1-\rho^2} \ge 0$ | $\max(0, -(a + b\sigma\sqrt{1-\rho^2}))^2$ |

Optimizer: Nelder-Mead simplex, hand-implemented in `js/svi.js`. Initial simplex seeded from market-implied moments: $m_0 = \text{argmin}_k\,w_i$, $a_0 = \min_i w_i$, $b_0 = $ rough slope, $\rho_0 = -0.3$, $\sigma_0 = 0.1$. Expiries with fewer than 5 priced strikes are skipped (too few points for a stable 5-parameter fit).

To maximize smile coverage, the surface fit includes options with **zero open interest** as long as the pricer returns a valid IV — they add smile points without affecting OI-weighted measures (GEX, max pain) which weight by OI and so ignore them.

### 5.3 Honest limits

- For very short-dated expiries (< 24h) the smile is dominated by gamma-kink dynamics and the SVI form fits poorly. Fit residuals (RMSE) are exposed in the per-expiry slice charts so the operator can see when the fit is unreliable.
- Multi-expiry no-arbitrage (calendar / butterfly across expiries) is **not** enforced. We fit each expiry independently. This is the standard "raw SVI" practice; SSVI / surface SVI exists but is overkill for visual purposes.

Citation: Gatheral, J., _A parsimonious arbitrage-free implied volatility parameterization_, 2004.

---

## 6. ATM IV term structure

For each expiry $T_i$ with fitted SVI parameters $\theta_i$, ATM IV is

$$\sigma_{\text{ATM}}(T_i) = \sqrt{w(0; \theta_i) / T_i}$$

i.e. evaluate the fitted total-variance curve at $k = 0$. We do **not** linearly interpolate market IVs at $k = 0$ because the at-the-money mark is not always on a listed strike (forward sits between two strikes), and using the SVI fit gives a smooth, mathematically consistent curve.

Plotted vs days-to-expiry on a log-x axis.

---

## 7. 25Δ Risk-reversal and Butterfly

For each expiry:

1. Compute $\Delta$ for every option using §1.2.
2. Find the put with $\arg\min_i |\Delta_i^{\text{put}} + 0.25|$ → call its IV $\sigma_{25\text{p}}$.
3. Find the call with $\arg\min_i |\Delta_i^{\text{call}} - 0.25|$ → call its IV $\sigma_{25\text{c}}$.
4. Compute:

$$\text{RR}_{25} = \sigma_{25\text{c}} - \sigma_{25\text{p}}$$

$$\text{BF}_{25} = \frac{\sigma_{25\text{c}} + \sigma_{25\text{p}}}{2} - \sigma_{\text{ATM}}$$

Plot RR and BF as term structures across expiries.

Convention reminder: by industry convention, "25Δ put" refers to the put whose magnitude of $\Delta$ is 0.25 — i.e., $\Delta = -0.25$. We use the absolute value when matching.

---

## 8. Max pain

For each expiry separately, candidate strikes $\{S^*\}$ are the listed strikes for that expiry. Total option-holder loss at expiry, were spot to land at $S^*$:

$$\text{pain}(S^*) = \sum_{\text{calls}} \text{OI}_c \cdot \max(0,\, S^* - K_c) + \sum_{\text{puts}} \text{OI}_p \cdot \max(0,\, K_p - S^*)$$

Max-pain strike is $\arg\min_{S^*} \text{pain}(S^*)$ — the strike at which option holders collectively lose the most (and writers, by symmetry, retain the most premium). The bar chart shows pain across all candidate strikes; the argmin is annotated. The "magnetism" interpretation is folklore — we plot the curve because its *shape* is informative regardless.

---

## 9. OI-weighted Put/Call ratio

Aggregate across all expiries:

$$\text{P/C} = \frac{\sum_{\text{puts}} \text{OI}_p}{\sum_{\text{calls}} \text{OI}_c}$$

Reported on the context strip. > 1 means more put than call OI (defensive / hedged positioning); < 1 the reverse.

---

## 10. Refresh and rate budget

The dashboard refreshes every 30 seconds. Per refresh:

- $N$× `/public/get_tickers` — one call per live expiry ($N \approx 11$ for HYPE), each returning that expiry's entire chain (greeks, OI, forward, index) in one abbreviated-format response.
- 0× `/public/get_instruments` — used only to enumerate expiries; cached in `sessionStorage` for 5 min.

Total: ≈11 HTTP requests per 30s ≈ 0.4 req/s, well within Derive's public-tier limits. The header surfaces the cumulative call counter so the operator (or reviewer) can verify the budget at a glance.

---

## 11. Citations

- Black, F. and Scholes, M. (1973). _The Pricing of Options and Corporate Liabilities_. Journal of Political Economy, 81(3): 637–654.
- Gatheral, J. (2004). _A parsimonious arbitrage-free implied volatility parameterization with application to the valuation of volatility derivatives_. Madrid Quant Congress.
- SqueezeMetrics (2017). _The Implied Order Book and Gamma Exposure_.
- Hull, J. C. (2017). _Options, Futures, and Other Derivatives_, 11th edition. Pearson.
- Abramowitz, M. and Stegun, I. (1964). _Handbook of Mathematical Functions_. National Bureau of Standards. (For the $N(x)$ approximation.)
