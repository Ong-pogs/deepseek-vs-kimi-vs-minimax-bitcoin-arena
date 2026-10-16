# DeepSeek vs Kimi vs MiniMax: a Polymarket Bitcoin arena

Three flagship AI models from China's three AI labs, DeepSeek V4 Pro, Kimi K3 (Moonshot AI) and MiniMax M3, get the same Predictefy snapshot of Polymarket's 5-minute "Bitcoin Up or Down" market. They answer under one set of rules and paper-trade it, window after window.

- **Same request for all three.** Every call goes through OpenRouter with one system message and one user message. There are no tools, no web search, no memory of earlier rounds, and thinking is off (`reasoning: {enabled: false}`). Only `"model"` changes.
- **Every fact from Predictefy.** At 45 seconds into each window, one snapshot reads the market, both order books and Chainlink's BTC/USD rounds through the [Predictefy API](https://predictefy.com/en/api?utm_source=github&utm_medium=repo&utm_campaign=deepseek-vs-kimi-vs-minimax&utm_content=readme): 4 calls, 13 credits.
- **Paper bets at the live order book.** A call of up or down is a flat $50 bet from a $1,000 paper bankroll. It fills at the asks read through Predictefy when the answer arrives, plus Polymarket's taker fee, and settles on Polymarket's published result. No real orders and no wallet.
- **Three plain rules** play alongside: a random pick, the market favourite, and Bitcoin's direction since the open.
- **A spend cap.** The run stops before OpenRouter spend would pass the cap in `config/arena.json` (default $10).

## The recorded run (2026-10-16, 36 windows)

| | Right way | Brier | Paper profit | Bets |
|---|---|---|---|---|
| MiniMax M3 | 81.9% | 0.153 | +$396.49 | 35 |
| DeepSeek V4 Pro | 77.8% | 0.169 | +$351.36 | 34 |
| Kimi K3 | 80.6% | 0.198 | +$95.26 | 21 |
| Bitcoin's direction (rule) | 80.6% | n/a | +$378.10 | 36 |
| Market favourite (rule) | 75.0% | 0.173 | +$122.98 | 36 |
| Random pick | 38.9% | n/a | −$547.54 | 36 |

- **Cost:** 108 model calls cost $0.19 on OpenRouter (Kimi $0.128, DeepSeek $0.043, MiniMax $0.018). Predictefy used 1,345 credits, about 37 a window.
- **Luck:** none of the three differs from the market favourite by more than luck allows over 36 windows.

## What you need

- Node.js 22.12 or newer
- An [OpenRouter](https://openrouter.ai) key with a dollar or two on it
- A Predictefy API key from [portal.predictefy.com/keys](https://portal.predictefy.com/keys). The free plan's 25,000 credits a month cover about 55 hours of this test. Running it around the clock uses about 320,000 credits a month, which needs the Pro plan.

## Run it

```bash
cp .env.example .env          # put both keys in it
node src/cli.mjs check        # one live snapshot through Predictefy, no model calls
node src/cli.mjs pilot        # a short trial (2 windows) in its own folder
node src/cli.mjs launch       # the full run in the background (36 windows by default)
node src/cli.mjs dashboard    # http://127.0.0.1:8831
node src/cli.mjs status       # or stop / resume
```

The models, caps, stake, bankroll and number of windows are in `config/arena.json`. `providerIgnore` skips OpenRouter providers that were measured to ignore "thinking off": they think until the token cap and return no answer.

## License

MIT
