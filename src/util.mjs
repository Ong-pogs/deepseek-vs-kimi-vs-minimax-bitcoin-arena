// Small helpers shared by the runner: a seeded random source, timing and safe file writes.
import {writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, appendFileSync} from 'node:fs';
import path from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
export const sleepUntil = ms => sleep(ms - Date.now());

// Deterministic random numbers from a saved seed, so every shuffle and every random baseline pick can be replayed.
export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffled(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

export function writeJson(file, data) {
  mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, file); return; } catch (e) { if (attempt >= 5) throw e; const until = Date.now() + 40; while (Date.now() < until); }
  }
}
export const readJson = (file, fallback = null) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; } };
export const appendLine = (file, data) => { mkdirSync(path.dirname(file), {recursive: true}); appendFileSync(file, (typeof data === 'string' ? data : JSON.stringify(data)) + '\n'); };

export const clock = (ms = Date.now()) => new Date(ms).toISOString().slice(11, 19);
export const windowStart = (ms, windowSeconds) => Math.floor(ms / 1000 / windowSeconds) * windowSeconds;
