# Hi FI Sim

**Live:** https://jpapu.github.io/hifisim/

**Hi**gh-**Fi**delity financial **Sim**ulation — a browser-only suite of Monte
Carlo savings tools. It models two *independent* uncertain quantities as random
walks and judges them paired, simulation by simulation:

1. **Portfolio growth** — log-normal / geometric Brownian motion, stepped
   monthly, from a mean annual return + volatility.
2. **College cost** — log-normal, stepped annually, from a mean inflation rate +
   volatility.

For each simulation, success means *that* portfolio ≥ *that* projected bill. The
headline result is the **probability of fully funding college** and the
distribution of the **funding ratio** (ending portfolio ÷ projected cost).

## Tools (top nav)

Two scenarios sit in the primary nav; **College** carries three solve directions
as sub-tabs.

- **College** (sub-tabs: *Forward · Reverse · Reverse Coast*)
  - **Forward** — given your contribution, what's the probability of funding college?
  - **Reverse** — given a target probability, the required **monthly contribution**.
  - **Reverse Coast** — given a target probability and **$0/mo**, the **starting
    lump sum** needed today (the "Coast number").
  A bisection solver powers the reverse directions — P(success) is monotonic in
  the solved variable at a fixed seed, so it converges cleanly, then shows the
  distribution at the solved value. Forward at a solved value reproduces the
  target probability (the directions are inverses).
- **Bi-Phase College** — *reverse, two accounts*: given a target probability and
  an endpoint tier (out-of-state / private / prestigious / custom), solve the
  monthly amount and split it across two phases. **Phase 1** funds a tax-free
  **529** until it's on track to cover in-state (deterministic switch using
  expected growth); **Phase 2** redirects the same amount to a **taxable
  brokerage** (15% LTCG on gains at withdrawal, editable) for the gap up to the
  endpoint. Both accounts ride one shared market path; success = combined
  after-tax value ≥ endpoint cost. The chart marks the 529→brokerage switch.
  Because the brokerage is taxed, this needs slightly more than the single-
  account Reverse tool — that premium is the tax drag.
- **FIRE** (sub-tabs: *Forward · Reverse*) — an **accumulation** projection: grow
  a portfolio (starting value + monthly contributions, nominal returns) and
  compare it to your **FI number** = annual spend ÷ safe withdrawal rate,
  inflated to your retirement date. *Forward* → probability your portfolio reaches
  the FI number (i.e., can cover expenses at the chosen withdrawal rate);
  *Reverse* → the monthly contribution required to get there at a target
  probability. Reuses the College engine and charts, with the goal being the FI
  number instead of college cost.

## Running it

The simulation runs in a **Web Worker**, which browsers block from loading over
`file://`. So serve the folder over HTTP:

```sh
cd Monte529
python3 -m http.server 8765
# then open http://localhost:8765/
```

(Or use the Claude Code preview, configured in `.claude/launch.json`.)

Fill the form, click **Run Simulation**. Tens of thousands of simulations finish
in well under a second; the worker keeps the UI responsive and a progress bar
shows progress.

## Outputs

- **All simulations** — every (sampled) portfolio and cost path on one chart,
  with p10 / p50 / p90 percentile bands over *all* runs.
- **Distribution of outcomes** — histogram of the funding ratio with a marker at
  `1.0 = fully funded`; green = funded, orange = shortfall.
- **Ending portfolio vs. projected cost** — two peak-normalized density curves on
  one dollar axis (portfolio green, cost orange) with dashed medians. Green mass
  left of orange = shortfall futures; right = surplus. Directly shows worst-case
  shortfall and best-case overfunding.
- **Summary** — probability of success, median funding ratio, median ending
  portfolio, median projected cost, and median surplus/shortfall (with p10–p90
  ranges).

## Files

| File | Role |
|------|------|
| `sim.js` | Pure Monte Carlo core (PRNG, GBM, per-sim pairing, aggregation). No DOM. |
| `worker.js` | Web Worker shell — runs `sim.js`, streams progress, returns results. |
| `app.js` | Reads/validates the form, drives the worker and progress bar. |
| `charts.js` | Raw-canvas spaghetti chart + Chart.js histogram + summary cards. |
| `index.html` / `styles.css` | UI. |
| `vendor/chart.umd.min.js` | Chart.js, pinned locally (offline-safe). |

## Modeling notes & assumptions

- **Reproducible**: enter a seed to reproduce an exact run; leave it blank for a
  random one.
- Returns use the `−½σ²` variance-drag correction, so with **0% volatility the
  result equals plain compound interest** exactly.
- Contributions are applied at month-end.
- **Fixed vs. randomized**: each variable (portfolio returns, college cost) has
  its own toggle. *Randomized* uses the entered volatility and produces a spread
  of outcomes; *fixed* sets that variable's volatility to 0, giving a single
  deterministic path (no spread).
- **College-cost presets** (in-state / out-of-state / private / prestigious)
  auto-fill the cost section with national-average total cost of attendance for
  2024-25 **and sector-specific inflation/volatility** (public is lower-growth
  but lumpier; private/elite climb faster but steadier); "Custom" unlocks manual
  entry. An **Includes** toggle switches each preset between *tuition & fees only*
  and the *full total* (adding room & board). Click *assumptions & sources* (or
  the ⓘ) for the figures and citations.
- v1 assumes a **single lump-sum comparison** at the college-start date (no
  4-year drawdown) and **independent** return/inflation draws. 529 growth is
  treated as tax-free. Possible future additions: correlation between the two
  variables, a 4-year drawdown phase, an inflation-adjusted (real-dollar)
  toggle, and an age-based glide path.
