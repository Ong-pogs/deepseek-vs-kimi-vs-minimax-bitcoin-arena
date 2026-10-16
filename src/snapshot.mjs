// Builds the one snapshot per window that all nine versions receive, from Predictefy responses only.
// Pure: give it the raw responses and the times, get the snapshot plus a map of where each number came from.
import {walkAsks} from './ledger.mjs';

const round = (value, decimals) => (value == null ? null : Math.round(value * 10 ** decimals) / 10 ** decimals);
const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

export const SOURCES = {
  market: 'GET /api/polymarket/fetchMarkets?slug=btc-updown-5m-<window start> (1 credit)',
  book: 'GET /api/polymarket/fetchOrderBook?outcomeId=<Up or Down outcome> (5 credits each)',
  bitcoin: 'GET /api/feeds/chainlink/fetchOracleHistory?symbol=BTC/USD&limit=30 (2 credits)',
};

// rounds: Chainlink rounds as Predictefy returns them ({answer, updatedAt in unix seconds, roundId}), any order.
export function lastRoundAtOrBefore(rounds, unixSeconds) {
  let best = null;
  for (const r of rounds) if (r.updatedAt <= unixSeconds && (!best || r.updatedAt > best.updatedAt)) best = r;
  return best;
}

export function topOfBook(book) {
  const bids = (book?.bids || []).filter(l => l.size > 0).sort((a, b) => b.price - a.price);
  const asks = (book?.asks || []).filter(l => l.size > 0).sort((a, b) => a.price - b.price);
  const bid = bids[0] || null, ask = asks[0] || null;
  return {
    best_bid: bid?.price ?? null, best_bid_shares: bid ? round(bid.size, 2) : null,
    best_ask: ask?.price ?? null, best_ask_shares: ask ? round(ask.size, 2) : null,
    mid: bid && ask ? round((bid.price + ask.price) / 2, 4) : null,
  };
}

// What $stake buys right now on one side: plain arithmetic for the models, the same walk the ledger uses.
export function costOfBet(book, stakeUsd, fill) {
  const walked = walkAsks(book?.asks, stakeUsd, fill);
  if (!walked.shares) return {available: false, why: walked.reason};
  return {available: true, shares: walked.shares, average_price: round(walked.avgPrice, 4), fee_usd: round(walked.feeUsd, 4), cost_usd: round(walked.costUsd, 4), pays_if_right_usd: walked.shares, profit_if_right_usd: round(walked.shares - walked.costUsd, 4)};
}

export function buildSnapshot({market, upBook, downBook, rounds, t0, takenAtMs, config}) {
  const windowSeconds = config.windowSeconds;
  const nowSeconds = takenAtMs / 1000;
  const sorted = [...rounds].sort((a, b) => a.updatedAt - b.updatedAt);
  const usable = sorted.filter(r => r.updatedAt <= nowSeconds + 1);
  const open = lastRoundAtOrBefore(usable, t0);
  const latest = usable.at(-1) || null;
  if (!open || !latest) throw new Error('not enough Chainlink rounds to build the snapshot');
  const marks = [];
  for (let minutes = config.snapshot.minuteMarks; minutes >= 1; minutes--) {
    const r = lastRoundAtOrBefore(usable, t0 - minutes * 60);
    if (r) marks.push({minutes_before_open: minutes, usd: round(r.answer, 2)});
  }
  const series = [...marks.map(m => m.usd), round(open.answer, 2)];
  const changes = series.slice(1).map((v, i) => round(v - series[i], 2));
  const absChanges = changes.map(Math.abs);
  const sinceOpen = usable.filter(r => r.updatedAt > t0).map(r => ({seconds_into_window: Math.round(r.updatedAt - t0), usd: round(r.answer, 2)}));
  const fillOptions = {fee: config.fee, minShares: config.minShares};
  const up = topOfBook(upBook), down = topOfBook(downBook);
  const elapsed = Math.round(nowSeconds - t0);
  const snapshot = {
    window: {opens_utc: iso(t0), closes_utc: iso(t0 + windowSeconds), seconds_into_window: elapsed, seconds_left: windowSeconds - elapsed},
    bitcoin: {
      source: 'Chainlink BTC/USD on-chain price feed (Polygon), read through Predictefy. It publishes a new value about every 33 seconds. The market itself settles on Chainlink\'s BTC/USD 60-second TWAP data stream, which can differ by a few dollars.',
      last_value_before_open: {usd: round(open.answer, 2), seconds_before_open: Math.round(t0 - open.updatedAt)},
      values_since_open: sinceOpen,
      latest_value: {usd: round(latest.answer, 2), seconds_ago: Math.round(nowSeconds - latest.updatedAt)},
      change_since_open_usd: round(latest.answer - open.answer, 2),
      change_since_open_percent: round((latest.answer / open.answer - 1) * 100, 4),
      one_minute_marks_before_open: marks,
      one_minute_changes_usd: changes,
      average_one_minute_move_usd: absChanges.length ? round(absChanges.reduce((a, b) => a + b, 0) / absChanges.length, 2) : null,
      largest_one_minute_move_usd: absChanges.length ? Math.max(...absChanges) : null,
    },
    market: {
      source: 'Polymarket order book for each side, read through Predictefy at the snapshot. Prices are dollars per share; a winning share pays 1.00.',
      up, down,
      what_5_dollars_buys_now: {up: costOfBet(upBook, config.stakeUsd, fillOptions), down: costOfBet(downBook, config.stakeUsd, fillOptions)},
    },
  };
  const facts = {
    openRound: {roundId: open.roundId, answer: open.answer, updatedAt: open.updatedAt},
    latestRound: {roundId: latest.roundId, answer: latest.answer, updatedAt: latest.updatedAt},
    upMid: up.mid, downMid: down.mid, upAsk: up.best_ask, downAsk: down.best_ask, upBid: up.best_bid, downBid: down.best_bid,
    changeSinceOpenUsd: snapshot.bitcoin.change_since_open_usd,
    bookTimestamps: {up: upBook?.timestamp ?? null, down: downBook?.timestamp ?? null},
    title: market.title, marketId: market.marketId,
  };
  return {snapshot, facts};
}
