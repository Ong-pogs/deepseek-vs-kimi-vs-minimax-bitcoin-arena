// The round loop. One window of Polymarket's 5-minute Bitcoin market per round:
// one Predictefy snapshot, the same prompt to every model at the same instant (through OpenRouter), paper bets at the
// live Predictefy order book when each answer arrives, and settlement on the market's real result.
// All state lives on disk in the run folder, so the run can be stopped and resumed.
import {existsSync, mkdirSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {secrets} from './env.mjs';
import {createClient, formatCall} from './predictefy.mjs';
import {buildSnapshot, SOURCES} from './snapshot.mjs';
import {buildPrompt, SYSTEM_PROMPT, sha256} from './prompt.mjs';
import {parseAnswer} from './parse.mjs';
import {walkAsks, settleBet, FILL_LABEL} from './ledger.mjs';
import {callOpenRouter, commandLine} from './openrouter.mjs';
import {baselinePicks, BASELINES} from './baselines.mjs';
import {readFinalBooks, readVenueResult, VENUE_SOURCE} from './settle.mjs';
import {lastRoundAtOrBefore} from './snapshot.mjs';
import {sleep, sleepUntil, mulberry32, hashSeed, shuffled, writeJson, readJson, appendLine, clock} from './util.mjs';
import {buildState} from './state.mjs';

const round2 = v => Math.round(v * 100) / 100;

export function loadRounds(runDir) {
  const dir = path.join(runDir, 'rounds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).sort().map(f => readJson(path.join(dir, f))).filter(Boolean);
}

// Free cash for one account: the budget, minus every bet's cost, plus the payout of every settled bet. Voided windows do not count.
export function freeCash(rounds, id, budgetUsd, kind = 'bets') {
  let cash = budgetUsd;
  for (const r of rounds) {
    if (r.void) continue;
    const bet = r[kind]?.[id]?.bet ?? (kind === 'bets' ? r.bets?.[id] : null);
    if (!bet) continue;
    cash -= bet.costUsd;
    if (bet.settled) cash += bet.settled.payoutUsd;
  }
  return Math.round(cash * 1e6) / 1e6;
}

export async function runArena({runDir, config, target = config.windows, only = null, finishFile = null, mode = 'run', extraClaudeEnv = {}, startAtMs = null}) {
  mkdirSync(path.join(runDir, 'rounds'), {recursive: true});
  const contestants = only ? config.contestants.filter(c => only.includes(c.id)) : config.contestants;
  // Every model is called through OpenRouter with the same request; only "model" differs.
  const apiKey = secrets().OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (add it to the .env file named in config/local.json)');
  const settings = config.openrouter;
  // Spend so far, in dollars, from the cost OpenRouter reported on every call already on disk.
  const spentUsd = () => rounds.reduce((sum, r) => sum + Object.values(r.calls || {}).reduce((s, c) => s + (c.result?.listPriceUsd || 0), 0), 0);
  const log = (...parts) => console.log(`[${clock()}] ${parts.join(' ')}`);
  const stopFile = path.join(runDir, 'stop');
  const runFile = path.join(runDir, 'run.json');
  const previous = readJson(runFile, {});
  const run = {
    name: config.name, mode, runDir, status: 'running', pid: process.pid,
    startedAt: previous.startedAt || new Date().toISOString(), resumedAt: previous.startedAt ? new Date().toISOString() : null, resumes: (previous.resumes || 0) + (previous.startedAt ? 1 : 0),
    target, contestants: contestants.map(c => c.id), finishFile, models: contestants.map(c => c.model), spendCapUsd: settings.spendCapUsd,
    command: commandLine(settings), systemPrompt: SYSTEM_PROMPT, systemPromptSha256: sha256(SYSTEM_PROMPT),
    counted: 0, attempted: 0, voided: 0, pausedUntil: null, pauseReason: null, finishedAt: null, heartbeat: new Date().toISOString(),
    expectedEndAt: null,
  };
  writeJson(path.join(runDir, 'config.json'), {...config, contestants});
  const rounds = loadRounds(runDir);
  const saveRun = () => { run.heartbeat = new Date().toISOString(); run.counted = rounds.filter(r => !r.void && r.status !== 'open').length; run.attempted = rounds.length; run.voided = rounds.filter(r => r.void).length; writeJson(runFile, run); };
  const saveRound = r => writeJson(path.join(runDir, 'rounds', `${r.t0}.json`), r);
  let stateTimer = null;
  const refreshState = () => { if (stateTimer) return; stateTimer = setTimeout(() => { stateTimer = null; try { buildState(runDir, {write: true}); } catch (e) { log('state build failed:', e.message); } }, 300); };

  // Every Predictefy call is tagged with the window it belongs to, logged to the run log and saved to disk.
  const client = createClient({onCall: row => {
    const {scope: t0, ...rest} = row; const tagged = {t0, ...rest};
    appendLine(path.join(runDir, 'predictefy-calls.jsonl'), tagged); log(formatCall(row));
    const r = rounds.find(x => x.t0 === t0); if (r) { r.predictefy.push(tagged); r.credits = (r.credits || 0) + row.credits; }
  }});
  const scoped = t0 => ({
    marketBySlug: (slug, purpose) => client.marketBySlug(slug, purpose, {scope: t0}),
    orderBook: (id, purpose, options) => client.orderBook(id, purpose, {scope: t0, ...options}),
    chainlinkRounds: (limit, purpose) => client.chainlinkRounds(limit, purpose, {scope: t0}),
  });

  // Rounds that were in flight when an earlier process stopped can never be completed fairly: void them.
  for (const r of rounds) if (r.status === 'open') { r.status = 'done'; r.void = {reason: 'the runner stopped during this window', blocked: [], errors: []}; saveRound(r); }
  saveRun(); refreshState();
  log(`${mode === 'pilot' ? 'PILOT' : 'RUN'} ${config.name}: ${contestants.length} versions, target ${target} counted windows, ${rounds.filter(r => !r.void).length} already on disk`);
  log(`request: ${run.command}`);
  log(`models: ${contestants.map(c => `${c.id} = ${c.model}`).join(', ')}; spend cap $${settings.spendCapUsd}, spent so far $${spentUsd().toFixed(4)}`);
  log(`rules: snapshot at ${config.snapshotSecond}s, bets close at ${config.betCutoffSecond}s, answers stop counting at ${config.answerDeadlineSecond}s, $${config.stakeUsd} flat, $${config.budgetUsd} budget, bet rule "${config.betRule}"`);

  const settling = new Set();
  for (const r of rounds) if (!r.result && r.market && r.status !== 'open') settling.add(settle(r, true));

  async function settle(r, resumed = false) {
    const api = scoped(r.t0);
    const closeMs = (r.t0 + config.windowSeconds) * 1000;
    try {
      let book = r.finalBook || null;
      if (!book && !resumed) {
        await sleepUntil(closeMs + config.settlement.bookReadSecondsAfterClose * 1000);
        book = await readFinalBooks(api, r.market, `window ${r.index} result: last order book`);
        r.finalBook = book; saveRound(r);
        log(`window ${r.index} closed. Predictefy's last order book: Up bid ${book.upBid ?? '-'}, Down bid ${book.downBid ?? '-'} -> ${book.winner ? book.winner.toUpperCase() : 'not clear yet'}`);
      }
      // Predictefy's Chainlink feed, close against open, as a cross-check.
      let chainlink = null;
      await sleepUntil(closeMs + 45000);
      const history = await api.chainlinkRounds(config.snapshot.chainlinkRounds, `window ${r.index} result: Chainlink cross-check`);
      if (history.ok) {
        const open = lastRoundAtOrBefore(history.data, r.t0), close = lastRoundAtOrBefore(history.data, r.t0 + config.windowSeconds);
        if (open && close) chainlink = {openUsd: open.answer, closeUsd: close.answer, direction: close.answer >= open.answer ? 'up' : 'down', source: SOURCES.bitcoin};
      }
      // The venue's published resolution is the result of record.
      let venue = null; const giveUp = Date.now() + config.settlement.venueGiveUpSeconds * 1000; let tries = 0;
      while (!venue && Date.now() < giveUp) {
        const got = await readVenueResult(r.slug); tries++;
        if (got.result) venue = {...got.result, readAtMs: Date.now(), tries};
        else await sleep(config.settlement.venuePollSeconds * 1000);
        if (existsSync(stopFile) && tries > 2) break;
      }
      if (!venue) { log(`window ${r.index}: the venue has not published a result yet; it stays pending`); return; }
      r.result = {winner: venue.winner, venue, book, chainlink, settledAtMs: Date.now(), bookAgrees: book?.winner ? book.winner === venue.winner : null, chainlinkAgrees: chainlink ? chainlink.direction === venue.winner : null};
      if (!r.void) {
        for (const id of Object.keys(r.bets)) { const bet = r.bets[id]; if (bet) bet.settled = settleBet(bet, venue.winner); }
        for (const b of Object.values(r.baselines)) if (b.bet) b.bet.settled = settleBet(b.bet, venue.winner);
      }
      saveRound(r); saveRun(); refreshState();
      const line = contestants.map(c => { const a = r.answers[c.id]; const bet = r.bets[c.id]; return `${c.id} ${a?.pUp != null ? a.pUp.toFixed(2) : '--'}${bet ? (bet.settled.won ? ' +' : ' ') + bet.settled.pnlUsd.toFixed(2) : ''}`; }).join(' | ');
      log(`window ${r.index} RESULT ${venue.winner.toUpperCase()} (Polymarket: price to beat ${venue.priceToBeat ?? '?'}, final ${venue.finalPrice ?? '?'}; Predictefy book ${book?.winner ?? 'n/a'}; Chainlink feed ${chainlink?.direction ?? 'n/a'})${r.void ? '  [window voided]' : ''}`);
      if (!r.void) log(`  ${line}`);
    } catch (e) { log(`window ${r.index} settlement error: ${e.message}`); }
  }

  async function playWindow(t0) {
    const api = scoped(t0);
    const slug = config.slugPrefix + t0;
    const index = rounds.length + 1;
    const r = {t0, slug, index, opensAt: new Date(t0 * 1000).toISOString(), closesAt: new Date((t0 + config.windowSeconds) * 1000).toISOString(), status: 'open', void: null, market: null, snapshot: null, facts: null, prompt: null, promptSha256: null, order: [], launchAtMs: null, snapshotTakenAtMs: null, calls: {}, answers: {}, bets: {}, baselines: {}, predictefy: [], credits: 0, finalBook: null, result: null};
    rounds.push(r); saveRound(r); saveRun();
    const snapshotMs = (t0 + config.snapshotSecond) * 1000;
    const voidRound = reason => { r.void = {reason, blocked: [], errors: []}; r.status = 'done'; saveRound(r); saveRun(); refreshState(); log(`window ${index} VOID: ${reason}`); return r; };

    // 1. Find the market a few seconds early (its ids do not change).
    await sleepUntil(snapshotMs - 12000);
    log(`--- window ${index}  ${slug}  ${r.opensAt.slice(11, 16)}-${r.closesAt.slice(11, 16)} UTC ---`);
    let found = await api.marketBySlug(slug, `window ${index}: find the market`);
    if (!found.ok || !found.data?.[0]) { await sleep(1500); found = await api.marketBySlug(slug, `window ${index}: find the market (retry)`); }
    const m = found.data?.[0];
    const upOutcome = m?.outcomes?.find(o => o.label === 'Up'), downOutcome = m?.outcomes?.find(o => o.label === 'Down');
    if (!found.ok || !m || !upOutcome || !downOutcome) return voidRound(`Predictefy did not return the market (${found.error || 'not found'})`);
    r.market = {marketId: m.marketId, title: m.title, description: m.description, url: m.url, slug: m.slug, conditionId: m.sourceMetadata?.nativeMarketId ?? null, outcomes: [{label: 'Up', outcomeId: upOutcome.outcomeId}, {label: 'Down', outcomeId: downOutcome.outcomeId}]};

    // 2. The snapshot, at the fixed second: both order books and the Chainlink rounds, in parallel.
    await sleepUntil(snapshotMs);
    let upBook, downBook, history;
    for (let attempt = 1; attempt <= 2; attempt++) {
      [upBook, downBook, history] = await Promise.all([
        api.orderBook(upOutcome.outcomeId, `window ${index} snapshot: Up order book`, {tries: 1}),
        api.orderBook(downOutcome.outcomeId, `window ${index} snapshot: Down order book`, {tries: 1}),
        api.chainlinkRounds(config.snapshot.chainlinkRounds, `window ${index} snapshot: Chainlink BTC/USD rounds`),
      ]);
      if (upBook.ok && downBook.ok && history.ok) break;
    }
    if (!upBook.ok || !downBook.ok || !history.ok) return voidRound(`Predictefy snapshot failed (${upBook.error || downBook.error || history.error})`);
    r.snapshotTakenAtMs = Date.now();
    let built;
    try { built = buildSnapshot({market: r.market, upBook: upBook.data, downBook: downBook.data, rounds: history.data, t0, takenAtMs: r.snapshotTakenAtMs, config}); }
    catch (e) { return voidRound(`snapshot could not be built: ${e.message}`); }
    r.snapshot = built.snapshot; r.facts = built.facts;
    r.raw = {upBook: {asks: upBook.data.asks.slice(0, 12), bids: upBook.data.bids.slice(0, 12), timestamp: upBook.data.timestamp}, downBook: {asks: downBook.data.asks.slice(0, 12), bids: downBook.data.bids.slice(0, 12), timestamp: downBook.data.timestamp}, chainlinkRounds: history.data.map(x => ({roundId: x.roundId, answer: x.answer, updatedAt: x.updatedAt}))};
    r.prompt = buildPrompt({market: r.market, snapshot: r.snapshot, config});
    r.promptSha256 = sha256(r.prompt);
    log(`snapshot at ${r.snapshot.window.seconds_into_window}s: BTC ${r.snapshot.bitcoin.last_value_before_open.usd} at open, ${r.snapshot.bitcoin.latest_value.usd} now (${r.snapshot.bitcoin.change_since_open_usd >= 0 ? '+' : ''}${r.snapshot.bitcoin.change_since_open_usd}); Up ${r.snapshot.market.up.best_bid}/${r.snapshot.market.up.best_ask}, Down ${r.snapshot.market.down.best_bid}/${r.snapshot.market.down.best_ask}`);

    // 3. The baselines answer instantly and are filled at the snapshot's own books.
    const picks = baselinePicks(r.facts, config.seed, t0);
    for (const b of BASELINES) {
      const pick = picks[b.id]; const entry = {side: pick.side, pUp: pick.pUp, detail: pick.detail, bet: null, noBetReason: null};
      if (!pick.side) entry.noBetReason = 'no side';
      else if (freeCash(rounds, b.id, config.budgetUsd, 'baselines') < config.stakeUsd) entry.noBetReason = 'no free cash';
      else {
        const walked = walkAsks((pick.side === 'up' ? upBook : downBook).data.asks, config.stakeUsd, {fee: config.fee, minShares: config.minShares});
        if (walked.shares > 0) entry.bet = {side: pick.side, shares: walked.shares, avgPrice: walked.avgPrice, costUsd: walked.costUsd, feeUsd: walked.feeUsd, atMs: r.snapshotTakenAtMs, label: FILL_LABEL};
        else entry.noBetReason = walked.reason;
      }
      r.baselines[b.id] = entry;
    }

    // 4. All versions start at the same instant, in an order shuffled with the saved seed.
    const order = shuffled(contestants, mulberry32(hashSeed(config.seed, 'order', t0)));
    r.order = order.map(c => c.id);
    const cutoffMs = (t0 + config.betCutoffSecond) * 1000, deadlineMs = (t0 + config.answerDeadlineSecond) * 1000;
    const fills = [];
    r.launchAtMs = Date.now();
    const onAnswer = (c, record) => {
      const parsed = parseAnswer(record.text, {betRule: config.betRule});
      const atMs = record.answerAtMs;
      const answer = {valid: parsed.valid, pUp: parsed.valid ? parsed.pUp : null, call: parsed.valid ? parsed.call : null, callNote: parsed.callNote ?? null, reason: parsed.valid ? parsed.reason : null, error: parsed.valid ? null : parsed.error, atMs, secondsIntoWindow: round2((atMs - t0 * 1000) / 1000), answerSeconds: record.answerSeconds, status: null, noBetReason: null};
      r.answers[c.id] = answer;
      if (!parsed.valid) { answer.status = 'no_answer'; answer.noBetReason = `invalid answer: ${parsed.error}`; }
      else if (atMs > cutoffMs) { answer.status = 'late'; answer.noBetReason = `answer arrived ${answer.secondsIntoWindow}s into the window, after the ${config.betCutoffSecond}s cut-off`; }
      else {
        answer.status = 'answered';
        if (parsed.call === 'skip') answer.noBetReason = 'skip';
        else if (freeCash(rounds, c.id, config.budgetUsd) < config.stakeUsd) answer.noBetReason = 'no free cash';
        else fills.push((async () => {
          const outcome = parsed.call === 'up' ? upOutcome : downOutcome;
          let book = await api.orderBook(outcome.outcomeId, `window ${index} fill: ${c.id} buys ${parsed.call.toUpperCase()}`, {tries: 2});
          if (!book.ok) { r.fillFailure = `Predictefy order book read failed for ${c.id}'s fill (${book.error})`; answer.noBetReason = 'order book unavailable'; return; }
          const walked = walkAsks(book.data.asks, config.stakeUsd, {fee: config.fee, minShares: config.minShares});
          const snapshotAsk = parsed.call === 'up' ? r.facts.upAsk : r.facts.downAsk;
          if (walked.shares > 0) {
            r.bets[c.id] = {side: parsed.call, shares: walked.shares, avgPrice: walked.avgPrice, costUsd: walked.costUsd, feeUsd: walked.feeUsd, levels: walked.fills, partial: walked.partial, bookTimestamp: book.data.timestamp ?? null, bookReadAtMs: Date.now(), secondsIntoWindow: round2((Date.now() - t0 * 1000) / 1000), snapshotAsk, priceMoveSinceSnapshot: snapshotAsk != null ? Math.round((walked.avgPrice - snapshotAsk) * 10000) / 10000 : null, label: FILL_LABEL, source: SOURCES.book};
            log(`  FILL ${c.id.padEnd(11)} ${parsed.call.toUpperCase().padEnd(4)} ${walked.shares} shares @ ${walked.avgPrice.toFixed(4)} = $${walked.costUsd.toFixed(2)} incl. fee $${walked.feeUsd.toFixed(3)} (snapshot ask ${snapshotAsk ?? '-'}; ${FILL_LABEL})`);
          } else { answer.noBetReason = walked.reason; log(`  NO FILL ${c.id}: ${walked.reason}`); }
          saveRound(r); refreshState();
        })());
      }
      log(`  ${c.id.padEnd(11)} answered in ${String(record.answerSeconds).padStart(6)}s  p_up ${answer.pUp != null ? answer.pUp.toFixed(2) : ' -- '}  call ${(answer.call || '-').padEnd(4)}  ${answer.status === 'late' ? 'TOO LATE TO BET' : answer.noBetReason && answer.noBetReason !== 'skip' ? answer.noBetReason : ''}`);
      saveRound(r); refreshState();
    };
    const pending = order.map(c => callOpenRouter({apiKey, contestant: c, system: SYSTEM_PROMPT, prompt: r.prompt, settings, deadlineMs, rawFile: path.join(runDir, 'calls', String(t0), `${c.id}.json`), roundStartMs: r.launchAtMs, onAnswer: record => onAnswer(c, record)}));
    log(`launched ${order.length} calls in ${Date.now() - r.launchAtMs} ms, order: ${r.order.join(', ')}`);
    saveRound(r); refreshState();
    const records = await Promise.all(pending);
    await Promise.all(fills);

    // 5. Close the round.
    for (const record of records) {
      const {stderr, ...kept} = record;
      r.calls[record.id] = {...kept, stderr: stderr ? stderr.slice(0, 300) : ''};
      if (record.status === 'timeout') { r.answers[record.id] = {valid: false, pUp: null, call: null, reason: null, error: 'no answer by the deadline', atMs: null, secondsIntoWindow: null, answerSeconds: null, status: 'no_answer', noBetReason: `no answer ${config.answerDeadlineSecond}s into the window; the call was stopped`}; log(`  ${record.id.padEnd(11)} NO ANSWER by ${config.answerDeadlineSecond}s; call stopped`); }
      else if (record.status !== 'ok') log(`  ${record.id.padEnd(11)} ${record.status.toUpperCase()}: ${record.statusDetail}`);
    }
    const blocked = records.filter(x => x.status === 'blocked').map(x => x.id), errors = records.filter(x => x.status === 'error').map(x => x.id);
    if (blocked.length || errors.length) r.void = {reason: blocked.length ? `OpenRouter blocked ${blocked.map(id => `${id}: ${r.calls[id].statusDetail}`).join('; ')}` : `a call failed for a reason that was not the model's (${errors.map(id => `${id}: ${r.calls[id].statusDetail}`).join('; ')})`, blocked, errors};
    else if (r.fillFailure) r.void = {reason: r.fillFailure, blocked: [], errors: []};
    if (r.void) { log(`window ${index} VOID for all versions: ${r.void.reason}`); for (const id of Object.keys(r.bets)) r.bets[id].void = true; }
    r.costUsd = records.reduce((sum, x) => sum + (x.result?.listPriceUsd || 0), 0);
    r.status = 'done';
    saveRound(r); saveRun(); refreshState();
    const tokens = records.reduce((sum, x) => sum + (x.result?.usage?.outputTokens ?? 0), 0);
    log(`window ${index} calls done: ${records.filter(x => x.status === 'ok').length} ok, ${records.filter(x => x.status === 'timeout').length} no answer, ${blocked.length} blocked, ${errors.length} failed; ${Object.keys(r.bets).length} bets; Predictefy credits this window so far: ${r.credits}; output tokens ${tokens}; OpenRouter $${r.costUsd.toFixed(4)} (${records.map(x => `${x.id} $${(x.result?.listPriceUsd || 0).toFixed(4)}`).join(', ')}), run total $${spentUsd().toFixed(4)}`);
    return r;
  }

  // ---- main loop ----
  if (startAtMs && Date.now() < startAtMs) {
    run.status = 'waiting to start'; run.startsAt = new Date(startAtMs).toISOString(); run.expectedEndAt = new Date(startAtMs + target * config.windowSeconds * 1000).toISOString(); saveRun(); refreshState();
    log(`waiting until ${run.startsAt} to play the first window`);
    while (Date.now() < startAtMs - 20000 && !existsSync(stopFile)) { await sleep(Math.min(15000, startAtMs - 20000 - Date.now())); saveRun(); }
    run.status = 'running'; saveRun();
  }
  let voidStreak = 0;
  while (true) {
    const counted = rounds.filter(r => !r.void && r.status !== 'open').length;
    if (counted >= target) break;
    if (rounds.length >= (mode === 'pilot' ? target + 3 : config.maxWindowsAttempted)) { log(`stopping: ${rounds.length} windows attempted`); break; }
    if (existsSync(stopFile)) { log('stop file found: stopping after the last finished window'); run.status = 'stopped'; break; }
    // The spend cap: stop before a window that could take the total past it (the dearest window so far, or 10 cents
    // before the first one, stands in for the next window's cost).
    const nextCost = Math.max(0.1, ...rounds.map(r => r.costUsd || 0));
    if (spentUsd() + nextCost > settings.spendCapUsd) { log(`SPEND CAP: $${spentUsd().toFixed(4)} spent, the next window could cost up to $${nextCost.toFixed(4)}, cap $${settings.spendCapUsd}. Stopping.`); run.status = 'stopped: spend cap'; run.pauseReason = 'spend cap reached'; break; }
    if (run.pausedUntil && Date.now() < run.pausedUntil) { log(`paused until ${new Date(run.pausedUntil).toISOString()} (${run.pauseReason})`); saveRun(); while (Date.now() < run.pausedUntil && !existsSync(stopFile)) { await sleep(15000); saveRun(); } continue; }
    run.pausedUntil = null; run.pauseReason = null;
    // The next window whose snapshot second is still at least 15 seconds away.
    let t0 = Math.floor(Date.now() / 1000 / config.windowSeconds) * config.windowSeconds;
    while ((t0 + config.snapshotSecond) * 1000 - Date.now() < 15000 || rounds.some(r => r.t0 === t0)) t0 += config.windowSeconds;
    run.expectedEndAt = new Date((t0 + (target - counted) * config.windowSeconds) * 1000).toISOString();
    saveRun();
    // Wait for the window here, where a stop request is still honoured: once a window's calls are out it is played to the end.
    while (Date.now() < (t0 + config.snapshotSecond) * 1000 - 13000 && !existsSync(stopFile)) await sleep(Math.min(1000, (t0 + config.snapshotSecond) * 1000 - 13000 - Date.now()));
    if (existsSync(stopFile)) continue;
    let r;
    try { r = await playWindow(t0); }
    catch (e) {
      // Nothing may stop the run: an unexpected failure throws this window out and the loop goes on.
      log(`window at ${t0} failed unexpectedly: ${e.stack || e}`);
      r = rounds.find(x => x.t0 === t0);
      if (!r) { await sleep(5000); continue; }
      r.status = 'done'; r.void = {reason: `the runner hit an unexpected error (${String(e.message || e).slice(0, 120)})`, blocked: [], errors: []}; saveRound(r); saveRun(); refreshState();
      await sleepUntil((t0 + config.answerDeadlineSecond) * 1000);
    }
    if (!r.void) { voidStreak = 0; settling.add(settle(r)); continue; }
    settling.add(settle(r));
    voidStreak++;
    if (r.void.blocked?.some(id => /answered 402/.test(r.calls[id]?.statusDetail || ''))) {
      // 402: the OpenRouter balance is spent. Waiting will not help; stop and say so.
      log('STOP: OpenRouter reports the balance is spent (402).'); run.status = 'stopped: OpenRouter balance'; break;
    } else if (r.void.blocked?.length) {
      // 429: rate limited. Wait a few minutes and carry on.
      run.pausedUntil = Date.now() + config.blocks.defaultPauseSeconds * 1000; run.pauseReason = `OpenRouter rate-limited ${r.void.blocked.length} call(s) in window ${r.index}`; run.status = 'paused'; saveRun();
      log(`PAUSE: ${run.pauseReason}. Resuming at ${new Date(run.pausedUntil).toISOString()}`);
    } else if (voidStreak >= 3) {
      run.pausedUntil = Date.now() + config.blocks.defaultPauseSeconds * 1000; run.pauseReason = `${voidStreak} voided windows in a row`; run.status = 'paused'; saveRun();
      log(`PAUSE: ${run.pauseReason}`);
    }
    if (run.status === 'paused') { while (Date.now() < run.pausedUntil && !existsSync(stopFile)) { await sleep(15000); saveRun(); } run.status = 'running'; }
  }

  log('waiting for the last results...');
  await Promise.all([...settling]);
  const state = buildState(runDir, {write: true});
  const counted = rounds.filter(r => !r.void && r.status !== 'open').length;
  const pendingResults = rounds.filter(r => !r.void && !r.result).length;
  if (!run.status.startsWith('stopped')) run.status = counted >= target && !pendingResults ? 'finished' : counted >= target ? 'finished, results pending' : 'stopped';
  run.finishedAt = new Date().toISOString();
  saveRun();
  buildState(runDir, {write: true});
  log(`${run.status.toUpperCase()}: ${counted} counted windows, ${rounds.filter(r => r.void).length} voided, ${pendingResults} results pending, Predictefy credits used ${state.credits.total}`);
  if (finishFile && run.status.startsWith('finished')) {
    const finalState = buildState(runDir, {write: true});
    writeJson(finishFile, {finishedAt: run.finishedAt, startedAt: run.startedAt, runDir, status: run.status, windowsCounted: counted, windowsVoided: run.voided, resultsPending: pendingResults, rules: finalState.rules, command: run.command, credits: finalState.credits, claudeCalls: finalState.claudeCalls, versions: finalState.versions.map(v => ({id: v.id, model: v.model, effort: v.effort, ...v.score})), baselines: finalState.baselines.map(b => ({id: b.id, label: b.label, ...b.score})), luck: finalState.luck, results: finalState.resultChecks, stateFile: path.join(runDir, 'state.json')});
    log(`wrote ${finishFile}`);
  }
  return run;
}
