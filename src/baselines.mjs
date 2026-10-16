// Three rules that are not AI, shown as grey reference lines. They see the same snapshot, answer instantly,
// always bet when they have a side, and are filled at the snapshot's own order book under the same stake and fee.
import {mulberry32, hashSeed} from './util.mjs';

export const BASELINES = [
  {id: 'random', label: 'Random pick', rule: 'Up or Down from a random number generator with a saved seed.'},
  {id: 'favourite', label: 'Market favourite', rule: 'Whichever side the order book prices above 50 cents at the snapshot. Its probability is the market\'s own Up price.'},
  {id: 'momentum', label: 'Bitcoin\'s direction', rule: 'Up if the Chainlink price is above its value at the window\'s open, Down if below.'},
];

// facts: {upMid, changeSinceOpenUsd}
export function baselinePicks(facts, seed, t0) {
  const random = mulberry32(hashSeed(seed, 'baseline-random', t0))();
  return {
    random: {side: random < 0.5 ? 'up' : 'down', pUp: null, detail: `random number ${random.toFixed(4)}`},
    favourite: {side: facts.upMid == null || facts.upMid === 0.5 ? null : facts.upMid > 0.5 ? 'up' : 'down', pUp: facts.upMid, detail: `Up mid ${facts.upMid}`},
    momentum: {side: !facts.changeSinceOpenUsd ? null : facts.changeSinceOpenUsd > 0 ? 'up' : 'down', pUp: null, detail: `Chainlink change since open ${facts.changeSinceOpenUsd}`},
  };
}
