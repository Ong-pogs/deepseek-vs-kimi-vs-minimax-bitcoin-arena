import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSnapshot, lastRoundAtOrBefore, topOfBook} from '../src/snapshot.mjs';
import {buildPrompt, sha256} from '../src/prompt.mjs';
import {parseAnswer} from '../src/parse.mjs';
import {baselinePicks} from '../src/baselines.mjs';
import {winnerFromBooks, parseVenueMarket} from '../src/settle.mjs';
import {mulberry32, hashSeed, shuffled} from '../src/util.mjs';

const config = {windowSeconds: 300, snapshot: {minuteMarks: 10, chainlinkRounds: 30}, stakeUsd: 5, minShares: 5, fee: {rate: 0.07, exponent: 1}, betRule: 'call', betCutoffSecond: 150, answerDeadlineSecond: 270};
const t0 = 1791448800;
// One Chainlink round every 33 seconds, from 12 minutes before the open to 20 seconds after it.
const rounds = [];
for (let t = t0 - 733, i = 0; t <= t0 + 20; t += 33, i++) rounds.push({roundId: String(1000 + i), answer: 82000 + i * 2, updatedAt: t});
const market = {marketId: '1', title: 'Bitcoin Up or Down - test', description: 'Resolves "Up" if the price at the end is greater than or equal to the price at the beginning.'};
const upBook = {asks: [{price: 0.57, size: 600}, {price: 0.58, size: 100}], bids: [{price: 0.56, size: 150}], timestamp: 1};
const downBook = {asks: [{price: 0.44, size: 190}], bids: [{price: 0.43, size: 1150}], timestamp: 1};

test('snapshot: the open reference is the last Chainlink round at or before the window opens', () => {
  const open = lastRoundAtOrBefore(rounds, t0);
  assert.ok(open.updatedAt <= t0 && t0 - open.updatedAt < 33);
  const {snapshot, facts} = buildSnapshot({market, upBook, downBook, rounds, t0, takenAtMs: (t0 + 31) * 1000, config});
  assert.equal(snapshot.bitcoin.last_value_before_open.usd, open.answer);
  assert.equal(snapshot.window.seconds_into_window, 31); assert.equal(snapshot.window.seconds_left, 269);
  assert.equal(snapshot.bitcoin.one_minute_marks_before_open.length, 10);
  assert.equal(snapshot.bitcoin.one_minute_changes_usd.length, 10);
  assert.equal(snapshot.bitcoin.change_since_open_usd, Math.round((snapshot.bitcoin.latest_value.usd - open.answer) * 100) / 100);
  assert.equal(snapshot.market.up.best_ask, 0.57); assert.equal(snapshot.market.up.mid, 0.565); assert.equal(snapshot.market.down.best_bid, 0.43);
  assert.equal(snapshot.market.what_5_dollars_buys_now.up.available, true);
  assert.ok(snapshot.market.what_5_dollars_buys_now.up.cost_usd <= 5);
  assert.equal(facts.upMid, 0.565);
});

test('snapshot: rounds published after the snapshot instant are never used', () => {
  const {snapshot} = buildSnapshot({market, upBook, downBook, rounds: [...rounds, {roundId: 'future', answer: 99999, updatedAt: t0 + 200}], t0, takenAtMs: (t0 + 31) * 1000, config});
  assert.notEqual(snapshot.bitcoin.latest_value.usd, 99999);
});

test('prompt: identical text for identical input, and it changes only with the bet rule', () => {
  const {snapshot} = buildSnapshot({market, upBook, downBook, rounds, t0, takenAtMs: (t0 + 31) * 1000, config});
  const a = buildPrompt({market, snapshot, config}), b = buildPrompt({market, snapshot, config});
  assert.equal(sha256(a), sha256(b));
  assert.match(a, /"up", "down" or "skip"/);
  assert.match(buildPrompt({market, snapshot, config: {...config, betRule: 'always'}}), /every round/);
});

