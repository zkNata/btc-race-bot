# Two-Horizon Dip Catcher — btc-race-bot

[![make.fun bounty](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![live rank](https://make.fun/badge/btc-race-24h-20261117-0603/zkNata/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![live reward](https://make.fun/badge/btc-race-24h-20261117-0603/zkNata/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

Entry for the [make.fun bounty Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603).

A trading bot for the make.fun bounty **Race a BTC trading bot live for
24 hours** (`btc-race-24h-20261117-0603`). It trades Coinbase Wrapped BTC
(CBBTC) against USDC, minute by minute, starting from $1,000 of paper
money, long-only, in the `agent-fun/bars-replay/v1` replay.

Repo: `btc-race-bot`, owner `zkNata`. Entry point: `main.ts` (Node 22,
standard library only). The wire protocol is handled by the kit's SDK
shim, copied byte-for-byte into `vendor/makefun-bars.ts`.

## Strategy

BTC's 1-minute bars are close to a random walk with a small positive drift
(+0.49% over the dev day) and ~26 bps of round-trip cost, so anything that
trades often dies on fees — the kit's own ema-cross baseline lost $106 on
the dev window by whipsawing 68 times. Winners of the five finished BTC
races all bought sharp dips with FEW trades (1 trade won the 15 Nov race,
4 trades won the 9 Nov race), so this bot waits for a flush confirmed on
TWO horizons before buying 100% of cash:

- **Buy 100% of cash** on either signal (after at least 15 closes):
  - *Two-horizon dip:* the last 3-minute return is below **-30 bps** AND
    the last 15-minute return is below **-60 bps** (a flush, not a
    wobble — the 9 Nov race winner was literally "confirmed recoveries at
    two horizons").
  - *Momentum burst:* the last 1-minute return is above **+35 bps**
    (1-min returns are positively autocorrelated at lag 1, +0.15 on the
    dev window, so a burst tends to carry).
- **Sell everything** when the close moves **-0.50%** (stop-loss) or
  **+1.50%** (take-profit) from the close the buy was decided on.
- **Ratchet:** once a trade has peaked at +1.00% or more, sell if it
  retraces to +0.50% — banks a small win instead of sliding to the stop
  when a move peaks just under the take-profit. Free insurance on dev
  (never bound), protective on a new day.
- A 5-bar cooldown follows every buy decision.
- **Fallback:** if no buy has filled by bar 1350 and the bot is flat, it
  buys **10% of cash** once anyway — that guarantees at least one trade
  (the race guardrail asks for one) at roughly a tenth of the cost of a
  blind full-size bet. A full-size fallback at bar 1200 lost $9.87 on the
  dev window's flat second half; the 10% version at bar 1350 lost $0.31.
- `max_slippage_bps` is 100 on every order.

What was tested and REJECTED on the dev window (exact replica of the
harness fill math, validated to the unit against official `grade-local`):
gentler dips lose (-15bp/3m: -$27.03; -20bp: -$30.27; shallow bounces
cannot cover ~26 bps round-trip cost); 50/50 tranche buying loses
(+$14.62 → +$8.97); trailing stops lose (0.5% trail: +$22.83 → +$0.96);
a 60-min trend filter never bound on dev and was dropped as unmeasured
complexity; a time-based exit (sell after 120 bars) loses (+$22.83 →
+$15.27).

## Dev-window results (official `grade-local`, process driver)

| Metric | Value |
|---|---|
| Net PnL (after all fees) | **+$22.83** |
| First half / second half (independent halves) | +$14.25 / -$0.31 |
| Trades | 4 (2 round trips) |
| Max drawdown | 0.86% |
| Fees paid | $1.62 |
| Determinism (two runs, action logs byte-identical) | reproduced ✓ |

Honest caveats: the profit comes from two winning trades (bars 491→514,
+1.61%; bars 550→936, +1.52%); the two-horizon confirmation removed the
one losing trade the earlier single-horizon version took. The second
half's -$0.31 is ONLY the tiny fallback trade — the signals made $0.00
there because the second half is flat (-0.01% drift) with no sharp flush
at all. The edge is real but lumpy: it needs flushes to work, and on a
flush-free day it sits in cash. Dev PnL overstates race-day PnL (past
winners: dev 24.71 → final 12.74 USDC), so treat +$22.83 as a gate pass
with margin, not a forecast. The bot is deterministic: every decision
comes from the closes the harness sent and the account it reports — no
clock, no environment, no randomness, no network, no files.

## Layout

- `main.ts` — the bot (strategy + wire-up).
- `vendor/makefun-bars.ts` — the kit's SDK shim, byte-for-byte.
- `LICENSE` — MIT.
