// Scoring. Pure functions.
// Every version is scored on every counted window from its probability, whether it bet or not.

// 1 for the right lean, 0 for the wrong lean, 0.5 when there is no lean (exactly 0.5 or no answer in time).
export function hitValue(pUp, winner) {
  if (pUp == null || pUp === 0.5) return 0.5;
  return (pUp > 0.5) === (winner === 'up') ? 1 : 0;
}

// Squared error of the probability. No answer in time is scored as 0.5 (a coin flip), which costs 0.25.
export function brier(pUp, winner) {
  const p = pUp == null ? 0.5 : pUp;
  return (p - (winner === 'up' ? 1 : 0)) ** 2;
}

export const median = values => {
  const sorted = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// rows: one per counted, settled window for one contestant:
// {pUp, winner, status: 'answered'|'late'|'no_answer', bet: {costUsd, feeUsd, ...}|null, pnlUsd, answerSeconds}
export function scoreRows(rows) {
  const n = rows.length;
  const hits = rows.reduce((sum, r) => sum + hitValue(r.pUp, r.winner), 0);
  const brierSum = rows.reduce((sum, r) => sum + brier(r.pUp, r.winner), 0);
  const bets = rows.filter(r => r.bet);
  // The same two scores over only the windows it answered in time, to tell forecast quality apart from speed.
  const answeredRows = rows.filter(r => r.pUp != null);
  const answeredHits = answeredRows.reduce((sum, r) => sum + hitValue(r.pUp, r.winner), 0);
  return {
    windows: n,
    hits,
    hitRate: n ? hits / n : null,
    brier: n ? brierSum / n : null,
    answered: rows.filter(r => r.pUp != null).length,
    answeredHits,
    answeredHitRate: answeredRows.length ? answeredHits / answeredRows.length : null,
    answeredBrier: answeredRows.length ? answeredRows.reduce((sum, r) => sum + brier(r.pUp, r.winner), 0) / answeredRows.length : null,
    noAnswer: rows.filter(r => r.status === 'no_answer').length,
    late: rows.filter(r => r.status === 'late').length,
    missed: rows.filter(r => r.status === 'late' || r.status === 'no_answer').length,
    bets: bets.length,
    betsWon: bets.filter(r => r.pnlUsd > 0).length,
    skips: rows.filter(r => r.status === 'answered' && !r.bet).length,
    stakedUsd: bets.reduce((sum, r) => sum + r.bet.costUsd, 0),
    feesUsd: bets.reduce((sum, r) => sum + r.bet.feeUsd, 0),
    pnlUsd: bets.reduce((sum, r) => sum + (r.pnlUsd ?? 0), 0),
    medianAnswerSeconds: median(rows.map(r => r.answerSeconds)),
    maxAnswerSeconds: rows.reduce((max, r) => (r.answerSeconds != null && r.answerSeconds > max ? r.answerSeconds : max), 0) || null,
  };
}

// With or against the market. The favourite is the side the order book priced above 50 cents at the snapshot.
// Counts how often the probabilities leaned the favourite's way, and what the bets on its side and against it made.
// rows: {pUp, favourite: 'up'|'down'|null, bet: {side}|null, won, pnlUsd}
export function marketSides(rows) {
  const tally = () => ({bets: 0, won: 0, pnlUsd: 0});
  const out = {answers: 0, sameSide: 0, otherSide: 0, sameSideRate: null, withFavourite: tally(), againstFavourite: tally()};
  for (const r of rows) {
    if (!r.favourite) continue;
    if (r.pUp != null) {
      out.answers++;
      if (r.pUp !== 0.5) { if ((r.pUp > 0.5 ? 'up' : 'down') === r.favourite) out.sameSide++; else out.otherSide++; }
    }
    if (r.bet && r.pnlUsd != null) {
      const side = r.bet.side === r.favourite ? out.withFavourite : out.againstFavourite;
      side.bets++; if (r.won) side.won++; side.pnlUsd += r.pnlUsd;
    }
  }
  out.sameSideRate = out.answers ? out.sameSide / out.answers : null;
  return out;
}

// ---- How much could be luck -------------------------------------------------

const logFactorialCache = [0];
function logFactorial(n) {
  for (let i = logFactorialCache.length; i <= n; i++) logFactorialCache[i] = logFactorialCache[i - 1] + Math.log(i);
  return logFactorialCache[n];
}
export const binomialPmf = (k, n, p = 0.5) => Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
export const binomialCdf = (k, n, p = 0.5) => { let sum = 0; for (let i = 0; i <= Math.floor(k); i++) sum += binomialPmf(i, n, p); return Math.min(1, sum); };

// The range of hit counts a pure coin-flipper lands in 95% of the time over n windows.
export function coinFlipBand(n, level = 0.95) {
  if (!n) return null;
  const tail = (1 - level) / 2;
  let low = 0; while (binomialCdf(low, n) < tail) low++;           // smallest k with P(X <= k) >= tail
  let high = n; while (1 - binomialCdf(high - 1, n) < tail) high--; // largest k with P(X >= k) >= tail
  return {n, lowHits: low, highHits: high, lowRate: low / n, highRate: high / n, needHitsToBeat: high + 1, needRateToBeat: (high + 1) / n};
}

// What the best of `count` independent coin-flippers scores over n windows: its average and its 95th percentile.
export function bestOfCoinFlips(n, count) {
  if (!n) return null;
  let expected = 0, p95 = null, previous = 0;
  for (let k = 0; k <= n; k++) {
    const cdfMax = binomialCdf(k, n) ** count;
    expected += k * (cdfMax - previous);
    if (p95 == null && cdfMax >= 0.95) p95 = k;
    previous = cdfMax;
  }
  return {n, count, expectedHits: expected, expectedRate: expected / n, p95Hits: p95, p95Rate: p95 / n};
}

// Two versions on the same windows: only the windows where one was right and the other wrong carry information.
// Returns the two-sided sign-test p-value; 0.05 or more means the gap is inside what luck produces.
export function pairedGap(hitsA, hitsB) {
  let aOnly = 0, bOnly = 0;
  for (let i = 0; i < hitsA.length; i++) {
    if (hitsA[i] === 1 && hitsB[i] === 0) aOnly++;
    else if (hitsA[i] === 0 && hitsB[i] === 1) bOnly++;
  }
  const discordant = aOnly + bOnly;
  if (!discordant) return {aOnly, bOnly, discordant, pValue: 1, insideLuck: true};
  const pValue = Math.min(1, 2 * binomialCdf(Math.min(aOnly, bOnly), discordant));
  return {aOnly, bOnly, discordant, pValue, insideLuck: pValue >= 0.05};
}

// The smallest gap in hit rate between two independent versions that would be unusual by luck alone (95%).
export function independentGapNeeded(n) {
  if (!n) return null;
  return 1.96 * Math.sqrt(2 * 0.25 / n);
}
