/*
 * app.js — Main-thread controller.
 * Reads & validates the form, converts UI percents to decimals, runs the
 * simulation in a Web Worker, drives the progress bar, and hands the result
 * to MonteCharts.render().
 */
(function () {
  'use strict';

  var form = document.getElementById('sim-form');
  var runBtn = document.getElementById('run-btn');
  var errEl = document.getElementById('form-error');
  var progressWrap = document.getElementById('progress-wrap');
  var progressFill = document.getElementById('progress-fill');
  var progressLabel = document.getElementById('progress-label');
  var results = document.getElementById('results');
  var successEl = document.getElementById('stat-success');
  var labelEl = document.getElementById('headline-label');
  var phasePlanEl = document.getElementById('phase-plan');

  var GREEN = '#2dd4a7';
  var AMBER = '#f5c451';
  var RED = '#ff7a59';

  var worker = null;
  // Mode = solve direction. College has three; Bi-Phase is its own mode.
  var currentMode = 'forward'; // forward | reverse | reverseCoast | biphase | fireForward | fireReverse
  var lastCollegeMode = 'forward'; // remembered per primary tab
  var lastFireMode = 'fireForward';

  function num(name) {
    return parseFloat(form.elements[name].value);
  }
  function int(name) {
    return parseInt(form.elements[name].value, 10);
  }
  // Treats a blank field as 0 (e.g. "coast" = no monthly contribution).
  function numOr0(name) {
    var v = parseFloat(form.elements[name].value);
    return isFinite(v) ? v : 0;
  }

  function mode(name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : 'randomized';
  }

  function readInputs() {
    var portfolioFixed = mode('portfolioMode') === 'fixed';
    var costFixed = mode('costMode') === 'fixed';
    return {
      startingValue: num('startingValue'),
      years: int('years'),
      monthlyContribution: numOr0('monthlyContribution'),
      annualCollegeCost: num('annualCollegeCost'),
      yearsOfCollege: int('yearsOfCollege'),
      meanAnnualReturn: num('meanAnnualReturn') / 100,
      // Fixed mode zeroes the volatility -> deterministic single path.
      returnVolatility: portfolioFixed ? 0 : num('returnVolatility') / 100,
      meanInflation: num('meanInflation') / 100,
      inflationVolatility: costFixed ? 0 : num('inflationVolatility') / 100,
      numSimulations: int('numSimulations'),
      seed: form.elements['seed'].value.trim(),
      drawCount: 300,
    };
  }

  function validate(i) {
    var errs = [];
    if (!(i.startingValue >= 0)) errs.push('Starting value must be ≥ 0.');
    if (!(i.years >= 1 && i.years <= 60)) errs.push('Years must be between 1 and 60.');
    if (!(i.monthlyContribution >= 0)) errs.push('Monthly contribution must be ≥ 0.');
    if (!(i.annualCollegeCost >= 0)) errs.push('Annual cost must be ≥ 0.');
    if (!(i.yearsOfCollege >= 1)) errs.push('Years of college must be ≥ 1.');
    if (!(i.returnVolatility >= 0)) errs.push('Return volatility must be ≥ 0.');
    if (!(i.inflationVolatility >= 0)) errs.push('Inflation volatility must be ≥ 0.');
    if (!(i.numSimulations >= 100 && i.numSimulations <= 50000))
      errs.push('Number of simulations must be 100–50,000.');
    if (
      [i.meanAnnualReturn, i.meanInflation].some(function (x) {
        return !isFinite(x);
      })
    )
      errs.push('Please check the numeric fields.');
    return errs;
  }

  function setProgress(c, t) {
    var pct = t ? Math.round((100 * c) / t) : 0;
    progressFill.style.width = pct + '%';
    progressLabel.textContent = pct + '%';
  }

  function resetButton() {
    runBtn.disabled = false;
    runBtn.textContent =
      currentMode === 'fireForward' ? 'Run FIRE simulation'
      : currentMode === 'fireReverse' ? 'Find my FI number'
      : currentMode === 'biphase' ? 'Build my two-phase plan'
      : currentMode === 'reverseCoast' ? 'Find required lump sum'
      : currentMode === 'reverse' ? 'Find required contribution'
      : 'Run Simulation';
  }

  function phaseCard(ph, pv, pd, cls, full) {
    return '<div class="phase-card ' + cls + '"' + (full ? ' style="grid-column:1/-1"' : '') +
      '><div class="ph">' + ph + '</div><div class="pv">' + pv + '</div><div class="pd">' + pd + '</div></div>';
  }
  function fmtDur(yrs) {
    var y = Math.floor(yrs);
    var mo = Math.round((yrs - y) * 12);
    if (mo === 12) { y++; mo = 0; }
    return (y > 0 ? y + ' yr ' : '') + (mo > 0 || y === 0 ? mo + ' mo' : '');
  }
  // Bi-phase: show the two-stage savings plan beneath the headline.
  function renderPhasePlan(result) {
    if (!(result.biphase && result.solve && result.solve.reachable)) {
      phasePlanEl.hidden = true;
      return;
    }
    var bp = result.biphase;
    var dollars = '$' + Math.round(result.solve.contribution).toLocaleString() + '/mo';
    var p1 = bp.phase1Years;
    var p2 = bp.totalYears - p1;
    var html;
    if (p2 < 0.1) {
      html = phaseCard('Single phase · 529', dollars + ' for the full ' + bp.totalYears + ' yr',
        'The 529 covers this goal on its own — no taxable brokerage phase needed.', 'p1', true);
    } else if (p1 < 0.1) {
      html = phaseCard('Phase 2 · taxable brokerage', dollars + ' for ' + fmtDur(p2),
        'Your starting value already has in-state covered — contribute to the brokerage from day one.', 'p2', true);
    } else {
      html =
        phaseCard('Phase 1 · 529 (tax-free)', dollars + ' for ' + fmtDur(p1),
          'Fund the 529 until it\'s on track to cover in-state (≈ year ' + p1.toFixed(1) + '), then stop.', 'p1', false) +
        phaseCard('Phase 2 · taxable brokerage', dollars + ' for ' + fmtDur(p2),
          'From year ' + p1.toFixed(1) + ', redirect the same amount to a brokerage for the gap up to your goal.', 'p2', false);
    }
    phasePlanEl.innerHTML = html;
    phasePlanEl.hidden = false;
  }

  // Forward: charts.js already set the P% headline. Reverse: override it to
  // show the required monthly contribution (or "out of reach").
  function applyHeadline(result) {
    if (!result.solve) {
      labelEl.textContent = currentMode === 'fireForward'
        ? 'probability your portfolio reaches your FI number'
        : 'probability of fully funding college';
      return;
    }
    var s = result.solve;
    var isLump = s.solveFor === 'startingValue' || s.solveFor === 'nestEgg';
    // Tolerate an older worker payload that only set `contribution` (no `value`).
    var raw = s.value != null ? s.value : s.contribution;
    var val = '$' + Math.round(raw).toLocaleString();
    var pct = (s.achievedP * 100).toFixed(1);
    var tgt = Math.round(s.targetP * 100);
    if (s.reachable) {
      successEl.style.color = GREEN;
      if (s.solveFor === 'nestEgg') {
        successEl.textContent = val;
        labelEl.textContent = 'nest egg (FI number) for a ~' + tgt + '% chance it lasts — achieves ' + pct + '%';
      } else if (isLump) {
        successEl.textContent = val;
        labelEl.textContent = 'lump sum needed today (coasting, $0/mo) to reach ~' + tgt + '% — achieves ' + pct + '%';
      } else {
        successEl.textContent = val + '/mo';
        labelEl.textContent = 'to reach ~' + tgt + '% — this plan achieves ' + pct + '%';
      }
    } else {
      successEl.style.color = RED;
      successEl.textContent = 'Out of reach';
      labelEl.textContent =
        (isLump ? 'even with ' + val : 'even at ' + val + '/mo') +
        ' you only reach ' + pct + '% — try a longer horizon, higher return, or lower goal';
    }
  }

  function cleanupWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  function onMessage(e) {
    var msg = e.data;
    if (!msg) return;
    if (msg.type === 'progress') {
      setProgress(msg.completed, msg.total);
    } else if (msg.type === 'result') {
      setProgress(1, 1);
      progressWrap.hidden = true;
      results.hidden = false; // unhide BEFORE rendering so canvases have size
      msg.labels = labelsFor(currentMode); // goal wording (college cost vs FI number)
      MonteCharts.render(msg);
      applyHeadline(msg);
      renderPhasePlan(msg);
      resetButton();
      cleanupWorker();
    } else if (msg.type === 'error') {
      fail(msg.message);
    }
  }

  function fail(message) {
    errEl.textContent = 'Simulation failed: ' + message;
    progressWrap.hidden = true;
    resetButton();
    cleanupWorker();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.textContent = '';

    var isFire = currentMode === 'fireForward' || currentMode === 'fireReverse';

    var inputs = readInputs();
    // FIRE accumulation: the goal is the FI number (annual spend ÷ safe
    // withdrawal rate), inflated to the retirement date. Remap the retirement
    // fields onto the shared accumulation engine before validating/running.
    if (isFire) {
      var swr = num('withdrawalRate') / 100;
      if (!(swr > 0 && swr < 1)) {
        errEl.textContent = 'Safe withdrawal rate must be between 0 and 100%.';
        return;
      }
      inputs.annualCollegeCost = num('annualSpending') / swr; // today's FI number
      inputs.yearsOfCollege = 1;
      inputs.years = int('accumYears');
      inputs.meanInflation = num('fireInflation') / 100;
      inputs.inflationVolatility = num('fireInflationVol') / 100;
    }

    var errs = validate(inputs);
    if (errs.length) {
      errEl.textContent = errs[0];
      return;
    }

    var targetP = null;
    var solves = currentMode !== 'forward' && currentMode !== 'fireForward';
    if (solves) {
      targetP = num('targetProbability') / 100;
      if (!(targetP > 0 && targetP < 1)) {
        errEl.textContent = 'Target probability must be between 1% and 99%.';
        return;
      }
    }
    if (currentMode === 'biphase') {
      // The College-type dropdown is the Phase-2 endpoint; add the in-state
      // floor (public in-state avg, 2024-25) and the brokerage tax rate. The
      // floor respects the Tuition-only / +Room&board toggle to match the endpoint.
      var inState = COST_PRESETS.in_state;
      inputs.inStateAnnual = inState.tuition + (mode('costScope') === 'tuition' ? 0 : inState.roomBoard);
      inputs.inStateInflation = 0.04;
      inputs.ltcgRate = (num('ltcgRate') || 0) / 100;
    }

    runBtn.disabled = true;
    runBtn.textContent = solves ? 'Solving…' : 'Running…';
    results.hidden = true;
    progressWrap.hidden = false;
    setProgress(0, 1);

    cleanupWorker();
    try {
      worker = new Worker('worker.js');
    } catch (err) {
      fail('could not start the worker (' + err.message + ')');
      return;
    }
    worker.onmessage = onMessage;
    worker.onerror = function (ev) {
      fail((ev && ev.message) || 'worker error — if opened via file://, serve over http instead');
    };
    if (currentMode === 'biphase') {
      worker.postMessage({ type: 'solveBiPhase', inputs: inputs, targetP: targetP });
    } else if (currentMode === 'reverseCoast') {
      worker.postMessage({ type: 'solveCoast', inputs: inputs, targetP: targetP });
    } else if (currentMode === 'reverse' || currentMode === 'fireReverse') {
      // FIRE reverse solves the monthly contribution to reach the FI number.
      worker.postMessage({ type: 'solve', inputs: inputs, targetP: targetP });
    } else {
      // forward + fireForward: project the portfolio vs. the goal.
      worker.postMessage({ type: 'run', inputs: inputs });
    }
  });

  // ---- Two-level nav: primary scenario + sub-tab solve direction -----
  var primaryTabs = document.querySelectorAll('[data-primary]');
  var subTabs = document.querySelectorAll('[data-mode]');
  var subNav = document.getElementById('sub-tabs');

  function setSectionLabels(isFire) {
    var goalPaths = isFire ? 'FI-number paths' : 'college-cost paths';
    document.getElementById('sim-note').innerHTML =
      '<span class="swatch swatch-portfolio"></span> portfolio paths &nbsp; ' +
      '<span class="swatch swatch-cost"></span> ' + goalPaths + ' &nbsp; ' +
      '(solid lines = 10th / 50th / 90th percentiles)';
    document.getElementById('dist-h2').textContent = 'Distribution of outcomes';
    document.getElementById('dist-note').innerHTML = isFire
      ? 'Funding ratio = ending portfolio ÷ FI number. The line at <strong>1.0</strong> means you can cover your spending at the chosen withdrawal rate; anything to the left falls short.'
      : 'Funding ratio = ending portfolio ÷ projected college cost. The line at <strong>1.0</strong> is fully funded; anything to the left is a shortfall.';
    document.getElementById('overlay-h2').textContent = isFire
      ? 'Ending portfolio vs. FI number'
      : 'Ending portfolio vs. projected cost';
    document.getElementById('overlay-note').innerHTML =
      'Both ending amounts on one dollar axis. Green mass to the <strong>left</strong> of the orange ' +
      (isFire ? 'falls short of your FI number' : 'is a shortfall') +
      '; to the <strong>right</strong> is a surplus. Dashed lines mark each median, plus the portfolio’s ' +
      '10th / 90th percentiles; heights are scaled to each curve’s own peak.';
  }

  var MODE_BRIEFS = {
    forward: '<strong>College · Forward.</strong> Enter a monthly contribution and see the probability it funds college — plus the full spread of outcomes.',
    reverse: '<strong>College · Reverse.</strong> Pick a target probability and get the monthly contribution required to fund college.',
    reverseCoast: "<strong>College · Reverse Coast.</strong> Adding nothing more, find the lump sum you'd need invested today to coast to your college goal.",
    biphase: '<strong>Bi-Phase College.</strong> Fund a tax-free 529 until it covers in-state, then a taxable brokerage for the gap up to a pricier school — solves the monthly amount and when to switch.',
    fireForward: '<strong>FIRE · Forward.</strong> Project your portfolio’s growth and see the chance it reaches your FI number (annual spend ÷ safe withdrawal rate, inflated) — enough to cover expenses.',
    fireReverse: '<strong>FIRE · Reverse.</strong> Find the monthly contribution needed to hit your FI number by your target year, at a chosen probability.',
  };

  // Goal wording per scenario; charts.js reads result.labels (college defaults).
  var LABELS = {
    college: { goalSeries: 'Projected college cost', goalAxis: 'cost', goalCard: 'projected cost', funded: 'fully funded' },
    fire: { goalSeries: 'FI number', goalAxis: 'FI number', goalCard: 'FI number', funded: 'enough to retire' },
  };
  function labelsFor(mode) {
    return mode === 'fireForward' || mode === 'fireReverse' ? LABELS.fire : LABELS.college;
  }

  function applyMode(mode) {
    currentMode = mode;
    var isFire = mode === 'fireForward' || mode === 'fireReverse';
    var isSolve = mode === 'reverse' || mode === 'reverseCoast' || mode === 'biphase' || mode === 'fireReverse';

    Array.prototype.forEach.call(subTabs, function (t) {
      t.classList.toggle('active', t.getAttribute('data-mode') === mode);
    });

    // Form fields per mode. Contribution shows for the forward (projection)
    // modes; target shows for the solve modes.
    document.getElementById('contribution-field').hidden = !(mode === 'forward' || mode === 'fireForward');
    document.getElementById('target-prob-field').hidden = !isSolve;
    document.getElementById('ltcg-field').hidden = mode !== 'biphase';
    // Starting value is the solved unknown only for reverse-coast.
    document.getElementById('starting-field').hidden = mode === 'reverseCoast';
    // Scenario sections.
    document.getElementById('cost-section').hidden = isFire;
    document.getElementById('fire-section').hidden = !isFire;
    document.getElementById('years-field').hidden = isFire;
    document.getElementById('overlay-section').hidden = false;

    document.getElementById('target-help').textContent =
      mode === 'reverseCoast' ? "We'll find the starting lump sum that reaches this."
      : "We'll find the monthly contribution that reaches this.";

    setSectionLabels(isFire);
    document.getElementById('mode-brief').innerHTML = MODE_BRIEFS[mode] || '';

    // Keep the last run's results/graphs visible when switching tabs.
    progressWrap.hidden = true;
    errEl.textContent = '';
    resetButton();
  }

  function setPrimary(primary) {
    Array.prototype.forEach.call(primaryTabs, function (t) {
      t.classList.toggle('active', t.getAttribute('data-primary') === primary);
    });
    // Show only this scenario's sub-tabs.
    Array.prototype.forEach.call(subTabs, function (t) {
      t.hidden = t.getAttribute('data-for') !== primary;
    });
    if (primary === 'biphase') {
      subNav.hidden = true;
      applyMode('biphase');
    } else if (primary === 'fire') {
      subNav.hidden = false;
      applyMode(lastFireMode);
    } else {
      subNav.hidden = false;
      applyMode(lastCollegeMode);
    }
  }

  Array.prototype.forEach.call(primaryTabs, function (t) {
    t.addEventListener('click', function () { setPrimary(t.getAttribute('data-primary')); });
  });
  Array.prototype.forEach.call(subTabs, function (t) {
    t.addEventListener('click', function () {
      var m = t.getAttribute('data-mode');
      if (m === 'fireForward' || m === 'fireReverse') lastFireMode = m;
      else lastCollegeMode = m;
      applyMode(m);
    });
  });

  // ---- College-cost presets ------------------------------------------
  // Tuition+fees and room+board stored separately (2024-25, today's dollars) so
  // the "Includes" toggle can switch the annual cost between the two. See the
  // assumptions modal for sources. Inflation/volatility differ by sector: public
  // tuition is lower-growth but lumpier; private/elite climb faster but steadier.
  var COST_PRESETS = {
    in_state: { tuition: 11610, roomBoard: 12917, yearsOfCollege: 4, meanInflation: 4.0, inflationVolatility: 2.5, label: 'public in-state' },
    out_state: { tuition: 30780, roomBoard: 12917, yearsOfCollege: 4, meanInflation: 4.5, inflationVolatility: 2.0, label: 'public out-of-state' },
    private: { tuition: 43350, roomBoard: 13842, yearsOfCollege: 4, meanInflation: 4.5, inflationVolatility: 1.5, label: 'private nonprofit' },
    prestigious: { tuition: 67433, roomBoard: 22567, yearsOfCollege: 4, meanInflation: 5.0, inflationVolatility: 1.5, label: 'top ~12 universities (Ivy+)' },
  };

  var presetSel = document.getElementById('college-preset');
  var presetDesc = document.getElementById('preset-desc');
  var presetLocked = ['annualCollegeCost', 'yearsOfCollege', 'meanInflation'];

  function applyPreset() {
    var key = presetSel.value;
    var custom = key === 'custom';
    if (!custom) {
      var p = COST_PRESETS[key];
      var tuitionOnly = mode('costScope') === 'tuition';
      var annual = p.tuition + (tuitionOnly ? 0 : p.roomBoard);
      form.elements['annualCollegeCost'].value = annual;
      form.elements['yearsOfCollege'].value = p.yearsOfCollege;
      form.elements['meanInflation'].value = p.meanInflation;
      form.elements['inflationVolatility'].value = p.inflationVolatility;
      presetDesc.textContent =
        (tuitionOnly ? 'Avg tuition & fees, ' : 'Avg total cost of attendance, ') +
        p.label + ' (2024-25).';
    } else {
      presetDesc.textContent = 'Enter your own figures.';
    }
    presetLocked.forEach(function (n) {
      form.elements[n].disabled = !custom;
    });
    // The Includes toggle only affects presets, not custom entry.
    Array.prototype.forEach.call(form.querySelectorAll('input[name="costScope"]'), function (r) {
      r.disabled = custom;
    });
    updateModes();
  }

  // ---- Fixed / randomized mode wiring ---------------------------------
  function updateModes() {
    var pFixed = mode('portfolioMode') === 'fixed';
    var cFixed = mode('costMode') === 'fixed';
    var custom = presetSel.value === 'custom';

    form.elements['returnVolatility'].disabled = pFixed;
    document.getElementById('returnVolWrap').classList.toggle('fixed-mode', pFixed);

    // Inflation vol is editable only when custom AND randomized.
    form.elements['inflationVolatility'].disabled = cFixed || !custom;
    document.getElementById('inflationVolWrap').classList.toggle('fixed-mode', cFixed);
  }

  presetSel.addEventListener('change', applyPreset);
  Array.prototype.forEach.call(form.querySelectorAll('input[name="costScope"]'), function (r) {
    r.addEventListener('change', applyPreset);
  });
  Array.prototype.forEach.call(
    form.querySelectorAll('input[name="portfolioMode"], input[name="costMode"]'),
    function (r) {
      r.addEventListener('change', updateModes);
    }
  );

  // ---- Info modals (cost assumptions + return assumptions) -----------
  function wireModal(modalEl, triggerIds, closeBtnId) {
    if (!modalEl) return null;
    function close() { modalEl.hidden = true; }
    triggerIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', function () { modalEl.hidden = false; });
    });
    var cb = document.getElementById(closeBtnId);
    if (cb) cb.addEventListener('click', close);
    modalEl.addEventListener('click', function (e) { if (e.target === modalEl) close(); });
    return modalEl;
  }
  var infoModals = [
    wireModal(document.getElementById('cost-modal'), ['cost-info-btn', 'cost-info-link'], 'cost-modal-close'),
    wireModal(document.getElementById('return-modal'), ['return-info-btn'], 'return-modal-close'),
  ].filter(Boolean);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') infoModals.forEach(function (m) { m.hidden = true; });
  });

  // The mouse wheel silently increments a *focused* number input (a browser
  // default), so scrolling the page past a field you just typed in changes its
  // value. Block that: on wheel over a focused number field, stop the change and
  // blur it so the rest of the scroll behaves normally.
  Array.prototype.forEach.call(form.querySelectorAll('input[type="number"]'), function (el) {
    el.addEventListener(
      'wheel',
      function (e) {
        if (document.activeElement === el) {
          e.preventDefault();
          el.blur();
        }
      },
      { passive: false }
    );
  });

  // Initialize on load.
  applyPreset();
  setPrimary('college'); // sets sub-tab visibility + default mode
})();
