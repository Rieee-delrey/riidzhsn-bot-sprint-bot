![competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)
![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Rieee-delrey/riidzhsn-bot-sprint-bot/rank.svg)
![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Rieee-delrey/riidzhsn-bot-sprint-bot/reward.svg)

# riidzhsn-bot-sprint-bot

A launch sniper for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun.

## Strategy

Watch every new pump.fun bonding curve from its CreateEvent and buy once per
coin, within 3 slots of creation, only when the opening tape shows a real
crowd: at least 4 distinct non-creator buyers, at least 3 trades, net buy
flow of at least 12 SOL over the last 5 slots, the creator still holding (no
creator sell, creator buys at most 2.5 SOL), and real SOL reserves between
0.3 and 30 SOL. The flow bar was swept on the dev data (6/8/10/12/14 SOL):
12 SOL is where the net peaks; hotter still leaves too few coins.

Stake 0.3 SOL per coin in a single buy (whatever the per-batch reserve cap
allows in one order), retried while the entry window is open if it is
rejected or its transaction fails, but never topped up: building the stake
past the first piece buys the top of a spike that is about to mean-revert,
and every form of that lost money on the dev data. Take profit at +10%,
stop loss at -20%, max hold 10 slots, and exit immediately if the creator
sells while holding. Never buy the same mint twice.

The bot is deterministic: every decision is a pure function of the event
batches, with no clock, no randomness, and no I/O.

## Run

```sh
node main.ts
```

It speaks agent-fun/replay/v2 on stdin/stdout; see `vendor/agentfun-bot.ts`
for the wire protocol.
