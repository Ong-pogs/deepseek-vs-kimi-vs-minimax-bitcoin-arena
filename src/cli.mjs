#!/usr/bin/env node
// Command line for the arena.
//   node src/cli.mjs check                     read one live snapshot through Predictefy and print it (no Claude calls);
//                                              --prompt adds the exact prompt, --balance the credits left on the key
//   node src/cli.mjs pilot --windows 2         a short trial in its own folder (runs/pilot-...)
//   node src/cli.mjs launch                    start the full run as a detached background process
//   node src/cli.mjs start                     the same run in this terminal
//   node src/cli.mjs resume                    continue a stopped run from the state on disk (detached)
//   node src/cli.mjs status | stop             look at it, or ask it to stop after the current window
//   node src/cli.mjs dashboard                 serve the dashboard (live run, or --replay <state.json>)
//   node src/cli.mjs state --out file.json     rebuild the state from the round files and save a copy for replay
// Options: --run <name> (default "main"), --windows <n>, --only id,id, --finish-file <path>, --start-at <ISO time>, --port <n>, --keep-awake
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync, appendFileSync, openSync, rmSync} from 'node:fs';
import path from 'node:path';
import {ROOT, loadConfig, secrets} from './env.mjs';
import {readJson, clock} from './util.mjs';

const [command = 'help', ...rest] = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : fallback; };
const config = loadConfig();
const runName = flag('run', 'main');
const runDir = path.join(ROOT, 'runs', String(runName));
const isAlive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function redirectLog(file) {
  mkdirSync(path.dirname(file), {recursive: true});
  const write = line => { try { appendFileSync(file, line + '\n'); } catch {} };
  const original = console.log;
  console.log = (...parts) => { const line = parts.join(' '); write(line); try { original(line); } catch {} };
  console.error = console.log;
  process.on('uncaughtException', e => { write(`[${clock()}] UNCAUGHT ${e.stack || e}`); process.exit(1); });
  process.on('unhandledRejection', e => { write(`[${clock()}] UNHANDLED ${e?.stack || e}`); });
}

// Keeps the computer from going to sleep while the run is alive. Ends by itself when the run ends.
function keepAwake(pid) {
  if (process.platform !== 'win32') return;
  const script = `Add-Type -Namespace Arena -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; [Arena.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null; try { Wait-Process -Id ${pid} } catch {}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64'); // avoids every quoting problem
  try { spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {windowsHide: true, stdio: 'ignore'}).unref(); } catch {}
}

// Starts `node src/cli.mjs start ...` so that it keeps running after this terminal (or the program that launched it) closes.
// On Windows the process is created through WMI with a hidden window, so it belongs to no terminal at all. No scheduled task, no service.
function launchDetached(args) {
  mkdirSync(runDir, {recursive: true});
  const logFile = path.join(runDir, 'run.log');
  const full = [path.join(ROOT, 'src', 'cli.mjs'), 'start', ...args, '--log', logFile];
  if (process.platform === 'win32') {
    const quote = a => `"${String(a).replace(/"/g, '\\"')}"`;
    const commandLine = [process.execPath, ...full].map(quote).join(' ');
    const ps = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${commandLine.replace(/'/g, "''")}'; CurrentDirectory='${ROOT.replace(/'/g, "''")}'; ProcessStartupInformation=$si}; Write-Output ("{0} {1}" -f $r.ReturnValue, $r.ProcessId)`;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {encoding: 'utf8', windowsHide: true}).trim();
    const [code, pid] = out.split(/\s+/).map(Number);
    if (code !== 0) throw new Error(`could not start the background process (WMI return value ${out})`);
    return {pid, logFile};
  }
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, full, {cwd: ROOT, detached: true, stdio: ['ignore', fd, fd]});
  child.unref();
  return {pid: child.pid, logFile};
}

const passThrough = () => { const out = ['--run', String(runName)]; for (const name of ['windows', 'only', 'finish-file', 'start-at']) { const v = flag(name); if (v && v !== true) out.push(`--${name}`, String(v)); } if (flag('keep-awake')) out.push('--keep-awake'); return out; };

