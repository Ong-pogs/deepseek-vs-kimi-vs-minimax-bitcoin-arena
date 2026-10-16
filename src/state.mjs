// Turns the run folder into one state object for the dashboard, the finish file and the notes.
// Everything here is derived from the round files, so it can be rebuilt at any time.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {scoreRows, marketSides, hitValue, coinFlipBand, bestOfCoinFlips, pairedGap, independentGapNeeded, median} from './scoring.mjs';
import {BASELINES} from './baselines.mjs';
import {SOURCES} from './snapshot.mjs';
import {VENUE_SOURCE} from './settle.mjs';
import {FILL_LABEL} from './ledger.mjs';
import {readJson, writeJson} from './util.mjs';

const FREE_PLAN_CREDITS = 25000;

export function rulesText(config) {
  const always = config.betRule === 'always';
  return [
    `One market: Polymarket's 5-minute "Bitcoin Up or Down". One round per 5-minute window, ${config.windows} windows in a row.`,
    `One snapshot per window, taken ${config.snapshotSecond} seconds in. Every fact in it comes from the Predictefy API: both order books, and the Chainlink BTC/USD price at the open, now and for the last ${config.snapshot.minuteMarks} minutes. Code does the arithmetic.`,
    `The same prompt, word for word, and the same OpenRouter request for all ${config.contestants.length}. Only the model differs. One system and one user message: no tools, no web search, no memory of earlier rounds. ${config.openrouter.reasoningTokens ? `The same caps for everyone: ${config.openrouter.maxTokens} tokens per reply, ${config.openrouter.reasoningTokens} of them for thinking.` : `Thinking is off for every model, and every reply is capped at ${config.openrouter.maxTokens} tokens.`}`,
    `All ${config.contestants.length} start at the same instant, in an order shuffled with a saved seed. Every start and finish time, and what each call cost, is logged.`,
    always ? 'Every version must answer with its probability that Bitcoin finishes up and the side it would rather hold: up or down.' : 'Every version must answer with its probability that Bitcoin finishes up and its call: up, down or skip.',
    always ? `Every version bets a flat $${config.stakeUsd} on its side in every window. Budget $${config.budgetUsd} each; no bet without free cash.` : `A call of up or down is a flat $${config.stakeUsd} bet on that side. Budget $${config.budgetUsd} each; no bet without free cash.`,
    `The bet fills when the answer arrives: it walks the real asks in the order book read through Predictefy at that moment, never past displayed depth, plus Polymarket's taker fee (shares x ${config.fee.rate} x price x (1 - price)). Predictefy's paper engine refuses these markets, so the test keeps its own ledger and every fill is labelled "${FILL_LABEL}".`,
    config.betCutoffSecond < config.answerDeadlineSecond
      ? `An answer that arrives more than ${config.betCutoffSecond} seconds into the window is too late to bet: a missed window. Its probability is still scored. No answer by ${config.answerDeadlineSecond} seconds is scored as a coin flip (0.5).`
      : `One deadline for everyone: the answer must arrive by ${config.answerDeadlineSecond} seconds into the window, ${config.windowSeconds - config.answerDeadlineSecond} seconds before it closes. Later is a missed window: the call is stopped, there is no bet, and the round is scored as a coin flip (0.5). A slow answer that makes the deadline is filled at whatever the order book offers by then.`,
    'Scoring uses every counted window for every version: hit rate (did its probability lean the right way) and Brier score (squared error of the probability, lower is better; always saying 0.5 scores 0.25).',
    'Bets settle on the market\'s real result as Polymarket publishes it. Predictefy\'s last order book and Chainlink feed are shown next to it as a cross-check.',
    'Three baselines that are not AI get the same snapshot and stake: a random pick (saved seed), the market\'s favourite, and the direction Bitcoin has moved since the open.',
    `If OpenRouter fails or rate-limits any call, that window is thrown out for all ${config.contestants.length} and one more window is added at the end, so every model is scored on the same windows. The run stops before total spend would pass $${config.openrouter.spendCapUsd}.`,
  ];
}

