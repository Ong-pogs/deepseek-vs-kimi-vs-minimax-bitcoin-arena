# DeepSeek vs Kimi vs MiniMax: a Polymarket Bitcoin arena

Three flagship AI models from China's three AI labs, DeepSeek V4 Pro, Kimi K3 (Moonshot AI) and MiniMax M3, get the same Predictefy snapshot of Polymarket's 5-minute "Bitcoin Up or Down" market. They answer under one set of rules and paper-trade it, window after window.

**Built on [Predictefy](https://predictefy.com/en)**, the unified prediction market API: one key for Polymarket, Kalshi and 14 more venues. See the [API](https://predictefy.com/en/api?utm_source=github&utm_medium=repo&utm_campaign=deepseek-vs-kimi-vs-minimax&utm_content=readme-top), the [docs](https://docs.predictefy.com/), the [quickstart](https://docs.predictefy.com/quickstart/), [pricing](https://predictefy.com/en/pricing) and the [blog](https://blog.predictefy.com).

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

## Learn more on Predictefy

**Product**
- [Predictefy](https://predictefy.com/en): the prediction market terminal and API
- [Prediction Market API](https://predictefy.com/en/api?utm_source=github&utm_medium=repo&utm_campaign=deepseek-vs-kimi-vs-minimax&utm_content=readme-links): one API for every venue
- [Markets](https://predictefy.com/en/markets) · [Analytics](https://predictefy.com/en/analytics) · [Arbitrage terminal](https://predictefy.com/en/arbitrage) · [Positive EV](https://predictefy.com/en/price-gap) · [Calculators](https://predictefy.com/en/calculators) · [Build](https://predictefy.com/en/build)
- [Pricing and plans](https://predictefy.com/en/pricing) · [Get an API key](https://portal.predictefy.com/keys)

**Docs used by this arena**
- [Docs home](https://docs.predictefy.com/) · [Quickstart](https://docs.predictefy.com/quickstart/) · [Credits](https://docs.predictefy.com/guides/credits/)
- [fetchMarkets](https://docs.predictefy.com/api/operations/fetchmarkets/): find each 5-minute market by its slug
- [fetchOrderBook](https://docs.predictefy.com/api/operations/fetchorderbook/): the Up and Down books for the snapshot and every fill
- [fetchOracleHistory](https://docs.predictefy.com/api/operations/feedfetchoraclehistory/): Chainlink's BTC/USD rounds

**Bitcoin up/down markets**
- [How to Track 5 Minute Bitcoin Markets on Kalshi and Polymarket](https://blog.predictefy.com/how-to-track-5-minute-bitcoin-markets)
- [How to Track 15 Minute Bitcoin Markets on Kalshi and Polymarket](https://blog.predictefy.com/how-to-track-15-minute-bitcoin-markets)
- [Polymarket Price to Beat API: How to Get the Start Price](https://blog.predictefy.com/polymarket-price-to-beat-api)
- [Kalshi 15 Minute Bitcoin Bot: How to Build One With the API](https://blog.predictefy.com/kalshi-15-minute-bitcoin-bot)

**AI models and trading bots**
- [We Gave Claude Opus 5.5 and GPT-6 Sol $100 Each to Trade Polymarket Bitcoin](https://blog.predictefy.com/claude-opus-5-5-vs-gpt-6-sol-polymarket)
- [How to Use an LLM to Analyze Prediction Markets](https://blog.predictefy.com/how-to-use-an-llm-to-analyze-prediction-markets)
- [How to Build a Prediction Market Bot With Claude](https://blog.predictefy.com/prediction-market-trading-bot-claude)
- [Prediction Market MCP Servers and AI Agent Tools](https://blog.predictefy.com/prediction-market-ai-agent)
- [Polymarket MCP Server: Connect Claude to Live Markets](https://blog.predictefy.com/polymarket-mcp-server)
- [How to Build a Polymarket Trading Bot in Python](https://blog.predictefy.com/polymarket-trading-bot)
- [Polymarket Paper Trading: How to Practice for Free](https://blog.predictefy.com/polymarket-paper-trading)
- [Polymarket Whale Tracker: How to Track Big Wallets With the API](https://blog.predictefy.com/polymarket-whale-tracker)

**Polymarket and prediction market APIs**
- [Polymarket Order Book API: How to Get Live Depth](https://blog.predictefy.com/polymarket-order-book-api)
- [Polymarket CLOB API: Keys, Endpoints and Rate Limits](https://blog.predictefy.com/polymarket-clob-api)
- [Polymarket Gamma API](https://blog.predictefy.com/polymarket-gamma-api) · [Polymarket Data API](https://blog.predictefy.com/polymarket-data-api) · [Polymarket API Keys Explained](https://blog.predictefy.com/polymarket-api-key)
- [Polymarket API Python Tutorial](https://blog.predictefy.com/polymarket-api-python) · [Polymarket API Guide 2026](https://blog.predictefy.com/polymarket-api-guide)
- [Kalshi API vs Polymarket API: Which Should You Build On?](https://blog.predictefy.com/kalshi-api-vs-polymarket-api)
- [What Is a Prediction Market API?](https://blog.predictefy.com/what-is-a-prediction-market-api) · [Is There One API for All Prediction Markets?](https://blog.predictefy.com/is-there-one-api-for-all-prediction-markets)
- [How Do I Make My First Prediction Market API Call?](https://blog.predictefy.com/how-do-i-make-my-first-prediction-market-api-call)
- [Best Prediction Market Data API](https://blog.predictefy.com/best-prediction-market-data-api) · [7 Best Prediction Market APIs and SDKs in 2026](https://blog.predictefy.com/best-prediction-market-apis-sdks)
- [What Is Prediction Market Arbitrage?](https://blog.predictefy.com/what-is-prediction-market-arbitrage)

**Community:** [Predictefy Discord](https://discord.gg/KVrWkhD8S) · [Predictefy blog](https://blog.predictefy.com)

## License

MIT
