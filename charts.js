/*
 * charts.js — Rendering. Exposes MonteCharts.render(result).
 *   1. Spaghetti chart  — hand-drawn on a raw <canvas> (fast for many lines).
 *   2. Funding-ratio histogram — Chart.js bar chart with a "fully funded" line.
 *   3. Summary stats — headline + cards.
 */
(function (root) {
  'use strict';

  var COLOR = {
    portfolio: '#2dd4a7',
    cost: '#ff7a59',
    portfolioCloud: 'rgba(45,212,167,0.07)',
    costCloud: 'rgba(255,122,89,0.09)',
    grid: 'rgba(255,255,255,0.07)',
    muted: '#8b98a8',
    text: '#e6edf3',
  };

  // ---- Formatting ------------------------------------------------------

  var moneyFmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
  function fmtMoney(v) {
    return moneyFmt.format(v);
  }
  function fmtMoneyShort(v) {
    var a = Math.abs(v);
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
    return '$' + Math.round(v);
  }

  // ---- Spaghetti chart (raw canvas) -----------------------------------

  function setupCanvas(canvas) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cssW = canvas.clientWidth || 600;
    var cssH = canvas.clientHeight || 360;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  function drawSpaghetti(canvas, result) {
    var s = setupCanvas(canvas);
    var ctx = s.ctx,
      w = s.w,
      h = s.h;
    ctx.clearRect(0, 0, w, h);

    var years = result.meta.years;
    var cols = years + 1;
    var bp = result.bands.portfolio;
    var bc = result.bands.cost; // absent for FIRE (no cost series)

    var yMax = 0;
    for (var t = 0; t < cols; t++) {
      if (bp.p90[t] > yMax) yMax = bp.p90[t];
      if (bc && bc.p90[t] > yMax) yMax = bc.p90[t];
    }
    yMax = yMax > 0 ? yMax * 1.1 : 1;

    var mL = 64,
      mR = 14,
      mT = 12,
      mB = 28;
    var plotW = w - mL - mR;
    var plotH = h - mT - mB;
    function xOf(ti) {
      return mL + (years === 0 ? 0 : (ti / years) * plotW);
    }
    function yOf(v) {
      return mT + plotH - (v / yMax) * plotH;
    }

    // Axes + gridlines.
    ctx.font = '11px sans-serif';
    ctx.fillStyle = COLOR.muted;
    ctx.strokeStyle = COLOR.grid;
    ctx.lineWidth = 1;
    var ySteps = 5;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var i = 0; i <= ySteps; i++) {
      var v = (yMax * i) / ySteps;
      var y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(mL, y);
      ctx.lineTo(w - mR, y);
      ctx.stroke();
      ctx.fillText(fmtMoneyShort(v), mL - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var xStep = years <= 10 ? 1 : years <= 20 ? 2 : 5;
    for (var ti = 0; ti <= years; ti += xStep) {
      ctx.fillText('Yr ' + ti, xOf(ti), h - mB + 6);
    }

    // Sample paths (translucent clouds).
    if (result.pathsForPlot.cost) {
      drawPaths(ctx, result.pathsForPlot.cost, xOf, yOf, COLOR.costCloud);
    }
    drawPaths(ctx, result.pathsForPlot.portfolio, xOf, yOf, COLOR.portfolioCloud);

    // Percentile bands on top (median solid, p10/p90 dashed).
    if (bc) {
      drawLine(ctx, bc.p10, xOf, yOf, COLOR.cost, 1.2, [4, 4]);
      drawLine(ctx, bc.p90, xOf, yOf, COLOR.cost, 1.2, [4, 4]);
      drawLine(ctx, bc.p50, xOf, yOf, COLOR.cost, 2.5, null);
    }
    drawLine(ctx, bp.p10, xOf, yOf, COLOR.portfolio, 1.2, [4, 4]);
    drawLine(ctx, bp.p90, xOf, yOf, COLOR.portfolio, 1.2, [4, 4]);
    drawLine(ctx, bp.p50, xOf, yOf, COLOR.portfolio, 2.5, null);

    // Bi-phase: mark the 529 → brokerage switch point.
    if (result.biphase && result.biphase.phase1Years > 0) {
      var sx = xOf(result.biphase.phase1Years);
      ctx.strokeStyle = COLOR.text;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(sx, mT);
      ctx.lineTo(sx, mT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLOR.text;
      ctx.font = '10px sans-serif';
      ctx.textAlign = sx > w - 90 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('529 → brokerage', ctx.textAlign === 'right' ? sx - 4 : sx + 4, mT + 2);
    }
  }

  function drawPaths(ctx, paths, xOf, yOf, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var p = 0; p < paths.length; p++) {
      var path = paths[p];
      ctx.moveTo(xOf(0), yOf(path[0]));
      for (var t = 1; t < path.length; t++) ctx.lineTo(xOf(t), yOf(path[t]));
    }
    ctx.stroke();
  }

  function drawLine(ctx, arr, xOf, yOf, color, width, dash) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(arr[0]));
    for (var t = 1; t < arr.length; t++) ctx.lineTo(xOf(t), yOf(arr[t]));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- Histogram (Chart.js) -------------------------------------------

  var histChart = null;
  var overlayChart = null;

  function drawHistogram(canvasEl, result) {
    var hist = result.histogram.fundingRatio;
    var lab = result.labels || { goalAxis: 'cost', funded: 'fully funded' };
    var edges = hist.binEdges;
    var counts = hist.counts;
    var bw = edges[1] - edges[0];
    var labels = [];
    var colors = [];
    for (var i = 0; i < counts.length; i++) {
      var center = edges[i] + bw / 2;
      labels.push(center.toFixed(2));
      colors.push(center >= 1 ? 'rgba(45,212,167,0.85)' : 'rgba(255,122,89,0.85)');
    }

    if (histChart) histChart.destroy();
    histChart = new Chart(canvasEl.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            data: counts,
            backgroundColor: colors,
            borderWidth: 0,
            categoryPercentage: 1.0,
            barPercentage: 1.0,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) {
                return 'ratio ≈ ' + items[0].label;
              },
              label: function (it) {
                return it.raw.toLocaleString() + ' sims';
              },
            },
          },
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'funding ratio (portfolio ÷ ' + lab.goalAxis + ')',
              color: COLOR.muted,
            },
            ticks: { color: COLOR.muted, maxTicksLimit: 10, autoSkip: true },
            grid: { display: false },
          },
          y: {
            title: { display: true, text: '# of simulations', color: COLOR.muted },
            ticks: { color: COLOR.muted },
            grid: { color: 'rgba(255,255,255,0.06)' },
          },
        },
      },
      plugins: [fundedLinePlugin(hist, lab.funded)],
    });
  }

  // Draws a dashed vertical line at funding ratio = 1.0.
  function fundedLinePlugin(hist, fundedText) {
    var edges = hist.binEdges;
    var bw = edges[1] - edges[0];
    var nbins = hist.counts.length;
    var marker = (fundedText || 'fully funded') + ' (1.0)';
    return {
      id: 'fundedLine',
      afterDatasetsDraw: function (chart) {
        var x = chart.scales.x;
        var area = chart.chartArea;
        var fidx = (1.0 - (edges[0] + bw / 2)) / bw; // fractional category index
        if (fidx < 0) fidx = 0;
        if (fidx > nbins - 1) fidx = nbins - 1;
        var i0 = Math.floor(fidx);
        var i1 = Math.ceil(fidx);
        var p0 = x.getPixelForValue(i0);
        var p1 = x.getPixelForValue(i1);
        var px = p0 + (p1 - p0) * (fidx - i0);
        var ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = COLOR.text;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(px, area.top);
        ctx.lineTo(px, area.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLOR.text;
        ctx.font = '11px sans-serif';
        ctx.textAlign = px < area.left + 110 ? 'left' : 'right';
        ctx.fillText(marker, ctx.textAlign === 'left' ? px + 5 : px - 5, area.top + 11);
        ctx.restore();
      },
    };
  }

  // ---- Ending portfolio vs. cost overlay (dollar axis) ----------------

  function pctOf(sorted, p) {
    var n = sorted.length;
    if (!n) return NaN;
    if (n === 1) return sorted[0];
    var idx = p * (n - 1);
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
  }

  // Bin into a peak-normalized density curve (height scaled so its max is 1).
  function buildDensity(values, lo, hi, nbins) {
    var counts = new Array(nbins).fill(0);
    var bw = (hi - lo) / nbins;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (!isFinite(v) || v < lo || v >= hi) continue;
      var idx = Math.floor((v - lo) / bw);
      if (idx >= nbins) idx = nbins - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    }
    // Light 3-point moving average to tame sampling jaggedness (keeps the
    // tight cost peak intact while smoothing the broad portfolio curve).
    var sm = counts.slice();
    for (var s = 1; s < nbins - 1; s++) {
      sm[s] = (counts[s - 1] + counts[s] + counts[s + 1]) / 3;
    }
    var max = 0;
    for (var j = 0; j < nbins; j++) if (sm[j] > max) max = sm[j];
    var pts = [];
    for (var k = 0; k < nbins; k++) {
      pts.push({ x: lo + (k + 0.5) * bw, y: max ? sm[k] / max : 0 });
    }
    return pts;
  }

  // Dashed vertical reference lines (medians + cost p10/p90), color-matched.
  function markersPlugin(markers) {
    return {
      id: 'overlayMarkers',
      afterDatasetsDraw: function (chart) {
        var x = chart.scales.x;
        var area = chart.chartArea;
        var ctx = chart.ctx;
        markers.forEach(function (m) {
          if (!isFinite(m.value)) return;
          var px = x.getPixelForValue(m.value);
          if (px < area.left || px > area.right) return;
          ctx.save();
          ctx.globalAlpha = m.alpha == null ? 1 : m.alpha;
          ctx.strokeStyle = m.color;
          ctx.lineWidth = m.width || 1.5;
          ctx.setLineDash(m.dash || [3, 3]);
          ctx.beginPath();
          ctx.moveTo(px, area.top);
          ctx.lineTo(px, area.bottom);
          ctx.stroke();
          if (m.label) {
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
            ctx.fillStyle = m.color;
            ctx.font = '10px sans-serif';
            ctx.textBaseline = 'bottom';
            ctx.textAlign = m.labelAlign || 'left';
            ctx.fillText(m.label, m.labelAlign === 'right' ? px - 3 : px + 3, area.bottom - 3);
          }
          ctx.restore();
        });
      },
    };
  }

  function drawValueOverlay(canvasEl, result) {
    var ep = result.endings && result.endings.endingPortfolio;
    var ec = result.endings && result.endings.endingCost;
    if (!ep || !ec) return;

    var epS = Float64Array.from(ep).sort();
    var ecS = Float64Array.from(ec).sort();
    var lo = 0;
    // Portfolio is the wider, right-skewed one; show it to ~p97 (its far tail is
    // in the summary). Make sure the cost cluster is fully on screen too.
    var hi = Math.max(pctOf(epS, 0.97), pctOf(ecS, 0.99) * 1.05);
    if (!(hi > 0)) hi = 1;
    var nbins = 60;

    if (overlayChart) overlayChart.destroy();
    overlayChart = new Chart(canvasEl.getContext('2d'), {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Ending portfolio',
            data: buildDensity(ep, lo, hi, nbins),
            borderColor: COLOR.portfolio,
            backgroundColor: 'rgba(45,212,167,0.18)',
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: (result.labels && result.labels.goalSeries) || 'Projected college cost',
            data: buildDensity(ec, lo, hi, nbins),
            borderColor: COLOR.cost,
            backgroundColor: 'rgba(255,122,89,0.20)',
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: COLOR.text, boxWidth: 12, font: { size: 12 } },
          },
          tooltip: {
            callbacks: {
              title: function (items) { return fmtMoney(items[0].parsed.x); },
              label: function (it) { return it.dataset.label; },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: lo,
            max: hi,
            title: { display: true, text: 'ending value ($)', color: COLOR.muted },
            ticks: {
              color: COLOR.muted,
              maxTicksLimit: 8,
              callback: function (v) { return fmtMoneyShort(v); },
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: { display: false, min: 0 },
        },
      },
      plugins: [
        markersPlugin([
          { value: pctOf(epS, 0.5), color: COLOR.portfolio, width: 1.5, dash: [3, 3] },
          { value: pctOf(ecS, 0.5), color: COLOR.cost, width: 1.5, dash: [3, 3] },
          { value: pctOf(epS, 0.1), color: COLOR.portfolio, width: 1, dash: [2, 3], alpha: 0.6, label: '10%', labelAlign: 'right' },
          { value: pctOf(epS, 0.9), color: COLOR.portfolio, width: 1, dash: [2, 3], alpha: 0.6, label: '90%', labelAlign: 'left' },
        ]),
      ],
    });
  }

  // ---- Summary stats ---------------------------------------------------

  function renderSummary(result) {
    var sm = result.summary;
    var prob = sm.probabilityOfSuccess;

    var successEl = document.getElementById('stat-success');
    successEl.textContent = (prob * 100).toFixed(1) + '%';
    successEl.style.color =
      prob >= 0.7 ? COLOR.portfolio : prob >= 0.4 ? '#f5c451' : COLOR.cost;

    var lab = result.labels || { goalCard: 'projected cost' };
    var fr = sm.percentiles.fundingRatio;
    var ep = sm.percentiles.endingPortfolio;
    var pc = sm.percentiles.projectedCost;
    var surplusPositive = sm.medianSurplus >= 0;

    var cards = [
      {
        v: sm.medianFundingRatio.toFixed(2) + '×',
        k: 'Median funding ratio',
        sub: 'p10 ' + fr.p10.toFixed(2) + ' – p90 ' + fr.p90.toFixed(2),
      },
      {
        v: fmtMoney(sm.medianEndingPortfolio),
        k: 'Median ending portfolio',
        sub: fmtMoneyShort(ep.p10) + ' – ' + fmtMoneyShort(ep.p90) + ' (p10–p90)',
      },
      {
        v: fmtMoney(sm.medianProjectedCost),
        k: 'Median ' + lab.goalCard,
        sub: fmtMoneyShort(pc.p10) + ' – ' + fmtMoneyShort(pc.p90) + ' (p10–p90)',
      },
      {
        v: (surplusPositive ? '' : '−') + fmtMoney(Math.abs(sm.medianSurplus)),
        k: surplusPositive ? 'Median surplus' : 'Median shortfall',
        sub: surplusPositive ? 'above your goal' : 'gap to your goal',
        color: surplusPositive ? COLOR.portfolio : COLOR.cost,
      },
    ];

    var grid = document.getElementById('stats-grid');
    grid.innerHTML = '';
    cards.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'stat-card';
      var color = c.color ? ' style="color:' + c.color + '"' : '';
      el.innerHTML =
        '<div class="v"' + color + '>' + c.v + '</div>' +
        '<div class="k">' + c.k + '</div>' +
        (c.sub ? '<div class="sub">' + c.sub + '</div>' : '');
      grid.appendChild(el);
    });

    document.getElementById('meta-line').textContent =
      result.meta.numSimulations.toLocaleString() +
      ' simulations · seed ' +
      result.meta.seedUsed +
      ' · ' +
      result.meta.years +
      '-year accumulation';
  }

  // ---- FIRE rendering --------------------------------------------------

  // Ending-balance histogram; the $0 bin (depletion mass) is orange.
  function drawBalanceHistogram(canvasEl, result) {
    var hist = result.histogram.endingBalance;
    var edges = hist.binEdges;
    var counts = hist.counts;
    var bw = edges[1] - edges[0];
    var labels = [];
    var colors = [];
    for (var i = 0; i < counts.length; i++) {
      labels.push(fmtMoneyShort(edges[i] + bw / 2));
      colors.push(i === 0 ? 'rgba(255,122,89,0.85)' : 'rgba(45,212,167,0.85)');
    }
    if (histChart) histChart.destroy();
    histChart = new Chart(canvasEl.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{ data: counts, backgroundColor: colors, borderWidth: 0, categoryPercentage: 1.0, barPercentage: 1.0 }],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return 'ending ≈ ' + items[0].label; },
              label: function (it) { return it.raw.toLocaleString() + ' sims'; },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: "ending balance ($, today's dollars)", color: COLOR.muted },
            ticks: { color: COLOR.muted, maxTicksLimit: 8, autoSkip: true },
            grid: { display: false },
          },
          y: {
            title: { display: true, text: '# of simulations', color: COLOR.muted },
            ticks: { color: COLOR.muted },
            grid: { color: 'rgba(255,255,255,0.06)' },
          },
        },
      },
    });
  }

  function renderFireSummary(result) {
    var sm = result.summary;
    var prob = sm.probabilityOfSuccess;
    var successEl = document.getElementById('stat-success');
    successEl.textContent = (prob * 100).toFixed(1) + '%';
    successEl.style.color = prob >= 0.7 ? COLOR.portfolio : prob >= 0.4 ? '#f5c451' : COLOR.cost;

    var eb = sm.percentiles.endingBalance;
    var cards = [
      { v: fmtMoney(sm.medianEndingBalance), k: 'Median ending balance', sub: "today's dollars, after " + result.meta.years + ' yrs' },
      { v: fmtMoneyShort(eb.p90), k: '90th-percentile ending', sub: 'good-luck outcome' },
      { v: eb.p10 <= 0 ? '$0' : fmtMoneyShort(eb.p10), k: '10th-percentile ending', sub: 'bad-luck outcome', color: eb.p10 <= 0 ? COLOR.cost : undefined },
      { v: (sm.withdrawalRate * 100).toFixed(1) + '%', k: 'Withdrawal rate', sub: 'spending ÷ nest egg' },
    ];
    var grid = document.getElementById('stats-grid');
    grid.innerHTML = '';
    cards.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'stat-card';
      var color = c.color ? ' style="color:' + c.color + '"' : '';
      el.innerHTML =
        '<div class="v"' + color + '>' + c.v + '</div><div class="k">' + c.k + '</div>' +
        (c.sub ? '<div class="sub">' + c.sub + '</div>' : '');
      grid.appendChild(el);
    });

    document.getElementById('meta-line').textContent =
      result.meta.numSimulations.toLocaleString() + ' simulations · seed ' +
      result.meta.seedUsed + ' · ' + result.meta.years + '-year retirement';
  }

  // ---- Public entry ----------------------------------------------------

  var lastResult = null;

  function render(result) {
    lastResult = result;
    drawSpaghetti(document.getElementById('spaghetti'), result);
    if (result.fire) {
      drawBalanceHistogram(document.getElementById('histogram'), result);
      renderFireSummary(result);
    } else {
      drawHistogram(document.getElementById('histogram'), result);
      drawValueOverlay(document.getElementById('value-overlay'), result);
      renderSummary(result);
    }
  }

  // Redraw the hand-drawn spaghetti on resize (Chart.js handles its own).
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (!lastResult) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      drawSpaghetti(document.getElementById('spaghetti'), lastResult);
    }, 150);
  });

  root.MonteCharts = { render: render };
})(window);
