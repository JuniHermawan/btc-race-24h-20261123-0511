# btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/JuniHermawan/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/JuniHermawan/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A trend-rider + strict V-dip trading bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain prices with $1,000 of paper money. Two entry shapes, each with its own exits: a sustained-rise rider (buy when the close is 100+ bps above 60 bars ago and 150+ bps above 240 bars ago, no take-profit, wide 300 bps trailing stop) and a sharp-dip buyer (buy when the close is 200+ bps below 120 bars ago and 20+ bps off the 30-bar low, take profit +200 / stop -100 / trail 100). At most 3 round trips a day with a 60-bar cooldown, plus a quarter-size fallback trade late in the window so the entry always meets the 1-trade guardrail.

Calibrated on the published dev window and three earlier 24-hour windows (offline simulator with the exact fill model, confirmed with the kit's grade-local scorer): dev +$16.33, and +$19.36 / +$3.51 / -$11.73 on the three falling windows — median +$9.92, worst -$11.73. The dev gate needs net PnL above $0; the race window is unseen, so the bot optimises robustness across regimes instead of the dev window alone.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=0fj27dtd&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
