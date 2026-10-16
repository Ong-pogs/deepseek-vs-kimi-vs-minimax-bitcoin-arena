import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hitValue, brier, scoreRows, marketSides, coinFlipBand, bestOfCoinFlips, pairedGap, binomialCdf, median, independentGapNeeded} from '../src/scoring.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test('hit: the lean of the probability, half a hit when there is no lean or no answer', () => {
  assert.equal(hitValue(0.62, 'up'), 1); assert.equal(hitValue(0.62, 'down'), 0);
  assert.equal(hitValue(0.2, 'down'), 1); assert.equal(hitValue(0.5, 'up'), 0.5); assert.equal(hitValue(null, 'down'), 0.5);
});

test('Brier: squared error; no answer is scored as 0.5', () => {
  near(brier(0.7, 'up'), 0.09); near(brier(0.7, 'down'), 0.49); near(brier(null, 'up'), 0.25); near(brier(1, 'up'), 0); near(brier(0, 'up'), 1);
});

test('scoreRows: every window counts, bet or not', () => {
  const rows = [
    {pUp: 0.7, winner: 'up', status: 'answered', bet: {costUsd: 5, feeUsd: 0.1}, pnlUsd: 2, answerSeconds: 4},
    {pUp: 0.4, winner: 'up', status: 'answered', bet: null, pnlUsd: null, answerSeconds: 6},
    {pUp: 0.9, winner: 'up', status: 'late', bet: null, pnlUsd: null, answerSeconds: 140},
    {pUp: null, winner: 'down', status: 'no_answer', bet: null, pnlUsd: null, answerSeconds: null},
  ];
  const s = scoreRows(rows);
  assert.equal(s.windows, 4); assert.equal(s.hits, 2.5); near(s.hitRate, 0.625);
  near(s.brier, (0.09 + 0.36 + 0.01 + 0.25) / 4);
  assert.equal(s.bets, 1); assert.equal(s.skips, 1); assert.equal(s.late, 1); assert.equal(s.noAnswer, 1); assert.equal(s.missed, 2);
  near(s.pnlUsd, 2); assert.equal(s.medianAnswerSeconds, 6);
});

test('marketSides: leans and bets counted with or against the favourite at the snapshot', () => {
  const s = marketSides([
    {pUp: 0.7, favourite: 'up', bet: {side: 'up'}, won: true, pnlUsd: 2},
    {pUp: 0.4, favourite: 'up', bet: {side: 'down'}, won: false, pnlUsd: -5},
    {pUp: 0.5, favourite: 'down', bet: null, won: null, pnlUsd: null},
    {pUp: null, favourite: 'down', bet: null, won: null, pnlUsd: null},
    {pUp: 0.2, favourite: null, bet: {side: 'down'}, won: true, pnlUsd: 1},
  ]);
  assert.equal(s.answers, 3); assert.equal(s.sameSide, 1); assert.equal(s.otherSide, 1); near(s.sameSideRate, 1 / 3);
  assert.deepEqual(s.withFavourite, {bets: 1, won: 1, pnlUsd: 2}); assert.deepEqual(s.againstFavourite, {bets: 1, won: 0, pnlUsd: -5});
});

test('median', () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 2, 3]), 2.5); assert.equal(median([]), null); assert.equal(median([null, 5]), 5); });

test('coin-flip band for 72 windows: 28 to 44 hits is ordinary luck, 45 is the first count outside it', () => {
  const band = coinFlipBand(72);
  assert.equal(band.lowHits, 28); assert.equal(band.highHits, 44); assert.equal(band.needHitsToBeat, 45);
  near(band.needRateToBeat, 45 / 72);
  assert.ok(1 - binomialCdf(44, 72) < 0.025); assert.ok(1 - binomialCdf(43, 72) >= 0.025);
});

test('the best of nine coin-flippers over 72 windows averages about 42 hits', () => {
  const best = bestOfCoinFlips(72, 9);
  assert.ok(best.expectedHits > 41.5 && best.expectedHits < 43, String(best.expectedHits));
  assert.ok(best.p95Hits >= 45 && best.p95Hits <= 47, String(best.p95Hits));
});

test('paired gap: only windows where one version was right and the other wrong count', () => {
  const a = [1, 1, 1, 0, 1, 0.5], b = [1, 0, 0, 1, 0, 1];
  const gap = pairedGap(a, b);
  assert.equal(gap.aOnly, 3); assert.equal(gap.bOnly, 1); assert.equal(gap.discordant, 4); assert.equal(gap.insideLuck, true);
  const clear = pairedGap(Array(12).fill(1), Array(12).fill(0));
  assert.ok(clear.pValue < 0.001); assert.equal(clear.insideLuck, false);
  assert.equal(pairedGap([1, 0], [1, 0]).pValue, 1);
});

test('gap needed between two independent versions over 72 windows is about 16 points', () => {
  const gap = independentGapNeeded(72); assert.ok(gap > 0.16 && gap < 0.17, String(gap));
});