export function buildState(runDir, {write = false} = {}) {
  const config = readJson(path.join(runDir, 'config.json'));
  const run = readJson(path.join(runDir, 'run.json'), {});
  const roundsDir = path.join(runDir, 'rounds');
  const rounds = existsSync(roundsDir) ? readdirSync(roundsDir).filter(f => /^\d+\.json$/.test(f)).sort().map(f => readJson(path.join(roundsDir, f))).filter(Boolean) : [];
  const counted = rounds.filter(r => !r.void && r.status !== 'open');
  const settled = counted.filter(r => r.result);

  const versionRows = id => settled.map(r => {
    const a = r.answers[id]; const bet = r.bets[id] || null;
    return {t0: r.t0, pUp: a?.pUp ?? null, winner: r.result.winner, status: a?.status ?? 'no_answer', bet, pnlUsd: bet?.settled?.pnlUsd ?? null, won: bet?.settled?.won ?? null, favourite: r.baselines?.favourite?.side ?? null, answerSeconds: a?.answerSeconds ?? null};
  });
  const equitySeries = (betOf) => {
    let pnl = 0; const points = [{n: 0, equityUsd: config.budgetUsd}];
    counted.forEach((r, i) => { const bet = betOf(r); if (bet?.settled) pnl += bet.settled.pnlUsd; points.push({n: i + 1, t0: r.t0, equityUsd: Math.round((config.budgetUsd + pnl) * 100) / 100, settled: !!r.result}); });
    return points;
  };

  const versions = config.contestants.map(c => {
    const rows = versionRows(c.id);
    const calls = rounds.map(r => r.calls?.[c.id]).filter(Boolean);
    const okCalls = calls.filter(x => x.status === 'ok');
    const usage = okCalls.map(x => x.result?.usage).filter(Boolean);
    const openBets = counted.filter(r => !r.result && r.bets[c.id]).map(r => r.bets[c.id]);
    const allBets = counted.map(r => r.bets[c.id]).filter(Boolean);
    const allAnswers = counted.map(r => r.answers[c.id]).filter(Boolean);
    const score = scoreRows(rows);
    const sides = marketSides(rows);
    return {
      id: c.id, model: c.model, modelLabel: c.modelLabel, effort: c.effort,
      score: {
        ...score,
        sameSideAsFavourite: sides.sameSide, withFavourite: sides.withFavourite, againstFavourite: sides.againstFavourite,
        equityUsd: Math.round((config.budgetUsd + score.pnlUsd) * 100) / 100,
        openBets: openBets.length,
        betsPlaced: allBets.length,
        missedAll: allAnswers.filter(a => a.status === 'late' || a.status === 'no_answer').length,
        lateAll: allAnswers.filter(a => a.status === 'late').length,
        noAnswerAll: allAnswers.filter(a => a.status === 'no_answer').length,
        medianAnswerSecondsAll: median(allAnswers.map(a => a.answerSeconds)),
        avgPriceMove: allBets.length ? allBets.reduce((s, b) => s + (b.priceMoveSinceSnapshot ?? 0), 0) / allBets.length : null,
      },
      equity: equitySeries(r => r.bets[c.id]),
      proof: {
        calls: calls.length, ok: okCalls.length,
        modelsReported: [...new Set(calls.map(x => x.checks?.modelReported).filter(Boolean))],
        allClean: okCalls.length > 0 && okCalls.every(x => x.checks && Object.entries(x.checks).every(([k, v]) => k === 'modelReported' || v !== false)),
        medianInputTokens: median(usage.map(u => (u.inputTokens ?? 0) + (u.cacheCreationTokens ?? 0) + (u.cacheReadTokens ?? 0))),
        medianOutputTokens: median(usage.map(u => u.outputTokens)),
        medianThinkingTokens: median(usage.map(u => u.thinkingTokens)),
        totalOutputTokens: usage.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
        listPriceUsd: okCalls.reduce((s, x) => s + (x.result?.listPriceUsd ?? 0), 0),
      },
    };
  });

  const baselines = BASELINES.map(b => {
    const rows = settled.map(r => { const e = r.baselines?.[b.id] || {}; return {pUp: e.pUp ?? null, lean: e.side ?? null, winner: r.result.winner, status: 'answered', bet: e.bet || null, pnlUsd: e.bet?.settled?.pnlUsd ?? null, answerSeconds: 0}; });
    const hits = rows.reduce((s, r) => s + (r.lean == null ? 0.5 : r.lean === r.winner ? 1 : 0), 0);
    const base = scoreRows(rows);
    const hasProbability = rows.some(r => r.pUp != null);
    return {id: b.id, label: b.label, rule: b.rule, score: {...base, hits, hitRate: rows.length ? hits / rows.length : null, brier: hasProbability ? base.brier : null, equityUsd: Math.round((config.budgetUsd + base.pnlUsd) * 100) / 100, medianAnswerSeconds: 0}, equity: equitySeries(r => r.baselines?.[b.id]?.bet)};
  });

  // With or against the market: all nine versions together, against the favourite at each snapshot.
  const versusMarket = marketSides(config.contestants.flatMap(c => versionRows(c.id)));

  // How much of a gap could be luck.
  const n = settled.length;
  const hitsOf = id => settled.map(r => hitValue(r.answers[id]?.pUp ?? null, r.result.winner));
  const favouriteHits = settled.map(r => { const side = r.baselines?.favourite?.side; return side == null ? 0.5 : side === r.result.winner ? 1 : 0; });
  const pairs = [];
  for (let i = 0; i < versions.length; i++) for (let j = i + 1; j < versions.length; j++) pairs.push({a: versions[i].id, b: versions[j].id, gapHits: versions[i].score.hits - versions[j].score.hits, ...pairedGap(hitsOf(versions[i].id), hitsOf(versions[j].id))});
  const luck = n ? {
    windows: n,
    coinFlip: coinFlipBand(n),
    bestOfNine: bestOfCoinFlips(n, versions.length),
    independentGapNeeded: independentGapNeeded(n),
    versusFavourite: versions.map(v => ({id: v.id, ...pairedGap(hitsOf(v.id), favouriteHits)})),
    pairs,
    pairsOutsideLuck: pairs.filter(p => !p.insideLuck).length,
  } : null;

  // Credits.
  const callsFile = path.join(runDir, 'predictefy-calls.jsonl');
  const apiCalls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const kind = c => /snapshot|find the market/.test(c.purpose) ? 'snapshot' : /fill/.test(c.purpose) ? 'fills' : /result/.test(c.purpose) ? 'results' : 'other';
  const byKind = {snapshot: 0, fills: 0, results: 0, other: 0};
  for (const c of apiCalls) byKind[kind(c)] += c.credits || 0;
  const totalCredits = apiCalls.reduce((s, c) => s + (c.credits || 0), 0);
  const perWindow = rounds.length ? totalCredits / rounds.length : null;
  const credits = {
    total: totalCredits, calls: apiCalls.length, byKind, perWindow,
    lastWindow: rounds.at(-1)?.credits ?? null,
    remaining: apiCalls.findLast?.(c => c.creditsRemaining != null)?.creditsRemaining ?? null,
    freePlan: {monthlyCredits: FREE_PLAN_CREDITS, windowsPerMonth: perWindow ? Math.floor(FREE_PLAN_CREDITS / perWindow) : null, hoursPerMonth: perWindow ? Math.round(FREE_PLAN_CREDITS / perWindow * config.windowSeconds / 360) / 10 : null},
    prices: {market: 1, orderBook: 5, chainlinkRounds: 2},
  };

  const allCalls = rounds.flatMap(r => Object.values(r.calls || {}));
  const claudeCalls = {
    total: allCalls.length, ok: allCalls.filter(c => c.status === 'ok').length, noAnswer: allCalls.filter(c => c.status === 'timeout').length, blocked: allCalls.filter(c => c.status === 'blocked').length, failed: allCalls.filter(c => c.status === 'error').length,
    outputTokens: allCalls.reduce((s, c) => s + (c.result?.usage?.outputTokens ?? 0), 0),
    listPriceUsd: allCalls.reduce((s, c) => s + (c.result?.listPriceUsd ?? 0), 0),
    planLimit: rounds.findLast?.(r => r.planLimit)?.planLimit ?? null,
  };

  const openDiffs = settled.filter(r => r.result.venue?.priceToBeat != null && r.facts?.openRound).map(r => Math.abs(r.facts.openRound.answer - r.result.venue.priceToBeat));
  const resultChecks = {
    settled: settled.length, pending: counted.length - settled.length,
    up: settled.filter(r => r.result.winner === 'up').length, down: settled.filter(r => r.result.winner === 'down').length,
    bookKnown: settled.filter(r => r.result.book?.winner).length, bookAgrees: settled.filter(r => r.result.bookAgrees === true).length,
    chainlinkKnown: settled.filter(r => r.result.chainlink).length, chainlinkAgrees: settled.filter(r => r.result.chainlinkAgrees === true).length,
    meanAbsOpenDiffUsd: openDiffs.length ? openDiffs.reduce((a, b) => a + b, 0) / openDiffs.length : null, maxAbsOpenDiffUsd: openDiffs.length ? Math.max(...openDiffs) : null,
  };

  const windows = rounds.map(r => ({
    index: r.index, t0: r.t0, slug: r.slug, opensAt: r.opensAt, closesAt: r.closesAt, status: r.status, void: r.void, title: r.market?.title ?? null, url: r.market?.url ?? null,
    countedIndex: r.void || r.status === 'open' ? null : counted.indexOf(r) + 1,
    snapshot: r.snapshot ? {secondsIn: r.snapshot.window.seconds_into_window, btcOpen: r.snapshot.bitcoin.last_value_before_open.usd, btcNow: r.snapshot.bitcoin.latest_value.usd, change: r.snapshot.bitcoin.change_since_open_usd, upBid: r.snapshot.market.up.best_bid, upAsk: r.snapshot.market.up.best_ask, downBid: r.snapshot.market.down.best_bid, downAsk: r.snapshot.market.down.best_ask, upMid: r.snapshot.market.up.mid} : null,
    result: r.result ? {winner: r.result.winner, priceToBeat: r.result.venue?.priceToBeat ?? null, finalPrice: r.result.venue?.finalPrice ?? null, bookWinner: r.result.book?.winner ?? null, bookUpBid: r.result.book?.upBid ?? null, bookDownBid: r.result.book?.downBid ?? null, chainlinkDirection: r.result.chainlink?.direction ?? null, chainlinkOpen: r.result.chainlink?.openUsd ?? null, chainlinkClose: r.result.chainlink?.closeUsd ?? null} : null,
    credits: r.credits ?? 0, order: r.order, launchAtMs: r.launchAtMs, promptSha256: r.promptSha256,
    answers: Object.fromEntries(config.contestants.map(c => { const a = r.answers?.[c.id]; const bet = r.bets?.[c.id]; const call = r.calls?.[c.id]; return [c.id, a || call ? {pUp: a?.pUp ?? null, call: a?.call ?? null, status: a?.status ?? (call ? call.status : null), reason: a?.reason ?? null, noBetReason: a?.noBetReason ?? null, answerSeconds: a?.answerSeconds ?? null, secondsIntoWindow: a?.secondsIntoWindow ?? null, callStatus: call?.status ?? null, outputTokens: call?.result?.usage?.outputTokens ?? null, thinkingTokens: call?.result?.usage?.thinkingTokens ?? null, hit: r.result && !r.void ? hitValue(a?.pUp ?? null, r.result.winner) : null, bet: bet ? {side: bet.side, shares: bet.shares, avgPrice: bet.avgPrice, costUsd: bet.costUsd, feeUsd: bet.feeUsd, snapshotAsk: bet.snapshotAsk, priceMove: bet.priceMoveSinceSnapshot, secondsIntoWindow: bet.secondsIntoWindow, won: bet.settled?.won ?? null, pnlUsd: bet.settled?.pnlUsd ?? null} : null} : null]; })),
    baselines: Object.fromEntries(BASELINES.map(b => { const e = r.baselines?.[b.id]; return [b.id, e ? {side: e.side, pUp: e.pUp, bet: e.bet ? {avgPrice: e.bet.avgPrice, costUsd: e.bet.costUsd, won: e.bet.settled?.won ?? null, pnlUsd: e.bet.settled?.pnlUsd ?? null} : null} : null]; })),
  }));

  // One full window for the "open a real snapshot" chapter: the latest counted one unless ARENA_INSPECT picks another.
  const inspectT0 = Number(process.env.ARENA_INSPECT || 0);
  const inspected = rounds.find(r => r.t0 === inspectT0) || counted.findLast?.(r => r.result) || counted.at(-1) || null;
  const inspect = inspected ? {index: inspected.index, t0: inspected.t0, slug: inspected.slug, title: inspected.market?.title, snapshot: inspected.snapshot, prompt: inspected.prompt, promptSha256: inspected.promptSha256, raw: inspected.raw, predictefy: (inspected.predictefy || []).map(c => ({at: c.at, path: c.path, purpose: c.purpose, status: c.status, ms: c.ms, credits: c.credits})), result: inspected.result ? {winner: inspected.result.winner, priceToBeat: inspected.result.venue?.priceToBeat, finalPrice: inspected.result.venue?.finalPrice} : null} : null;

  const state = {
    generatedAt: new Date().toISOString(),
    run: {name: config.name, mode: run.mode, status: run.status, startedAt: run.startedAt, expectedEndAt: run.expectedEndAt, finishedAt: run.finishedAt, heartbeat: run.heartbeat, target: run.target ?? config.windows, counted: counted.length, settled: settled.length, attempted: rounds.length, voided: rounds.filter(r => r.void).length, pausedUntil: run.pausedUntil, pauseReason: run.pauseReason},
    rules: {text: rulesText(config), snapshotSecond: config.snapshotSecond, betCutoffSecond: config.betCutoffSecond, answerDeadlineSecond: config.answerDeadlineSecond, stakeUsd: config.stakeUsd, budgetUsd: config.budgetUsd, betRule: config.betRule, fee: config.fee, seed: config.seed, windowSeconds: config.windowSeconds, windows: config.windows, minShares: config.minShares},
    command: run.command, claudeVersion: run.claudeVersion ?? null, systemPrompt: run.systemPrompt, fillLabel: FILL_LABEL,
    sources: {...SOURCES, result: VENUE_SOURCE, resultCheck: 'GET /api/polymarket/fetchOrderBook after the close (5 credits each) and GET /api/feeds/chainlink/fetchOracleHistory (2 credits)'},
    versions, baselines, versusMarket, luck, credits, claudeCalls, resultChecks, windows, inspect,
  };
  if (write) writeJson(path.join(runDir, 'state.json'), state);
  return state;
}