test('answers: strict parsing, the same for every version', () => {
  assert.deepEqual(parseAnswer('{"p_up": 0.62, "call": "UP", "reason": "price above open"}'), {valid: true, pUp: 0.62, call: 'up', callNote: null, reason: 'price above open'});
  assert.equal(parseAnswer('Here you go:\n```json\n{"p_up": 0.4, "call": "skip", "reason": "no edge"}\n```').call, 'skip');
  assert.equal(parseAnswer('{"p_up": 62, "call": "up"}').valid, false);
  assert.equal(parseAnswer('{"p_up": 0.6, "call": "maybe"}').valid, false);
  assert.equal(parseAnswer('I think up').valid, false);
  assert.equal(parseAnswer('').valid, false);
  assert.equal(parseAnswer('{"p_up": 0.6, "call": "skip"}', {betRule: 'always'}).call, 'up');
  assert.equal(parseAnswer('{"p_up": 0.3, "call": "skip"}', {betRule: 'always'}).call, 'down');
  assert.equal(parseAnswer('{"p_up": 0.6, "call": "down", "reason": "a } brace in text"}').call, 'down');
});

test('baselines: favourite follows the book, momentum follows Chainlink, random replays from its seed', () => {
  const picks = baselinePicks({upMid: 0.565, changeSinceOpenUsd: -12.5}, 7, t0);
  assert.equal(picks.favourite.side, 'up'); assert.equal(picks.favourite.pUp, 0.565); assert.equal(picks.momentum.side, 'down');
  assert.equal(baselinePicks({upMid: 0.5, changeSinceOpenUsd: 0}, 7, t0).favourite.side, null);
  assert.equal(baselinePicks({upMid: 0.5, changeSinceOpenUsd: 0}, 7, t0).momentum.side, null);
  assert.equal(picks.random.side, baselinePicks({upMid: 0.1, changeSinceOpenUsd: 5}, 7, t0).random.side);
});

test('shuffle: the same seed gives the same order, and every version is still in it', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const one = shuffled(ids, mulberry32(hashSeed(20261008, 'order', t0))), two = shuffled(ids, mulberry32(hashSeed(20261008, 'order', t0)));
  assert.deepEqual(one, two); assert.deepEqual([...one].sort(), ids);
  assert.notDeepEqual(shuffled(ids, mulberry32(hashSeed(20261008, 'order', t0 + 300))), one);
});

test('result: the last book names a winner only when it is unmistakable', () => {
  assert.equal(winnerFromBooks({bids: [{price: 0.999, size: 10}], asks: []}, {bids: [], asks: [{price: 0.001, size: 10}]}).winner, 'up');
  assert.equal(winnerFromBooks({bids: [{price: 0.01, size: 10}], asks: [{price: 0.02, size: 5}]}, {bids: [{price: 0.98, size: 10}], asks: []}).winner, 'down');
  assert.equal(winnerFromBooks({bids: [{price: 0.6, size: 10}], asks: [{price: 0.62, size: 5}]}, {bids: [{price: 0.38, size: 10}], asks: []}).winner, null);
  assert.equal(topOfBook({bids: [], asks: []}).mid, null);
});

test('result: the published resolution is read only once the market is closed with prices 1 and 0', () => {
  const closed = {closed: true, outcomes: '["Up", "Down"]', outcomePrices: '["0", "1"]', umaResolutionStatus: 'resolved', events: [{eventMetadata: {priceToBeat: 82823.35, finalPrice: 82771.59}}]};
  assert.equal(parseVenueMarket(closed).winner, 'down'); assert.equal(parseVenueMarket(closed).priceToBeat, 82823.35);
  assert.equal(parseVenueMarket({...closed, closed: false}), null);
  assert.equal(parseVenueMarket({...closed, outcomePrices: '["0.9995", "0.0005"]'}), null);
  assert.equal(parseVenueMarket(null), null);
});
