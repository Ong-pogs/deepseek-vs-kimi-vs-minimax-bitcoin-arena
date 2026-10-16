// Reads a version's reply. The same strict rule for all nine: one JSON object with a probability between 0 and 1
// and a call. Anything else is "no valid answer" and is scored as a coin flip.

function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

export function parseAnswer(text, {betRule = 'call'} = {}) {
  if (typeof text !== 'string' || !text.trim()) return {valid: false, error: 'empty reply'};
  const raw = firstJsonObject(text);
  if (!raw) return {valid: false, error: 'no JSON object in the reply'};
  let data;
  try { data = JSON.parse(raw); } catch { return {valid: false, error: 'the JSON did not parse'}; }
  const pUp = typeof data.p_up === 'number' ? data.p_up : typeof data.p_up === 'string' && data.p_up.trim() !== '' ? Number(data.p_up) : NaN;
  if (!Number.isFinite(pUp) || pUp < 0 || pUp > 1) return {valid: false, error: 'p_up is not a number between 0 and 1'};
  const call = String(data.call ?? '').trim().toLowerCase();
  const allowed = betRule === 'always' ? ['up', 'down'] : ['up', 'down', 'skip'];
  let finalCall = allowed.includes(call) ? call : null;
  let callNote = null;
  if (!finalCall && betRule === 'always') {
    // Every version must hold a side: with no usable call, the side its own probability favours is used.
    finalCall = pUp > 0.5 ? 'up' : pUp < 0.5 ? 'down' : 'skip';
    callNote = `call "${call || 'missing'}" replaced by the side p_up favours`;
  }
  if (!finalCall) return {valid: false, error: `call must be one of ${allowed.join(', ')}`};
  return {valid: true, pUp, call: finalCall, callNote, reason: String(data.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)};
}
