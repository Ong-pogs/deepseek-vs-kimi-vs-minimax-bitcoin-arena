// One clean model call through OpenRouter's chat completions API. The same request for every contestant; only
// "model" differs:
//
//   POST https://openrouter.ai/api/v1/chat/completions
//   {model, messages: [system, user], max_tokens, reasoning: {enabled: false}, usage: {include: true}}
//
// No tools, no conversation history, no web search, no thinking: one system message, one user message, one reply.
// (Thinking is off for every model, at the owner's request: faster and cheaper. settings.reasoningTokens turns it
// back on with that cap, for every model alike.)
// The reply carries what the call cost (usage.cost, in dollars) and which provider served it.
// Resolves with a record shaped like the Claude Code records of the earlier arena. Never rejects.
import {writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function requestBody({model, system, prompt, settings}) {
  return {
    model,
    messages: [{role: 'system', content: system}, {role: 'user', content: prompt}],
    max_tokens: settings.maxTokens,
    reasoning: reasoningOf(settings),
    temperature: settings.temperature,
    usage: {include: true},
  };
}
const reasoningOf = settings => (settings.reasoningTokens ? {max_tokens: settings.reasoningTokens} : {enabled: false});

// The request as a person would send it, for the notes, the dashboard and the README.
export function commandLine(settings) {
  return `POST ${OPENROUTER_URL}  {"model": "<model>", "messages": [system, user], "max_tokens": ${settings.maxTokens}, "reasoning": ${JSON.stringify(reasoningOf(settings))}, "temperature": ${settings.temperature}, "usage": {"include": true}}`;
}

export function callOpenRouter({apiKey, contestant, system, prompt, settings, deadlineMs, rawFile, roundStartMs, onAnswer}) {
  return new Promise(resolve => {
    const record = {
      id: contestant.id, model: contestant.model, effort: null,
      spawnedAtMs: Date.now(), firstOutputAtMs: null, answerAtMs: null, exitAtMs: null, exitCode: null,
      status: 'pending', statusDetail: null, text: null, init: null, result: null, rateLimit: null, limitStatuses: [], otherEvents: [], assistantModels: [], checks: null, stderr: '',
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineMs - Date.now()));
    const body = requestBody({model: contestant.model, system, prompt, settings});
    (async () => {
      let response, data = null, rawText = '';
      try {
        response = await fetch(OPENROUTER_URL, {
          method: 'POST', signal: controller.signal,
          headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'DeepSeek vs Kimi vs MiniMax Bitcoin arena'},
          body: JSON.stringify(body),
        });
        record.firstOutputAtMs = Date.now();
        rawText = await response.text();
        try { data = JSON.parse(rawText); } catch {}
      } catch (e) {
        record.exitAtMs = Date.now();
        if (e.name === 'AbortError') { record.status = 'timeout'; record.statusDetail = 'no answer by the deadline; the request was cancelled'; }
        else { record.status = 'error'; record.statusDetail = `the request failed: ${e.message}`; }
        return done();
      } finally { clearTimeout(timer); }
      record.exitAtMs = Date.now();
      record.exitCode = response.status;
      const choice = data?.choices?.[0];
      const message = choice?.message;
      const usage = data?.usage || null;
      record.result = {
        isError: !response.ok || !!data?.error || !message,
        subtype: choice?.finish_reason ?? null, apiErrorStatus: response.ok ? (data?.error?.code ?? null) : response.status,
        provider: data?.provider ?? null, modelReported: data?.model ?? null, generationId: data?.id ?? null, numTurns: 1,
        usage: usage ? {inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, thinkingTokens: usage.completion_tokens_details?.reasoning_tokens ?? null, cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null} : null,
        listPriceUsd: typeof usage?.cost === 'number' ? usage.cost : null,
      };
      if (data?.model && !record.assistantModels.includes(data.model)) record.assistantModels.push(data.model);
      if (!record.result.isError) {
        record.answerAtMs = record.exitAtMs;
        record.text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(p => p.text || '').join('') : '';
        record.reasoningText = typeof message.reasoning === 'string' ? message.reasoning.slice(0, 20000) : null;
        record.answerSeconds = roundStartMs != null ? Math.round((record.answerAtMs - roundStartMs) / 10) / 100 : null;
        record.status = 'ok';
        // The model the provider reported must be the one asked for (OpenRouter may add a date or provider suffix).
        const base = contestant.model.replace(/^~/, '').split(':')[0];
        record.checks = {modelReported: data.model ?? null, modelMatches: !data.model || data.model.startsWith(base) || data.model.startsWith(base.replace(/-\d{4}$/, '')), oneTurn: true, noTools: !(message.tool_calls?.length)};
        if (!record.checks.modelMatches || !record.checks.noTools) { record.status = 'error'; record.statusDetail = `the call was not clean; model reported: ${data.model}`; }
        else if (onAnswer) { try { onAnswer(record); } catch {} }
      } else {
        const code = response.status;
        const detail = data?.error?.message || rawText.slice(0, 200);
        // 402: the OpenRouter balance ran out. 429: rate limited. Both block the window for everyone.
        if (code === 402 || code === 429) { record.status = 'blocked'; record.statusDetail = `OpenRouter answered ${code}: ${detail}`; }
        else { record.status = 'error'; record.statusDetail = `OpenRouter answered ${code}${choice?.finish_reason ? ` (finish: ${choice.finish_reason})` : ''}: ${detail}`; }
      }
      done(rawText);
    })();
    function done(rawText = '') {
      if (rawFile) { try { mkdirSync(path.dirname(rawFile), {recursive: true}); writeFileSync(rawFile, JSON.stringify({request: {...body, messages: [{role: 'system', chars: system.length}, {role: 'user', chars: prompt.length}]}, httpStatus: record.exitCode, response: rawText.slice(0, 200000)}) + '\n'); } catch {} }
      const end = record.answerAtMs ?? record.exitAtMs;
      record.answerSeconds = record.answerAtMs != null && roundStartMs != null ? Math.round((record.answerAtMs - roundStartMs) / 10) / 100 : null;
      record.wallSeconds = end != null ? Math.round((end - record.spawnedAtMs) / 10) / 100 : null;
      resolve(record);
    }
  });
}
