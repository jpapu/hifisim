/*
 * sim.js — Pure Monte Carlo core for Monte529.
 *
 * No DOM, no Worker APIs: this file is loaded both by worker.js (via
 * importScripts) and can be loaded with <script> for console testing.
 * Everything is exposed on globalThis.MonteSim.
 *
 * Two INDEPENDENT stochastic variables, paired per simulation:
 *   1. Portfolio  — log-normal / GBM, stepped monthly.
 *   2. College cost — log-normal, stepped annually.
 * Success for simulation k is judged on that same k's pair:
 *   endingPortfolio[k] >= endingCost[k].
 */
(function (root) {
  'use strict';

  // ---- Random number generation ---------------------------------------

  // mulberry32: tiny, fast, seedable PRNG → uniforms in [0, 1).
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Hash an arbitrary seed (string or number) into a uint32.
  function hashSeed(s) {
    s = String(s);
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function defaultSeed() {
    return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  }

  // Standard-normal generator via Box-Muller, caching the spare value
  // (free 2x efficiency). Clamps u1 away from 0 to avoid ln(0).
  function makeNormal(rand) {
    let spare = null;
    return function () {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u1 = rand();
      const u2 = rand();
      if (u1 < 1e-12) u1 = 1e-12;
      const r = Math.sqrt(-2 * Math.log(u1));
      const theta = 2 * Math.PI * u2;
      spare = r * Math.sin(theta);
      return r * Math.cos(theta);
    };
  }

  // ---- Statistics helpers ---------------------------------------------

  // Percentile of a numerically-sorted typed array (linear interpolation).
  function percentile(sorted, p) {
    const n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    const idx = p * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const frac = idx - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
  }

  // p10/p50/p90 bands at each stored time index, across ALL N sims.
  // byTime is column-major: block [t*N, (t+1)*N) holds time index t.
  function computeBands(byTime, cols, N) {
    const p10 = new Array(cols);
    const p50 = new Array(cols);
    const p90 = new Array(cols);
    for (let t = 0; t < cols; t++) {
      const col = byTime.slice(t * N, (t + 1) * N); // copy (sort mutates)
      col.sort(); // TypedArray.sort is numeric by default
      p10[t] = percentile(col, 0.1);
      p50[t] = percentile(col, 0.5);
      p90[t] = percentile(col, 0.9);
    }
    return { p10, p50, p90 };
  }

  // Extract up to `count` full paths (even stride) for the spaghetti plot.
  function extractPaths(byTime, cols, N, count) {
    count = Math.min(count, N);
    const stride = N / count;
    const out = [];
    for (let i = 0; i < count; i++) {
      const k = Math.floor(i * stride);
      const path = new Array(cols);
      for (let t = 0; t < cols; t++) path[t] = byTime[t * N + k];
      out.push(path);
    }
    return out;
  }

  // Histogram of funding ratios. Marker line is drawn at 1.0 by the chart,
  // so bin edges need not land exactly on 1.0.
  function buildHistogram(ratio) {
    const sorted = Float64Array.from(ratio).sort();
    const nbins = 50;
    const lo = 0;
    let hi = percentile(sorted, 0.99); // ignore extreme lucky-tail outliers
    if (!isFinite(hi) || hi < 1.2) hi = 1.2; // keep the 1.0 marker visible
    const binWidth = (hi - lo) / nbins;
    const counts = new Array(nbins).fill(0);
    for (let i = 0; i < ratio.length; i++) {
      let idx = Math.floor((ratio[i] - lo) / binWidth);
      if (idx < 0) idx = 0;
      if (idx >= nbins) idx = nbins - 1; // overflow into top bin
      counts[idx]++;
    }
    const binEdges = new Array(nbins + 1);
    for (let i = 0; i <= nbins; i++) binEdges[i] = lo + i * binWidth;
    return { binEdges, counts, fullyFundedX: 1.0 };
  }

  function pct(sorted) {
    return {
      p10: percentile(sorted, 0.1),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p90: percentile(sorted, 0.9),
    };
  }

  // ---- The simulation --------------------------------------------------

  function runSimulation(inp, onProgress) {
    const startingValue = +inp.startingValue;
    const years = inp.years | 0;
    const monthlyContribution = +inp.monthlyContribution;
    const annualCollegeCost = +inp.annualCollegeCost;
    const yearsOfCollege = +inp.yearsOfCollege;
    const meanAnnualReturn = +inp.meanAnnualReturn;
    const returnVolatility = +inp.returnVolatility;
    const meanInflation = +inp.meanInflation;
    const inflationVolatility = +inp.inflationVolatility;
    const N = inp.numSimulations | 0;
    const drawCount = (inp.drawCount | 0) || 300;

    const cols = years + 1; // annual snapshots incl. t = 0
    const C0 = annualCollegeCost * yearsOfCollege; // today's total bill

    // Annual -> monthly GBM parameters. The -0.5*sigma^2 drift removes the
    // log-normal bias; it vanishes at sigma = 0 so the zero-vol identity
    // (start*(1+r)^years) holds exactly.
    const sPort = returnVolatility / Math.sqrt(12);
    const driftPort = Math.log(1 + meanAnnualReturn) / 12 - 0.5 * sPort * sPort;

    // Annual cost-inflation parameters.
    const sInfl = inflationVolatility;
    const driftCost = Math.log(1 + meanInflation) - 0.5 * sInfl * sInfl;

    const seedVal =
      inp.seed === null || inp.seed === undefined || inp.seed === ''
        ? defaultSeed()
        : hashSeed(inp.seed);
    const rand = mulberry32(seedVal);
    const normal = makeNormal(rand);

    // Column-major storage so each time index is contiguous for sorting.
    const portByTime = new Float64Array(cols * N);
    const costByTime = new Float64Array(cols * N);
    const endPort = new Float64Array(N);
    const endCost = new Float64Array(N);
    const ratio = new Float64Array(N);
    const surplus = new Float64Array(N);

    const progressEvery = Math.max(1, Math.floor(N / 100));

    for (let k = 0; k < N; k++) {
      // Portfolio path (monthly GBM, contribution at end of month).
      let portfolio = startingValue;
      portByTime[k] = portfolio; // time index 0
      for (let y = 1; y <= years; y++) {
        for (let mo = 0; mo < 12; mo++) {
          portfolio *= Math.exp(driftPort + sPort * normal());
          portfolio += monthlyContribution;
        }
        portByTime[y * N + k] = portfolio;
      }

      // Cost path (annual, independent draws from the same stream).
      let cost = C0;
      costByTime[k] = cost;
      for (let y = 1; y <= years; y++) {
        cost *= Math.exp(driftCost + sInfl * normal());
        costByTime[y * N + k] = cost;
      }

      endPort[k] = portfolio;
      endCost[k] = cost;
      ratio[k] = portfolio / cost; // PER-SIM funding ratio
      surplus[k] = portfolio - cost; // PER-SIM surplus

      if (onProgress && k % progressEvery === 0) onProgress(k, N);
    }
    if (onProgress) onProgress(N, N);

    // Aggregation (shared with the bi-phase engine).
    return buildResult(portByTime, costByTime, endPort, endCost, ratio, surplus, cols, N, years, drawCount, seedVal);
  }

  // Turn the per-time-index storage + per-sim endings into the result object
  // the charts consume. "portfolio" is the asset series, "cost" the goal.
  function buildResult(portByTime, costByTime, endPort, endCost, ratio, surplus, cols, N, years, drawCount, seedVal) {
    const bands = {
      portfolio: computeBands(portByTime, cols, N),
      cost: computeBands(costByTime, cols, N),
    };
    const pathsForPlot = {
      portfolio: extractPaths(portByTime, cols, N, drawCount),
      cost: extractPaths(costByTime, cols, N, drawCount),
    };

    const sortedRatio = Float64Array.from(ratio).sort();
    const sortedPort = Float64Array.from(endPort).sort();
    const sortedCost = Float64Array.from(endCost).sort();
    const sortedSurplus = Float64Array.from(surplus).sort();

    let successes = 0;
    for (let k = 0; k < N; k++) if (ratio[k] >= 1) successes++;

    const timeAxis = new Array(cols);
    for (let t = 0; t < cols; t++) timeAxis[t] = t;

    const summary = {
      probabilityOfSuccess: successes / N,
      medianEndingPortfolio: percentile(sortedPort, 0.5),
      medianProjectedCost: percentile(sortedCost, 0.5),
      medianFundingRatio: percentile(sortedRatio, 0.5),
      medianSurplus: percentile(sortedSurplus, 0.5),
      percentiles: {
        endingPortfolio: pct(sortedPort),
        projectedCost: pct(sortedCost),
        fundingRatio: pct(sortedRatio),
      },
    };

    return {
      type: 'result',
      meta: { numSimulations: N, years: years, seedUsed: seedVal },
      timeAxis: timeAxis,
      pathsForPlot: pathsForPlot,
      bands: bands,
      endings: { fundingRatio: ratio, endingPortfolio: endPort, endingCost: endCost },
      histogram: { fundingRatio: buildHistogram(ratio) },
      summary: summary,
    };
  }

  // ---- Reverse mode: solve for required contribution ------------------

  // Lightweight P(success) only — no bands/paths/histogram. Consumes the RNG
  // in the EXACT same order as runSimulation, so for a fixed seed its result
  // matches runSimulation's probabilityOfSuccess exactly.
  function probabilityOnly(inp) {
    const startingValue = +inp.startingValue;
    const years = inp.years | 0;
    const monthlyContribution = +inp.monthlyContribution;
    const N = inp.numSimulations | 0;
    const C0 = +inp.annualCollegeCost * +inp.yearsOfCollege;
    const sPort = +inp.returnVolatility / Math.sqrt(12);
    const driftPort = Math.log(1 + +inp.meanAnnualReturn) / 12 - 0.5 * sPort * sPort;
    const sInfl = +inp.inflationVolatility;
    const driftCost = Math.log(1 + +inp.meanInflation) - 0.5 * sInfl * sInfl;
    const seedVal =
      inp.seed === null || inp.seed === undefined || inp.seed === ''
        ? defaultSeed()
        : hashSeed(inp.seed);
    const normal = makeNormal(mulberry32(seedVal));

    let successes = 0;
    for (let k = 0; k < N; k++) {
      let portfolio = startingValue;
      for (let y = 1; y <= years; y++) {
        for (let mo = 0; mo < 12; mo++) {
          portfolio *= Math.exp(driftPort + sPort * normal());
          portfolio += monthlyContribution;
        }
      }
      let cost = C0;
      for (let y = 1; y <= years; y++) cost *= Math.exp(driftCost + sInfl * normal());
      if (portfolio >= cost) successes++;
    }
    return successes / N;
  }

  // Find the monthly contribution that achieves targetP probability of success.
  // P(success) is monotonically non-decreasing in contribution at a FIXED seed
  // (more contribution only raises each path's ending value), so bisection is
  // well-defined. We force a fixed seed across all evaluations for that.
  function solveForContribution(inp, targetP, onProgress) {
    const seed =
      inp.seed === null || inp.seed === undefined || inp.seed === ''
        ? 'hifisim-solver'
        : inp.seed;
    const base = Object.assign({}, inp, { seed: seed });
    const pAt = function (c) {
      return probabilityOnly(Object.assign({}, base, { monthlyContribution: c }));
    };

    const CAP = 1000000; // $1M/mo sanity ceiling
    const maxIter = 60;
    let iter = 0;
    const tick = function () {
      iter++;
      if (onProgress) onProgress(Math.min(iter, maxIter), maxIter);
    };
    const finalize = function (c, reachable) {
      const result = runSimulation(Object.assign({}, base, { monthlyContribution: c }));
      result.solve = {
        reachable: reachable,
        contribution: c,
        value: c,
        solveFor: 'contribution',
        achievedP: result.summary.probabilityOfSuccess,
        targetP: targetP,
      };
      return result;
    };

    // Coasting ($0) may already clear the bar.
    if (pAt(0) >= targetP) return finalize(0, true);

    // Bracket: grow hi until it meets the target (or we hit the cap).
    let hi = 100;
    let pHi = pAt(hi);
    tick();
    while (pHi < targetP && hi < CAP) {
      hi = Math.min(hi * 2, CAP);
      pHi = pAt(hi);
      tick();
    }
    if (pHi < targetP) return finalize(CAP, false); // unreachable within cap

    // Bisect between 0 (known to fail) and hi (meets) to ~$1 precision.
    let lo = 0;
    while (hi - lo > 1 && iter < maxIter) {
      const mid = (lo + hi) / 2;
      if (pAt(mid) >= targetP) hi = mid;
      else lo = mid;
      tick();
    }
    return finalize(Math.ceil(hi), true);
  }

  // Reverse "coast": with $0 monthly contributions, find the starting lump sum
  // that achieves targetP. P(success) is monotonic in starting value.
  function solveForStartingValue(inp, targetP, onProgress) {
    const seed =
      inp.seed === null || inp.seed === undefined || inp.seed === ''
        ? 'hifisim-coast'
        : inp.seed;
    const base = Object.assign({}, inp, { seed: seed, monthlyContribution: 0 });
    const pAt = function (s) {
      return probabilityOnly(Object.assign({}, base, { startingValue: s }));
    };
    const CAP = 100000000; // $100M ceiling
    const maxIter = 80;
    let iter = 0;
    const tick = function () {
      iter++;
      if (onProgress) onProgress(Math.min(iter, maxIter), maxIter);
    };
    const finalize = function (s, reachable) {
      const result = runSimulation(Object.assign({}, base, { startingValue: s }));
      result.solve = {
        reachable: reachable,
        value: s,
        solveFor: 'startingValue',
        achievedP: result.summary.probabilityOfSuccess,
        targetP: targetP,
      };
      return result;
    };

    // lo = 0 has no money (P = 0); bracket hi upward until it clears the target.
    let hi = 10000;
    let pHi = pAt(hi);
    tick();
    while (pHi < targetP && hi < CAP) {
      hi = Math.min(hi * 2, CAP);
      pHi = pAt(hi);
      tick();
    }
    if (pHi < targetP) return finalize(CAP, false);
    let lo = 0;
    while (hi - lo > 1 && iter < maxIter) {
      const mid = (lo + hi) / 2;
      if (pAt(mid) >= targetP) hi = mid;
      else lo = mid;
      tick();
    }
    return finalize(Math.ceil(hi), true);
  }

  // ---- Bi-phase: 529 (to in-state) then taxable brokerage (for the rest) --

  function seedOf(inp) {
    return inp.seed === null || inp.seed === undefined || inp.seed === ''
      ? defaultSeed()
      : hashSeed(inp.seed);
  }
  function afterTax(balance, basis, ltcg) {
    const gain = balance > basis ? balance - basis : 0;
    return balance - gain * ltcg; // 15%-ish LTCG only on the gain, at withdrawal
  }

  // Deterministic Phase-1 length (months): keep funding the 529 until its
  // balance, coasted at the EXPECTED return for the remaining months, would
  // reach the projected in-state cost at college. Recomputed per contribution.
  function computeBiPhaseSwitch(inp, m) {
    const Y = inp.years | 0;
    const M = Y * 12;
    const g = Math.pow(1 + +inp.meanAnnualReturn, 1 / 12); // expected, no vol
    const inStateToday = +inp.inStateAnnual * +inp.yearsOfCollege;
    const inStateProjected = inStateToday * Math.pow(1 + +inp.inStateInflation, Y);
    let b = +inp.startingValue;
    for (let t = 0; t <= M; t++) {
      if (b * Math.pow(g, M - t) >= inStateProjected) return t;
      if (t < M) b = b * g + m;
    }
    return M; // never on track for in-state within the horizon
  }

  // Shared market path drives both accounts. 529 funded months [0,T1); then it
  // coasts while the taxable brokerage is funded [T1,M). Combined value is the
  // after-tax liquidation value (529 tax-free + brokerage minus LTCG on gains).
  function biPhaseProbabilityOnly(inp, m, T1) {
    const S = +inp.startingValue;
    const Y = inp.years | 0;
    const M = Y * 12;
    const N = inp.numSimulations | 0;
    const endpointTotal = +inp.annualCollegeCost * +inp.yearsOfCollege;
    const sPort = +inp.returnVolatility / Math.sqrt(12);
    const driftPort = Math.log(1 + +inp.meanAnnualReturn) / 12 - 0.5 * sPort * sPort;
    const sInfl = +inp.inflationVolatility;
    const driftCost = Math.log(1 + +inp.meanInflation) - 0.5 * sInfl * sInfl;
    const ltcg = +inp.ltcgRate;
    const normal = makeNormal(mulberry32(seedOf(inp)));

    let successes = 0;
    for (let k = 0; k < N; k++) {
      let b529 = S, bBrok = 0, basis = 0;
      for (let mo = 0; mo < M; mo++) {
        const g = Math.exp(driftPort + sPort * normal());
        b529 *= g;
        bBrok *= g;
        if (mo < T1) b529 += m;
        else { bBrok += m; basis += m; }
      }
      let cost = endpointTotal;
      for (let y = 1; y <= Y; y++) cost *= Math.exp(driftCost + sInfl * normal());
      if (b529 + afterTax(bBrok, basis, ltcg) >= cost) successes++;
    }
    return successes / N;
  }

  // Full result (annual snapshots of after-tax combined value vs endpoint cost).
  function runBiPhase(inp, m, T1) {
    const S = +inp.startingValue;
    const Y = inp.years | 0;
    const M = Y * 12;
    const N = inp.numSimulations | 0;
    const cols = Y + 1;
    const drawCount = (inp.drawCount | 0) || 300;
    const endpointTotal = +inp.annualCollegeCost * +inp.yearsOfCollege;
    const sPort = +inp.returnVolatility / Math.sqrt(12);
    const driftPort = Math.log(1 + +inp.meanAnnualReturn) / 12 - 0.5 * sPort * sPort;
    const sInfl = +inp.inflationVolatility;
    const driftCost = Math.log(1 + +inp.meanInflation) - 0.5 * sInfl * sInfl;
    const ltcg = +inp.ltcgRate;
    const seedVal = seedOf(inp);
    const normal = makeNormal(mulberry32(seedVal));

    const assetByTime = new Float64Array(cols * N);
    const costByTime = new Float64Array(cols * N);
    const endAsset = new Float64Array(N);
    const endCost = new Float64Array(N);
    const ratio = new Float64Array(N);
    const surplus = new Float64Array(N);

    for (let k = 0; k < N; k++) {
      let b529 = S, bBrok = 0, basis = 0;
      assetByTime[k] = S; // t = 0
      let yi = 1;
      for (let mo = 0; mo < M; mo++) {
        const g = Math.exp(driftPort + sPort * normal());
        b529 *= g;
        bBrok *= g;
        if (mo < T1) b529 += m;
        else { bBrok += m; basis += m; }
        if ((mo + 1) % 12 === 0) {
          assetByTime[yi * N + k] = b529 + afterTax(bBrok, basis, ltcg);
          yi++;
        }
      }
      let cost = endpointTotal;
      costByTime[k] = cost;
      for (let y = 1; y <= Y; y++) {
        cost *= Math.exp(driftCost + sInfl * normal());
        costByTime[y * N + k] = cost;
      }
      const finalAsset = assetByTime[Y * N + k];
      endAsset[k] = finalAsset;
      endCost[k] = cost;
      ratio[k] = finalAsset / cost;
      surplus[k] = finalAsset - cost;
    }
    return buildResult(assetByTime, costByTime, endAsset, endCost, ratio, surplus, cols, N, Y, drawCount, seedVal);
  }

  // Reverse bi-phase: find the monthly amount achieving targetP against the
  // endpoint, with the deterministic in-state phase split recomputed per amount.
  function solveBiPhase(inp, targetP, onProgress) {
    const seed =
      inp.seed === null || inp.seed === undefined || inp.seed === ''
        ? 'hifisim-biphase'
        : inp.seed;
    const base = Object.assign({}, inp, { seed: seed });
    const pAt = function (m) {
      return biPhaseProbabilityOnly(base, m, computeBiPhaseSwitch(base, m));
    };
    const CAP = 1000000;
    const maxIter = 60;
    let iter = 0;
    const tick = function () {
      iter++;
      if (onProgress) onProgress(Math.min(iter, maxIter), maxIter);
    };
    const finalize = function (m, reachable) {
      const T1 = computeBiPhaseSwitch(base, m);
      const result = runBiPhase(base, m, T1);
      result.solve = {
        reachable: reachable,
        contribution: m,
        value: m,
        solveFor: 'contribution',
        achievedP: result.summary.probabilityOfSuccess,
        targetP: targetP,
      };
      result.biphase = { phase1Months: T1, phase1Years: T1 / 12, totalYears: base.years | 0 };
      return result;
    };

    if (pAt(0) >= targetP) return finalize(0, true);
    let hi = 100;
    let pHi = pAt(hi);
    tick();
    while (pHi < targetP && hi < CAP) {
      hi = Math.min(hi * 2, CAP);
      pHi = pAt(hi);
      tick();
    }
    if (pHi < targetP) return finalize(CAP, false);
    let lo = 0;
    while (hi - lo > 1 && iter < maxIter) {
      const mid = (lo + hi) / 2;
      if (pAt(mid) >= targetP) hi = mid;
      else lo = mid;
      tick();
    }
    return finalize(Math.ceil(hi), true);
  }

  // ---- FIRE: decumulation in today's dollars (real returns) -----------
  // Fixed-real withdrawal (the "4% rule"): a constant inflation-adjusted amount
  // is taken each month from a still-volatile portfolio. Success = the balance
  // never hits zero across the fixed retirement horizon. Modeled in REAL terms,
  // so returns are real (after-inflation) and spending is constant.

  // Ending-balance histogram; the $0 bin holds the "ran out" mass.
  function buildBalanceHistogram(vals) {
    var sorted = Float64Array.from(vals).sort();
    var nbins = 50;
    var lo = 0;
    var hi = percentile(sorted, 0.98);
    if (!isFinite(hi) || hi <= 0) hi = Math.max(1, percentile(sorted, 1));
    if (hi <= 0) hi = 1;
    var bw = (hi - lo) / nbins;
    var counts = new Array(nbins).fill(0);
    for (var i = 0; i < vals.length; i++) {
      var idx = Math.floor((vals[i] - lo) / bw);
      if (idx < 0) idx = 0;
      if (idx >= nbins) idx = nbins - 1;
      counts[idx]++;
    }
    var binEdges = new Array(nbins + 1);
    for (var e = 0; e <= nbins; e++) binEdges[e] = lo + e * bw;
    return { binEdges: binEdges, counts: counts, depletedX: 0 };
  }

  // Lightweight survival probability. Draws exactly one normal per month every
  // path (even after depletion) so the RNG stays aligned across nest-egg values
  // — that keeps P(survival) a clean monotonic function for the solver.
  function decumulationSurvivalOnly(inp) {
    var S = +inp.startingValue;
    var Y = inp.retirementYears | 0;
    var M = Y * 12;
    var N = inp.numSimulations | 0;
    var w = +inp.annualSpending / 12;
    var sReal = +inp.returnVolatility / Math.sqrt(12);
    var driftReal = Math.log(1 + +inp.meanAnnualReturn) / 12 - 0.5 * sReal * sReal;
    var normal = makeNormal(mulberry32(seedOf(inp)));
    var survived = 0;
    for (var k = 0; k < N; k++) {
      var bal = S;
      var alive = true;
      for (var mo = 0; mo < M; mo++) {
        var z = normal(); // always drawn — keeps the stream aligned
        if (alive) {
          bal *= Math.exp(driftReal + sReal * z);
          bal -= w;
          if (bal <= 0) alive = false;
        }
      }
      if (alive) survived++;
    }
    return survived / N;
  }

  function runDecumulation(inp) {
    var S = +inp.startingValue;
    var Y = inp.retirementYears | 0;
    var M = Y * 12;
    var N = inp.numSimulations | 0;
    var cols = Y + 1;
    var drawCount = (inp.drawCount | 0) || 300;
    var w = +inp.annualSpending / 12;
    var sReal = +inp.returnVolatility / Math.sqrt(12);
    var driftReal = Math.log(1 + +inp.meanAnnualReturn) / 12 - 0.5 * sReal * sReal;
    var seedVal = seedOf(inp);
    var normal = makeNormal(mulberry32(seedVal));

    var balByTime = new Float64Array(cols * N);
    var endBal = new Float64Array(N);
    var survived = 0;

    for (var k = 0; k < N; k++) {
      var bal = S;
      var alive = true;
      balByTime[k] = S;
      var yi = 1;
      for (var mo = 0; mo < M; mo++) {
        var z = normal();
        if (alive) {
          bal *= Math.exp(driftReal + sReal * z);
          bal -= w;
          if (bal <= 0) { bal = 0; alive = false; }
        }
        if ((mo + 1) % 12 === 0) { balByTime[yi * N + k] = bal; yi++; }
      }
      endBal[k] = bal;
      if (bal > 0) survived++;
    }

    var sortedEnd = Float64Array.from(endBal).sort();
    var timeAxis = new Array(cols);
    for (var t = 0; t < cols; t++) timeAxis[t] = t;

    return {
      type: 'result',
      fire: true,
      meta: { numSimulations: N, years: Y, seedUsed: seedVal },
      timeAxis: timeAxis,
      pathsForPlot: { portfolio: extractPaths(balByTime, cols, N, drawCount) },
      bands: { portfolio: computeBands(balByTime, cols, N) },
      endings: { endingBalance: endBal },
      histogram: { endingBalance: buildBalanceHistogram(endBal) },
      summary: {
        probabilityOfSuccess: survived / N,
        medianEndingBalance: percentile(sortedEnd, 0.5),
        withdrawalRate: S > 0 ? +inp.annualSpending / S : NaN,
        percentiles: { endingBalance: pct(sortedEnd) },
      },
    };
  }

  // Reverse FIRE: find the nest egg (FI number) that sustains the spending at
  // targetP survival. Survival is monotonic in the nest egg, so bisect.
  function solveForFireNumber(inp, targetP, onProgress) {
    var seed =
      inp.seed === null || inp.seed === undefined || inp.seed === ''
        ? 'hifisim-fire'
        : inp.seed;
    var base = Object.assign({}, inp, { seed: seed });
    var pAt = function (s) {
      return decumulationSurvivalOnly(Object.assign({}, base, { startingValue: s }));
    };
    var CAP = 100000000;
    var maxIter = 80;
    var iter = 0;
    var tick = function () {
      iter++;
      if (onProgress) onProgress(Math.min(iter, maxIter), maxIter);
    };
    var finalize = function (s, reachable) {
      var result = runDecumulation(Object.assign({}, base, { startingValue: s }));
      result.solve = {
        reachable: reachable,
        value: s,
        solveFor: 'nestEgg',
        achievedP: result.summary.probabilityOfSuccess,
        targetP: targetP,
      };
      return result;
    };

    // Start the bracket near a sane multiple of spending and grow it.
    var hi = Math.max(10000, +inp.annualSpending * 10);
    var pHi = pAt(hi);
    tick();
    while (pHi < targetP && hi < CAP) {
      hi = Math.min(hi * 2, CAP);
      pHi = pAt(hi);
      tick();
    }
    if (pHi < targetP) return finalize(CAP, false);
    var lo = 0;
    while (hi - lo > 1 && iter < maxIter) {
      var mid = (lo + hi) / 2;
      if (pAt(mid) >= targetP) hi = mid;
      else lo = mid;
      tick();
    }
    return finalize(Math.ceil(hi), true);
  }

  root.MonteSim = {
    mulberry32,
    hashSeed,
    makeNormal,
    percentile,
    runSimulation,
    solveForContribution,
    solveForStartingValue,
    runBiPhase,
    computeBiPhaseSwitch,
    solveBiPhase,
    runDecumulation,
    solveForFireNumber,
  };
})(typeof self !== 'undefined' ? self : this);
