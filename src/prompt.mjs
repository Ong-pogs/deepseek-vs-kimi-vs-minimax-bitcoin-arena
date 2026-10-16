// The one prompt every version gets, word for word. Only the snapshot inside it changes from window to window.
import {createHash} from 'node:crypto';

export const SYSTEM_PROMPT = 'You are one contestant in a forecasting test. You get one snapshot of a 5-minute Bitcoin market and answer with a single JSON object. You have no tools and no memory of earlier rounds. Use only the snapshot and what you already know.';

export function buildPrompt({market, snapshot, config}) {
  const always = config.betRule === 'always';
  const lines = [
    `This is one round of a test. ${config.contestants?.length || 'Several'} AI models from different companies receive this exact message at the same moment and answer separately. None of them can see the others.`,
    '',
    'THE MARKET',
    `Polymarket's 5-minute market "${market.title}". A share of the winning side pays $1.00 when the window ends; a share of the losing side pays nothing.`,
    `Its rule, word for word: "${String(market.description || '').replace(/\s+/g, ' ').trim()}"`,
    '',
    'THE SNAPSHOT',
    `Taken ${snapshot.window.seconds_into_window} seconds into the window. Every number was read through the Predictefy API, and code did the arithmetic.`,
    JSON.stringify(snapshot, null, 1),
    '',
    'YOUR ANSWER',
    '1. p_up: your probability, between 0 and 1, that this market resolves Up.',
    always ? '2. call: "up" or "down", the side you would rather hold.' : '2. call: "up", "down" or "skip".',
    '',
    'HOW IT IS USED (the same rules for every model, enforced by code)',
    always
      ? `- The test places a $${config.stakeUsd} paper bet on the side you call, every round.`
      : `- If your call is "up" or "down", the test places a $${config.stakeUsd} paper bet on that side. "skip" places no bet.`,
    '- The bet is filled at the asks in the live order book at the moment your answer arrives, plus Polymarket\'s taker fee. If the price moved while you were thinking, you get the new price.',
    config.betCutoffSecond < config.answerDeadlineSecond
      ? `- An answer that arrives later than ${config.betCutoffSecond} seconds into the window is too late to bet. An answer that has not arrived by ${config.answerDeadlineSecond} seconds into the window is not counted at all.`
      : `- Your answer must arrive by ${config.answerDeadlineSecond} seconds into the window, which is ${config.answerDeadlineSecond - snapshot.window.seconds_into_window} seconds after this snapshot. After that there is no bet and the round is scored as no answer.`,
    '- You are scored on p_up in every round, whether or not a bet was placed, and on paper profit.',
    '',
    'Reply with one JSON object and nothing else:',
    always ? '{"p_up": 0.00, "call": "up or down", "reason": "one short sentence"}' : '{"p_up": 0.00, "call": "up, down or skip", "reason": "one short sentence"}',
  ];
  return lines.join('\n');
}

export const sha256 = text => createHash('sha256').update(text).digest('hex');
