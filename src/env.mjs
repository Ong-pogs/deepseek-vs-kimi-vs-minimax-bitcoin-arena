// Paths and secrets. The Predictefy and OpenRouter keys are read from .env and never printed.
// A different key file can be named with ARENA_ENV_FILE or with "envFile" in config/local.json (which git ignores).
import {readFileSync, existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readLocal = () => { const file = path.join(ROOT, 'config', 'local.json'); try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; } };

let cached = null;
export function secrets() {
  if (cached) return cached;
  const files = [path.join(ROOT, '.env'), readLocal().envFile, process.env.ARENA_ENV_FILE].filter(Boolean);
  const merged = {};
  for (const file of files) if (existsSync(file)) Object.assign(merged, parseEnv(readFileSync(file, 'utf8')));
  cached = {PREDICTEFY_API_KEY: process.env.PREDICTEFY_API_KEY || merged.PREDICTEFY_API_KEY || '', OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || merged.OPENROUTER_API_KEY || ''};
  return cached;
}

export function loadConfig(file = path.join(ROOT, 'config', 'arena.json')) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const {envFile, ...overrides} = readLocal();
  return {...config, ...overrides};
}

export const UPGRADE_URL = 'https://predictefy.com/en/api?utm_source=github&utm_medium=repo&utm_campaign=deepseek-vs-kimi-vs-minimax&utm_content=upgrade';
