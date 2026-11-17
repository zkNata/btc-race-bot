// Two-Horizon Dip Catcher — a BTC trading bot for make.fun btc-race-24h-20261117-0603.
//
// Paper-money only ($1,000 USDC, long-only, one position, replay of on-chain
// cbBTC/USDC 1-minute bars). Nothing here trades for real, connects anywhere,
// or signs anything.
//
// Strategy — patient dip-buying, confirmed on two horizons, with very few trades:
// BTC's 1-minute bars on the dev window are a near random walk with a small
// positive drift (+0.49% over the dev day) and ~26 bps of round-trip cost, so
// anything that trades often dies on fees — the kit's own ema-cross baseline
// lost $106 on the dev window by whipsawing 68 times. Winners of the five
// finished BTC races all bought sharp dips with FEW trades (1 trade won the
// 15 Nov race, 4 trades won the 9 Nov race), so this bot waits for a flush
// that is confirmed on TWO horizons before it buys 100% of cash:
//   * dip: the last 3-minute return is below -30 bps AND the last 15-minute
//     return is below -60 bps (a flush, not a wobble — the 9 Nov winner was
//     literally "confirmed recoveries at two horizons").
//   * momentum burst: the last 1-minute return is above +35 bps
//     (a 5.5-sigma minute; 1-min returns are positively autocorrelated at
//     lag 1, +0.15 on the dev window, so a burst tends to carry).
// Exits, measured from the close the buy was decided on:
//   * stop-loss at -0.50% (losers are cut fast);
//   * take-profit at +1.50% (the two dev-window winners peaked at +1.61% and
//     +1.52% — TP 1.35% is the documented runner-up, -5% on dev);
//   * ratchet: once the trade has peaked at +1.00% or more, sell if it
//     retraces to +0.50% (banks a small win instead of sliding to the stop
//     when a move peaks just under the take-profit).
// A 5-bar cooldown follows every buy decision. If the day is so quiet that
// no buy has filled by bar 1350 and the bot is flat, it buys 10% of cash
// once anyway: that guarantees at least one trade (the race guardrail asks
// for one) at roughly a tenth of the cost of a blind full-size bet — a
// full-size fallback buy at bar 1200 lost $9.87 on the dev window's flat
// second half, the 10% version at bar 1350 lost $0.31.
//
// What the grid search actually showed (exact replica of the harness fill
// math, validated to the unit against official grade-local on this bot and
// on buy-and-hold / momentum):
//   * gentler dips LOSE: -15bp/3m dip -$27.03, -20bp -$30.27, -25bp -$0.01
//     (shallow bounces cannot cover the ~26 bps round-trip cost).
//   * sliced/tranche buying LOSES: 50/50 tranches turned +$14.62 into +$8.97
//     (halving the size on the big winners).
//   * trailing stops LOSE: a 0.5% trail turned +$22.83 into +$0.96.
//   * a trend filter (no dip-buy when the 60-min return is under -1%) never
//     bound on the dev window: dropped, unmeasured complexity.
// Dev-window result (official grade-local, process driver): net PnL
// +$22.83 after all fees, 4 trades (2 round trips), max drawdown 0.86%,
// fees $1.62. Split as two independent halves: +$14.25 / -$0.31 — the
// second half's -$0.31 is ONLY the tiny fallback trade; the signals made
// $0.00 there because the second half is flat (-0.01% drift) with no sharp
// flush at all. That is the honest limit of this edge: on a burst-free day
// it sits in cash. Dev PnL overstates race-day PnL (past winners: dev
// 24.71 -> final 12.74 USDC), so treat +$22.83 as a gate pass with margin,
// not a forecast.
//
// Determinism: every decision comes from the closes the harness sent and
// the account it reports. No clock, no environment, no randomness, no
// network, no files. The same feed gives the same orders, byte for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** 1-minute return above this buys (momentum burst). */
const MOMENTUM_BPS = 0.0035;
/** 3-minute return below this buys (dip, first horizon). */
const DIP_BPS = 0.003;
/** 15-minute return below this buys (dip, second horizon — confirmation). */
const DIP2_BPS = 0.006;
/** Stop-loss and take-profit, as a share of the entry close. */
const STOP_LOSS = 0.005;
const TAKE_PROFIT = 0.015;
/** Ratchet: once the trade peaked at least this far, sell on a retrace to RATCHET_FLOOR. */
const RATCHET_ARM = 0.01;
const RATCHET_FLOOR = 0.005;
/** Bars to wait after a buy decision before the next buy. */
const COOLDOWN_BARS = 5;
/** Closes needed before any signal is trusted (covers the 15-minute window). */
const MIN_HISTORY = 15;
/** Fallback: if no buy has filled by this bar, buy 10% of cash once anyway. */
const FALLBACK_BAR = 1350;
const FALLBACK_PCT = 10n;
/** Slippage cap on every order (fill price vs latest close). */
const MAX_SLIPPAGE_BPS = 100;
/** Minimum buy notional, 1 USDC in quote units (from hello.fees). */
const MIN_NOTIONAL = 1_000_000n;

/** Closes of CBBTC in arrival order, as raw price units (scale cancels in returns). */
const closes: number[] = [];
/** Close the current position's buy was decided on (raw units). */
let entryClose = 0;
/** Highest close seen since the current entry (raw units). */
let peakClose = 0;
/** Bar index before which no new buy is decided. */
let coolUntil = -1;
/** Filled buys so far (drives the fallback). */
let filledBuys = 0;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && fill.side === 'buy' && fill.symbol === SYMBOL) filledBuys++;
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(Number(bar.c));
    const k = closes.length - 1;
    if (k < MIN_HISTORY) return [];

    const close = closes[k]!;
    const pos = state.positions.get(SYMBOL);
    const held = pos !== undefined && pos.qty > 0n;

    if (held) {
      if (close > peakClose) peakClose = close;
      const pnl = close / entryClose - 1;
      const peakPnl = peakClose / entryClose - 1;
      if (pnl <= -STOP_LOSS || pnl >= TAKE_PROFIT || (peakPnl >= RATCHET_ARM && pnl <= RATCHET_FLOOR)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (k < coolUntil) return [];
    const r1 = close / closes[k - 1]! - 1;
    const r3 = close / closes[k - 3]! - 1;
    const r15 = close / closes[k - 15]! - 1;
    const burst = r1 > MOMENTUM_BPS;
    const dip = r3 < -DIP_BPS && r15 < -DIP2_BPS;
    const fallback = filledBuys === 0 && k >= FALLBACK_BAR;
    if (!burst && !dip && !fallback) return [];
    if (state.cash < MIN_NOTIONAL) return [];
    entryClose = close;
    peakClose = close;
    coolUntil = k + 1 + COOLDOWN_BARS;
    const notional = fallback ? (state.cash * FALLBACK_PCT) / 100n : state.cash;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
