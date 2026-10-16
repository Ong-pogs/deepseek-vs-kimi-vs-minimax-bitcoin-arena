// How a finished window's result is read.
// 1. Predictefy: the last order book after the close. The winning side is bid at 95 cents or more.
// 2. Polymarket's published resolution, from its public market API. Predictefy's catalogue marks these markets
//    resolved but does not record which side won, so this is the one number the test reads from the venue itself.
//    It is the result of record: every bet settles on it.
// 3. Predictefy's Chainlink feed, close against open, as a cross-check only.
import {topOfBook} from './snapshot.mjs';

export function winnerFromBooks(upBook, downBook) {
  const up = topOfBook(upBook), down = topOfBook(downBook);
  let winner = null;
  if (up.best_bid != null && up.best_bid >= 0.95 && (down.best_bid == null || down.best_bid <= 0.05)) winner = 'up';
  else if (down.best_bid != null && down.best_bid >= 0.95 && (up.best_bid == null || up.best_bid <= 0.05)) winner = 'down';
  return {winner, upBid: up.best_bid, upAsk: up.best_ask, downBid: down.best_bid, downAsk: down.best_ask};
}

export async function readFinalBooks(client, market, purpose) {
  const up = market.outcomes.find(o => o.label === 'Up'), down = market.outcomes.find(o => o.label === 'Down');
  const [upRes, downRes] = await Promise.all([client.orderBook(up.outcomeId, purpose, {tries: 1}), client.orderBook(down.outcomeId, purpose, {tries: 1})]);
  if (!upRes.ok || !downRes.ok) return {winner: null, error: upRes.error || downRes.error, atMs: Date.now()};
  return {...winnerFromBooks(upRes.data, downRes.data), atMs: Date.now(), source: 'GET /api/polymarket/fetchOrderBook (both sides, after the close)'};
}

export const VENUE_SOURCE = 'Polymarket public market API: GET https://gamma-api.polymarket.com/markets?closed=true&slug=<slug>';

export function parseVenueMarket(m) {
  if (!m) return null;
  let prices = null, outcomes = null;
  try { prices = JSON.parse(m.outcomePrices).map(Number); outcomes = JSON.parse(m.outcomes); } catch { return null; }
  if (!m.closed || !Array.isArray(prices) || prices.length !== 2 || !outcomes) return null;
  const upIndex = outcomes.findIndex(o => String(o).toLowerCase() === 'up'), downIndex = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
  if (upIndex < 0 || downIndex < 0) return null;
  let winner = null;
  if (prices[upIndex] === 1 && prices[downIndex] === 0) winner = 'up';
  else if (prices[downIndex] === 1 && prices[upIndex] === 0) winner = 'down';
  if (!winner) return null;
  const meta = m.events?.[0]?.eventMetadata || {};
  return {winner, resolutionStatus: m.umaResolutionStatus ?? null, closedTime: m.closedTime ?? null, priceToBeat: meta.priceToBeat ?? null, finalPrice: meta.finalPrice ?? null, feeSchedule: m.feeSchedule ?? null, conditionId: m.conditionId ?? null, source: VENUE_SOURCE};
}

export async function readVenueResult(slug) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?closed=true&slug=${slug}`, {signal: AbortSignal.timeout(10000)});
    if (!res.ok) return {result: null, error: `HTTP ${res.status}`};
    const list = await res.json();
    return {result: parseVenueMarket(list?.[0]), error: null};
  } catch (e) { return {result: null, error: String(e.message || e)}; }
}
