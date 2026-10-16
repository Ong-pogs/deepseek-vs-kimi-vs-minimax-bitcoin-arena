import {test} from 'node:test';
import assert from 'node:assert/strict';
import {walkAsks, takerFee, settleBet, newAccount, applyFill, applySettlement, canAfford, equity} from '../src/ledger.mjs';

const FEE = {rate: 0.07, exponent: 1};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test('fee: the crypto taker fee matches the table Polymarket publishes for 100 shares', () => {
  near(takerFee(100, 0.5, FEE), 1.75);   // docs.polymarket.com/trading/fees: $1.75 at 50 cents
  near(takerFee(100, 0.3, FEE), 1.47);   // $1.47 at 30 cents
  near(takerFee(100, 0.7, FEE), 1.47);   // and the same at 70 cents
  assert.equal(takerFee(100, 0.5, null), 0);
});

test('fee: rounded to 5 decimals, and anything under 0.00001 is zero', () => {
  assert.equal(takerFee(0.01, 0.99, FEE), 0.00001);       // 0.01 x 0.07 x 0.99 x 0.01 = 0.00000693, rounds to 0.00001
  assert.equal(takerFee(0.01, 0.999, FEE), 0);            // 0.0000007, rounds to zero
  assert.equal(takerFee(8.77, 0.57, FEE), 0.15047);       // 8.77 x 0.07 x 0.57 x 0.43 = 0.1504669
});

test('fill walk: a $5 buy inside the best level spends at most $5 with the fee included', () => {
  const fill = walkAsks([{price: 0.57, size: 597.9}, {price: 0.58, size: 100}], 5, {fee: FEE});
  assert.equal(fill.levelsUsed, 1);
  assert.equal(fill.avgPrice, 0.57);
  assert.equal(fill.shares, 8.51);                        // 5 / (0.57 + 0.07 x 0.57 x 0.43) = 8.513, floored to 8.51
  assert.ok(fill.costUsd <= 5 && fill.costUsd > 4.99);
  near(fill.costUsd, fill.notionalUsd + fill.feeUsd, 1e-6);
});

test('fill walk: walks up the ladder when the best level is too small, paying each level its own price', () => {
  const fill = walkAsks([{price: 0.5, size: 4}, {price: 0.52, size: 3}, {price: 0.6, size: 100}], 5, {fee: FEE});
  assert.equal(fill.levelsUsed, 3);
  assert.deepEqual(fill.fills.map(f => f.price), [0.5, 0.52, 0.6]);
  assert.equal(fill.fills[0].shares, 4);
  assert.equal(fill.fills[1].shares, 3);
  assert.ok(fill.avgPrice > 0.5 && fill.avgPrice < 0.6);
  assert.ok(fill.costUsd <= 5);
});

test('fill walk: never buys past displayed depth, and says when the book ran out', () => {
  const fill = walkAsks([{price: 0.2, size: 6}, {price: 0.25, size: 2}], 5, {fee: FEE});
  assert.equal(fill.shares, 8);                           // all that was displayed
  assert.ok(fill.costUsd < 2);
  assert.equal(fill.partial, true);
});

test('fill walk: no asks, junk levels and the venue minimum', () => {
  assert.equal(walkAsks([], 5, {fee: FEE}).shares, 0);
  assert.equal(walkAsks([], 5, {fee: FEE}).reason, 'no asks in the book');
  assert.equal(walkAsks([{price: 1, size: 50}, {price: 0, size: 50}, {price: 0.4, size: 0}], 5, {fee: FEE}).shares, 0);
  const small = walkAsks([{price: 0.3, size: 3}], 5, {fee: FEE, minShares: 5});
  assert.equal(small.shares, 0);
  assert.match(small.reason, /minimum of 5 shares/);
});

test('fill walk: asks are sorted before walking, whatever order they arrive in', () => {
  const fill = walkAsks([{price: 0.9, size: 100}, {price: 0.4, size: 100}], 5, {fee: FEE});
  assert.equal(fill.avgPrice, 0.4);
});

test('fill walk: at 99 cents a $5 stake still clears the 5-share minimum', () => {
  const fill = walkAsks([{price: 0.99, size: 1000}], 5, {fee: FEE, minShares: 5});
  assert.ok(fill.shares >= 5);
  assert.ok(fill.costUsd <= 5);
});

test('settlement: a winning share pays $1, a losing share pays nothing', () => {
  const bet = {side: 'up', shares: 8.51, costUsd: 4.9967};
  const won = settleBet(bet, 'up'), lost = settleBet(bet, 'down');
  assert.equal(won.won, true); near(won.payoutUsd, 8.51); near(won.pnlUsd, 8.51 - 4.9967);
  assert.equal(lost.won, false); assert.equal(lost.payoutUsd, 0); near(lost.pnlUsd, -4.9967);
});

test('account: cash moves at the fill and again at settlement; equity counts open bets at cost', () => {
  let account = newAccount(100);
  const fill = walkAsks([{price: 0.5, size: 100}], 5, {fee: FEE});
  account = applyFill(account, fill);
  near(account.cashUsd, 100 - fill.costUsd); near(equity(account), 100);
  const bet = {side: 'down', shares: fill.shares, costUsd: fill.costUsd};
  account = applySettlement(account, bet, settleBet(bet, 'down'));
  near(account.cashUsd, 100 - fill.costUsd + fill.shares); assert.equal(account.wins, 1); near(account.openCostUsd, 0);
  assert.equal(canAfford({cashUsd: 4.99}, 5), false); assert.equal(canAfford({cashUsd: 5}, 5), true);
});
