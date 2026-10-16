// The paper ledger. Pure functions: no network, no clock.
// A buy walks the real asks read through Predictefy, never past displayed depth, pays the venue's taker fee,
// and is settled on the market's real result. Every fill is labelled as simulated.

export const FILL_LABEL = 'simulated at the live Predictefy order book';

const floorTo = (value, decimals) => Math.floor(value * 10 ** decimals + 1e-9) / 10 ** decimals;
const roundTo = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

// Polymarket's published taker fee: shares x rate x price x (1 - price), in dollars, rounded to 5 decimals.
// With exponent 1 this is the formula on https://docs.polymarket.com/trading/fees (crypto rate 0.07).
export function takerFee(shares, price, fee) {
  if (!fee || !fee.rate) return 0;
  const raw = shares * fee.rate * (price * (1 - price)) ** (fee.exponent ?? 1);
  const rounded = roundTo(raw, 5);
  return rounded < 0.00001 ? 0 : rounded;
}

// Spend up to `stakeUsd` (fee included) buying from the asks, cheapest first.
// asks: [{price, size}] in shares. Returns what was bought; `shares` is 0 when nothing could be filled.
export function walkAsks(asks, stakeUsd, {fee = null, minShares = 0, shareDecimals = 2} = {}) {
  const levels = (asks || [])
    .map(level => ({price: Number(level.price), size: Number(level.size)}))
    .filter(level => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
  const fills = [];
  let remaining = stakeUsd;
  for (const level of levels) {
    const feePerShare = fee?.rate ? fee.rate * (level.price * (1 - level.price)) ** (fee.exponent ?? 1) : 0;
    const unitCost = level.price + feePerShare;
    let shares = floorTo(Math.min(level.size, remaining / unitCost), shareDecimals);
    // Rounding the fee to 5 decimals can push the cost a hair over what is left; step down until it fits.
    while (shares > 0 && shares * level.price + takerFee(shares, level.price, fee) > remaining + 1e-9) shares = floorTo(shares - 10 ** -shareDecimals, shareDecimals);
    if (shares <= 0) break;
    const notional = shares * level.price;
    const levelFee = takerFee(shares, level.price, fee);
    fills.push({price: level.price, shares, notionalUsd: roundTo(notional, 6), feeUsd: levelFee, displayedSize: level.size});
    remaining -= notional + levelFee;
    if (shares < floorTo(level.size, shareDecimals)) break; // the stake ran out inside this level
  }
  const shares = roundTo(fills.reduce((sum, f) => sum + f.shares, 0), shareDecimals);
  const notionalUsd = roundTo(fills.reduce((sum, f) => sum + f.notionalUsd, 0), 6);
  const feeUsd = roundTo(fills.reduce((sum, f) => sum + f.feeUsd, 0), 5);
  const costUsd = roundTo(notionalUsd + feeUsd, 6);
  const depthShares = roundTo(levels.reduce((sum, l) => sum + l.size, 0), 2);
  const result = {
    shares, notionalUsd, feeUsd, costUsd,
    avgPrice: shares > 0 ? roundTo(notionalUsd / shares, 6) : null,
    levelsUsed: fills.length, fills,
    bestAsk: levels[0]?.price ?? null,
    displayedDepthShares: depthShares,
    partial: shares > 0 && costUsd < stakeUsd - 0.05 && fills.length === levels.length,
    reason: null,
  };
  if (!levels.length) return {...result, shares: 0, reason: 'no asks in the book'};
  if (shares <= 0) return {...result, shares: 0, reason: 'stake too small for one share step'};
  if (minShares && shares < minShares) return {...result, shares: 0, notionalUsd: 0, feeUsd: 0, costUsd: 0, avgPrice: null, fills: [], levelsUsed: 0, reason: `below the venue minimum of ${minShares} shares`};
  return result;
}

// One contestant's account. All money in dollars.
export function newAccount(budgetUsd) {
  return {budgetUsd, cashUsd: budgetUsd, openCostUsd: 0, realizedPnlUsd: 0, feesUsd: 0, bets: 0, wins: 0, losses: 0};
}

export const canAfford = (account, stakeUsd) => account.cashUsd + 1e-9 >= stakeUsd;

export function applyFill(account, fill) {
  if (!fill || fill.shares <= 0) return account;
  return {...account, cashUsd: roundTo(account.cashUsd - fill.costUsd, 6), openCostUsd: roundTo(account.openCostUsd + fill.costUsd, 6), feesUsd: roundTo(account.feesUsd + fill.feeUsd, 5), bets: account.bets + 1};
}

// A winning share pays $1, a losing share pays nothing.
export function settleBet(bet, winner) {
  const won = bet.side === winner;
  const payoutUsd = won ? roundTo(bet.shares * 1, 6) : 0;
  return {won, payoutUsd, pnlUsd: roundTo(payoutUsd - bet.costUsd, 6)};
}

export function applySettlement(account, bet, settled) {
  return {...account, cashUsd: roundTo(account.cashUsd + settled.payoutUsd, 6), openCostUsd: roundTo(account.openCostUsd - bet.costUsd, 6), realizedPnlUsd: roundTo(account.realizedPnlUsd + settled.pnlUsd, 6), wins: account.wins + (settled.won ? 1 : 0), losses: account.losses + (settled.won ? 0 : 1)};
}

export const equity = account => roundTo(account.cashUsd + account.openCostUsd, 6);
