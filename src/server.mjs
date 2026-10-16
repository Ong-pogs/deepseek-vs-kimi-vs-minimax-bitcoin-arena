// The dashboard server. It serves the files in public/ and one JSON state:
// the live run's state, or a saved state file when replaying (for filming).
import http from 'node:http';
import {readFileSync, existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {ROOT} from './env.mjs';
import {buildState} from './state.mjs';
import {readJson} from './util.mjs';

const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'};

export function startServer({runDir, port = 8821, replay = null}) {
  const publicDir = path.join(ROOT, 'public');
  const getState = () => {
    if (replay) { const state = readJson(replay); return state ? {...state, replay: {file: path.basename(replay), savedAt: state.generatedAt}} : {error: `replay file not found: ${replay}`}; }
    if (!existsSync(path.join(runDir, 'config.json'))) return {error: `no run in ${runDir} yet`};
    const file = path.join(runDir, 'state.json');
    try { if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 4000) return readJson(file); } catch {}
    return buildState(runDir);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') {
      let body; try { body = JSON.stringify(getState()); } catch (e) { body = JSON.stringify({error: String(e.message || e)}); }
      res.writeHead(200, {'content-type': TYPES['.json'], 'cache-control': 'no-store'}); return res.end(body);
    }
    const file = path.normalize(path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(publicDir) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, {'content-type': 'text/plain'}); return res.end('not found'); }
    res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(readFileSync(file));
  });
  server.listen(port, '127.0.0.1', () => console.log(`Dashboard: http://localhost:${port}  (${replay ? 'replaying ' + replay : 'live from ' + runDir})`));
  return server;
}