if (command === 'check') {
  const {createClient, formatCall} = await import('./predictefy.mjs');
  const {buildSnapshot} = await import('./snapshot.mjs');
  const {buildPrompt} = await import('./prompt.mjs');
  const client = createClient({onCall: row => console.log(formatCall(row))});
  const t0 = Math.floor(Date.now() / 1000 / config.windowSeconds) * config.windowSeconds;
  const slug = config.slugPrefix + t0;
  const found = await client.marketBySlug(slug, 'find the market');
  if (found.upgradeUrl) { console.log(`Your plan does not cover this request. Upgrade: ${found.upgradeUrl}`); process.exit(1); }
  const m = found.data?.[0];
  if (!m) { console.log(`Predictefy returned no market for ${slug} (${found.error || 'empty'})`); process.exit(1); }
  const up = m.outcomes.find(o => o.label === 'Up'), down = m.outcomes.find(o => o.label === 'Down');
  const [upBook, downBook, history] = await Promise.all([client.orderBook(up.outcomeId, 'Up order book'), client.orderBook(down.outcomeId, 'Down order book'), client.chainlinkRounds(config.snapshot.chainlinkRounds, 'Chainlink BTC/USD rounds')]);
  if (!upBook.ok || !downBook.ok || !history.ok) { console.log('A Predictefy call failed:', upBook.error || downBook.error || history.error); process.exit(1); }
  const {snapshot} = buildSnapshot({market: m, upBook: upBook.data, downBook: downBook.data, rounds: history.data, t0, takenAtMs: Date.now(), config});
  console.log(`\n${m.title}\n${m.url}\n`);
  console.log(JSON.stringify(snapshot, null, 1));
  if (flag('prompt')) console.log('\n--- the prompt every version would get ---\n' + buildPrompt({market: m, snapshot, config}));
  // The key's balance is only printed when asked for, so a shared screen or a recording does not show it.
  console.log(`\nPredictefy credits used by this check: ${client.totals.credits}` + (flag('balance') ? ` (remaining on the key: ${client.totals.remaining ?? 'unknown'})` : ''));
} else if (command === 'start' || command === 'pilot') {
  const {runArena} = await import('./runner.mjs');
  const pilot = command === 'pilot';
  const dir = pilot ? path.join(ROOT, 'runs', flag('run') && flag('run') !== true ? String(flag('run')) : `pilot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`) : runDir;
  if (flag('log') && flag('log') !== true) redirectLog(String(flag('log')));
  else if (pilot) redirectLog(path.join(dir, 'run.log'));
  const existing = readJson(path.join(dir, 'run.json'));
  if (existing?.pid && existing.pid !== process.pid && isAlive(existing.pid) && !['finished', 'stopped'].includes(existing.status)) { console.log(`This run is already going (process ${existing.pid}). Use "status" or "stop".`); process.exit(1); }
  rmSync(path.join(dir, 'stop'), {force: true});
  if (flag('keep-awake')) keepAwake(process.pid);
  const only = flag('only') && flag('only') !== true ? String(flag('only')).split(',') : null;
  const extraClaudeEnv = process.env.ARENA_CLAUDE_ENV ? JSON.parse(process.env.ARENA_CLAUDE_ENV) : {};
  // --start-at takes an ISO time (2026-10-08T11:25:00Z) and holds the first window until then.
  const startAt = flag('start-at') && flag('start-at') !== true ? Date.parse(String(flag('start-at'))) : null;
  if (flag('start-at') && !Number.isFinite(startAt)) { console.log('--start-at needs an ISO time such as 2026-10-08T11:25:00Z'); process.exit(1); }
  const run = await runArena({runDir: dir, config, target: Number(flag('windows', pilot ? 2 : config.windows)), only, finishFile: flag('finish-file') && flag('finish-file') !== true ? String(flag('finish-file')) : null, mode: pilot ? 'pilot' : 'run', extraClaudeEnv, startAtMs: startAt});
  process.exit(run.status.startsWith('finished') ? 0 : 2);
} else if (command === 'launch' || command === 'resume') {
  const existing = readJson(path.join(runDir, 'run.json'));
  if (existing?.pid && isAlive(existing.pid) && !['finished', 'stopped'].includes(existing.status)) { console.log(`Already running as process ${existing.pid}. Nothing started.`); process.exit(0); }
  if (command === 'launch' && existing?.startedAt && !flag('force')) { console.log(`A run named "${runName}" already exists (started ${existing.startedAt}). Use "resume" to continue it, or another --run name.`); process.exit(1); }
  if (command === 'resume' && !existing) { console.log(`No run named "${runName}" to resume.`); process.exit(1); }
  const args = passThrough();
  if (command === 'resume') { if (existing.finishFile && !args.includes('--finish-file')) args.push('--finish-file', existing.finishFile); if (existing.target && !args.includes('--windows')) args.push('--windows', String(existing.target)); if (!args.includes('--keep-awake')) args.push('--keep-awake'); }
  if (!secrets().PREDICTEFY_API_KEY) { console.log('PREDICTEFY_API_KEY is missing. Copy .env.example to .env and paste your key.'); process.exit(1); }
  const {pid, logFile} = launchDetached(args);
  console.log(`${command === 'resume' ? 'Resumed' : 'Started'} in the background.\n  process id : ${pid}\n  run folder : ${runDir}\n  log        : ${logFile}\n  check      : node src/cli.mjs status --run ${runName}\n  stop       : node src/cli.mjs stop --run ${runName}\n  resume     : node src/cli.mjs resume --run ${runName}`);
} else if (command === 'status') {
  const run = readJson(path.join(runDir, 'run.json'));
  if (!run) { console.log(`No run named "${runName}".`); process.exit(1); }
  const state = readJson(path.join(runDir, 'state.json'));
  const alive = isAlive(run.pid);
  console.log(`run "${runName}": ${run.status}${alive ? '' : run.status === 'running' || run.status === 'paused' ? '  (BUT process ' + run.pid + ' is not alive: use "resume")' : ''}`);
  console.log(`  process ${run.pid} ${alive ? 'alive' : 'not running'}, last heartbeat ${run.heartbeat}`);
  console.log(`  started ${run.startedAt}, expected end ${run.expectedEndAt ?? 'n/a'}, finished ${run.finishedAt ?? 'not yet'}`);
  console.log(`  windows: ${run.counted} counted of ${run.target}, ${run.voided} voided, ${run.attempted} attempted${run.pausedUntil ? `; paused until ${new Date(run.pausedUntil).toISOString()} (${run.pauseReason})` : ''}`);
  if (state) {
    console.log(`  Predictefy credits: ${state.credits.total} over ${state.credits.calls} calls; Claude calls: ${state.claudeCalls.total} (${state.claudeCalls.ok} ok, ${state.claudeCalls.noAnswer} no answer, ${state.claudeCalls.blocked} blocked, ${state.claudeCalls.failed} failed)`);
    console.log(`  results in: ${state.resultChecks.settled} (${state.resultChecks.up} up, ${state.resultChecks.down} down), pending ${state.resultChecks.pending}`);
    for (const v of state.versions) console.log(`    ${v.id.padEnd(12)} hit ${v.score.hitRate == null ? '  -  ' : (v.score.hitRate * 100).toFixed(1).padStart(5) + '%'}  Brier ${v.score.brier == null ? '  -  ' : v.score.brier.toFixed(4)}  P&L ${(v.score.pnlUsd >= 0 ? '+' : '') + v.score.pnlUsd.toFixed(2).padStart(6)}  bets ${String(v.score.betsPlaced).padStart(2)}  missed ${String(v.score.missedAll).padStart(2)}  median ${v.score.medianAnswerSecondsAll == null ? '-' : v.score.medianAnswerSecondsAll.toFixed(1) + 's'}`);
    for (const b of state.baselines) console.log(`    ${b.id.padEnd(12)} hit ${b.score.hitRate == null ? '  -  ' : (b.score.hitRate * 100).toFixed(1).padStart(5) + '%'}  Brier ${b.score.brier == null ? '  -  ' : b.score.brier.toFixed(4)}  P&L ${(b.score.pnlUsd >= 0 ? '+' : '') + b.score.pnlUsd.toFixed(2).padStart(6)}`);
  }
} else if (command === 'stop') {
  if (!existsSync(runDir)) { console.log(`No run named "${runName}".`); process.exit(1); }
  writeFileSync(path.join(runDir, 'stop'), new Date().toISOString());
  console.log(`Stop requested. The run finishes the window it is in, settles what it can and exits. Continue later with: node src/cli.mjs resume --run ${runName}`);
} else if (command === 'state') {
  // Rebuilds the dashboard state from the round files with the current code. --out <file> saves a copy (for replays).
  const {buildState} = await import('./state.mjs');
  const {writeJson} = await import('./util.mjs');
  const state = buildState(runDir, {write: !flag('no-write')});
  if (flag('out') && flag('out') !== true) { writeJson(String(flag('out')), state); console.log(`saved ${flag('out')}`); }
  console.log(`state of run "${runName}": ${state.run.settled} settled of ${state.run.counted} counted windows, ${state.credits.total} Predictefy credits`);
} else if (command === 'dashboard') {
  const {startServer} = await import('./server.mjs');
  startServer({runDir, port: Number(flag('port', config.dashboardPort)), replay: flag('replay') && flag('replay') !== true ? String(flag('replay')) : process.env.ARENA_REPLAY || null});
} else {
  console.log('Commands: check | pilot | launch | start | resume | status | stop | state | dashboard   (see the top of src/cli.mjs or the README)');
}
