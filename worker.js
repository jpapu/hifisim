/*
 * worker.js — Background thread shell.
 *
 * Classic worker (not a module worker) so it loads even from file://.
 * It just pumps messages; all the math lives in sim.js.
 */
/* global importScripts, MonteSim */
importScripts('./sim.js');

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg) return;

  const progress = function (completed, total) {
    self.postMessage({ type: 'progress', completed: completed, total: total });
  };

  try {
    let result;
    if (msg.type === 'run') {
      result = MonteSim.runSimulation(msg.inputs, progress);
    } else if (msg.type === 'solve') {
      // Reverse mode: result carries a `solve` field with the answer.
      result = MonteSim.solveForContribution(msg.inputs, msg.targetP, progress);
    } else if (msg.type === 'solveCoast') {
      // Reverse coast: solve for the required starting lump sum.
      result = MonteSim.solveForStartingValue(msg.inputs, msg.targetP, progress);
    } else if (msg.type === 'solveBiPhase') {
      // Bi-phase: result carries `solve` (the monthly amount) + `biphase`.
      result = MonteSim.solveBiPhase(msg.inputs, msg.targetP, progress);
    } else if (msg.type === 'runFire') {
      result = MonteSim.runDecumulation(msg.inputs);
    } else if (msg.type === 'solveFire') {
      // Reverse FIRE: result carries `solve` (the FI number / nest egg).
      result = MonteSim.solveForFireNumber(msg.inputs, msg.targetP, progress);
    } else {
      return;
    }

    // Move the large ending arrays zero-copy (works for any result shape —
    // college uses fundingRatio/endingPortfolio/endingCost, FIRE uses endingBalance).
    const transfer = [];
    if (result.endings) {
      Object.keys(result.endings).forEach(function (key) {
        var arr = result.endings[key];
        if (arr && arr.buffer) transfer.push(arr.buffer);
      });
    }
    self.postMessage(result, transfer);
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: String((err && err.message) || err),
    });
  }
};
