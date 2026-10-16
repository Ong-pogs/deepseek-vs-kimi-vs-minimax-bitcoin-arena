// A small Predictefy REST client that meters every call: path, status, time and credits charged.
// The key goes in the Authorization header and never into a log line.
import {secrets, UPGRADE_URL} from './env.mjs';

export const BASE = 'https://data.predictefy.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shorten = path => path.replace(/(outcomeId=)(\d{6})\d+(\d{4})/, '$1$2...$3');

export function createClient({onCall = () => {}, timeoutMs = 8000, retries = 2} = {}) {
  const key = secrets().PREDICTEFY_API_KEY;
  if (!key) throw new Error('PREDICTEFY_API_KEY is missing. Copy .env.example to .env and paste your key.');
  const totals = {calls: 0, credits: 0, remaining: null};
  async function get(path, {purpose = '', scope = null, tries = retries + 1} = {}) {
    let last = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      const started = Date.now();
      let status = 0, body = null, charged = 0, remaining = null, error = null;
      try {
        const res = await fetch(BASE + path, {headers: {authorization: `Bearer ${key}`}, signal: AbortSignal.timeout(timeoutMs)});
        status = res.status;
        charged = Number(res.headers.get('x-credits-charged') || 0);
        remaining = res.headers.get('x-credits-remaining');
        body = await res.json().catch(() => null);
        error = body?.error?.code || (res.ok ? null : `HTTP ${status}`);
      } catch (e) { error = e.name === 'TimeoutError' ? 'timeout' : String(e.message || e); }
      totals.calls++; totals.credits += charged; if (remaining != null) totals.remaining = Number(remaining);
      const row = {at: new Date(started).toISOString(), scope, path: shorten(path), purpose, status, ms: Date.now() - started, credits: charged, creditsRemaining: remaining == null ? null : Number(remaining), error, attempt};
      onCall(row);
      last = {ok: status >= 200 && status < 300 && body?.success !== false, status, data: body?.data ?? null, meta: body?.meta ?? null, error, row, upgradeUrl: status === 402 || error === 'PLAN_REQUIRED' ? UPGRADE_URL : null};
      if (last.ok) return last;
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt === tries) return last;
      await sleep(250 * attempt * attempt);
    }
    return last;
  }
  return {
    totals,
    marketBySlug: (slug, purpose, options) => get(`/api/polymarket/fetchMarkets?slug=${slug}&status=all&limit=1`, {purpose, ...options}),
    orderBook: (outcomeId, purpose, options) => get(`/api/polymarket/fetchOrderBook?outcomeId=${outcomeId}`, {purpose, ...options}),
    chainlinkRounds: (limit, purpose, options) => get(`/api/feeds/chainlink/fetchOracleHistory?symbol=BTC/USD&limit=${limit}`, {purpose, ...options}),
    usage: purpose => get('/v1/usage', {purpose}),
  };
}

export const formatCall = row => `[predictefy] GET ${row.path}  ${row.status || row.error}  ${row.ms} ms  ${row.credits} credit${row.credits === 1 ? '' : 's'}${row.purpose ? '  (' + row.purpose + ')' : ''}${row.error && row.status ? '  ' + row.error : ''}`;
