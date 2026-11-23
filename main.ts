// Trend-rider + strict V-dip bot for the make.fun BTC race
// (agent-fun/bars-replay/v1). Trades cbBTC against USDC, long only,
// $1,000 paper money, one 1-minute bar at a time.
//
// How this bot was calibrated (offline simulator with the exact fill model
// from RULES.txt — 4 bps fee, 2 bps slippage, constant-product impact —
// then confirmed with the kit's own grade-local scorer):
//
//   window      BTC move   this bot    buy-and-hold
//   dev 23 Nov  +3.59%     +$16.33     +$32.17
//   18 Nov      -2.79%     +$19.36     -$31.63
//   15 Nov      -3.92%     +$ 3.51     -$44.01
//   13 Nov      -4.91%     -$11.73     -$52.59
//
// The dev window is the only one that gates entry (net PnL must be above
// $0), and the race window is unseen, so the design optimises the median
// across all four windows (+$9.92) and the worst window (-$11.73) instead
// of the dev window alone. Two entry shapes, each with its own exits:
//
// RIDE — a sustained rise, not a bounce. Buy full size when the close is
//   100+ bps above 60 bars ago AND 150+ bps above 240 bars ago. The
//   240-bar filter is what keeps dead-cat bounces in a falling market out:
//   on the 13 Nov window a 60-bar bounce of +100 bps fired with the
//   240-bar return at only +117 bps and lost $17; requiring +150 bps
//   blocks it while the 23 Nov rally (240-bar +209 bps at entry) still
//   passes. The ride has no take-profit: it holds through chop on a wide
//   300 bps trailing stop, so it can ride a multi-hour rally to the end
//   of the window, and only a -150 bps stop-loss cuts it.
// DIP — a sharp fall that stops. Buy full size when the close is 200+ bps
//   below 120 bars ago AND 20+ bps above the lowest close of the last
//   30 bars. Exits are tighter (take profit +200, stop -100, trail 100)
//   because a bounce in a downtrend is a short-lived recovery, not a
//   trend. This shape is what made money on the two falling windows
//   (+$19.36, +$3.51) while the same shape on the 13 Nov grind-down
//   lost only -$11.73.
// FALLBACK — insurance for the race's "at least 1 trade" guardrail. If
//   nothing has traded by bar 1260, take a quarter-size dip on the same
//   bounce shape but only while the 60-bar trend is not falling and the
//   240-bar trend is no worse than -100 bps.
//
// Discipline: at most 3 round trips a day, 60 bars of cooldown after every
// exit, so chop cannot whipsaw the bot into the 12-trade bleed that cost
// an earlier entry $51.26. Orders carry max_slippage_bps 100. Fills arrive
// one bar after the decision, at the next bar's open, so exits are measured
// against the fill price the harness reports, never against the close the
// order was decided on. All arithmetic is integer (bigint) on raw prices,
// so two runs agree exactly. No clock, no files, no network, no randomness.

import { BPS, runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Ride entry: 60-bar rise and the longer trend behind it.
const RIDE_LOOKBACK = 60;
const RIDE_MIN_BPS = 100n;
const RIDE_TREND_LOOKBACK = 240;
const RIDE_TREND_MIN_BPS = 150n;
// Ride exits: no take-profit, wide trail, hard stop.
const RIDE_STOP_BPS = -150n;
const RIDE_TRAIL_BPS = 300n;
// Dip entry: a sharp 120-bar fall, then a bounce off the 30-bar low.
const DIP_LOOKBACK = 120;
const DIP_MIN_BPS = 200n;
const LOW_LOOKBACK = 30;
const DIP_BOUNCE_BPS = 20n;
// Dip exits: fixed take-profit, tighter stop and trail.
const DIP_TAKE_PROFIT_BPS = 200n;
const DIP_STOP_BPS = -100n;
const DIP_TRAIL_BPS = 100n;
// Patience: bars to wait after an exit, and the most round trips per day.
const COOLDOWN_BARS = 60;
const MAX_ROUND_TRIPS = 3;
// Fallback: first bar at which an untraded bot may take a quarter-size dip.
const FALLBACK_BAR = 1260;
// Fallback bounce off the 30-bar low (stricter than the dip entry).
const FALLBACK_BOUNCE_BPS = 30n;
// Fallback guard: 240-bar return must be no worse than this.
const FALLBACK_TREND_MIN_BPS = -100n;
// Reject a fill more than this far past the close the order was decided on.
const MAX_SLIPPAGE_BPS = 100;

/** Raw closes, one per CBBTC bar, in order. */
const closes: bigint[] = [];
/** Raw fill price of the open position, or null when flat. */
let entryPrice: bigint | null = null;
/** Highest raw close seen since the fill. */
let peakClose: bigint | null = null;
/** 'ride' or 'dip' for the open position (fallback counts as a dip). */
let entryKind: 'ride' | 'dip' = 'dip';
/** Bar index of the last exit, for the cooldown. */
let lastExitBar = -1_000_000;
/** Round trips completed so far. */
let roundTrips = 0;

/** (now - then) in basis points, integer-truncated toward zero. */
function moveBps(now: bigint, then: bigint): bigint {
  return ((now - then) * BPS) / then;
}

/** Lowest close of the last `n` bars, excluding the latest bar. */
function trailingLow(n: number): bigint | null {
  if (closes.length <= n) return null;
  let low = closes[closes.length - 2];
  for (let k = 3; k <= n + 1; k++) {
    const c = closes[closes.length - k];
    if (c < low) low = c;
  }
  return low;
}

/** True when the latest close rose RIDE_MIN_BPS or more over RIDE_LOOKBACK bars. */
function strongRise(): boolean {
  if (closes.length <= RIDE_LOOKBACK) return false;
  return moveBps(closes[closes.length - 1], closes[closes.length - 1 - RIDE_LOOKBACK]) >= RIDE_MIN_BPS;
}

/** True when the longer trend behind the rise is genuinely up. */
function longTrendUp(): boolean {
  if (closes.length <= RIDE_TREND_LOOKBACK) return false;
  return moveBps(closes[closes.length - 1], closes[closes.length - 1 - RIDE_TREND_LOOKBACK]) >= RIDE_TREND_MIN_BPS;
}

/** True when the latest close fell DIP_MIN_BPS or more over DIP_LOOKBACK bars. */
function sharpDrop(): boolean {
  if (closes.length <= DIP_LOOKBACK) return false;
  return moveBps(closes[closes.length - 1], closes[closes.length - 1 - DIP_LOOKBACK]) <= -DIP_MIN_BPS;
}

/** True when the latest close bounced `minBps` or more off the trailing low. */
function bouncedOffLow(minBps: bigint): boolean {
  const low = trailingLow(LOW_LOOKBACK);
  if (low === null) return false;
  return moveBps(closes[closes.length - 1], low) >= minBps;
}

/** True when the 60-bar trend is not falling (fallback guard only). */
function trendNotFalling(): boolean {
  if (closes.length <= 60) return false;
  return moveBps(closes[closes.length - 1], closes[closes.length - 1 - 60]) > 0n;
}

/** True when the 240-bar trend is no worse than FALLBACK_TREND_MIN_BPS. */
function notInDeepDowntrend(): boolean {
  if (closes.length <= RIDE_TREND_LOOKBACK) return false;
  return moveBps(closes[closes.length - 1], closes[closes.length - 1 - RIDE_TREND_LOOKBACK]) > FALLBACK_TREND_MIN_BPS;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Record fills first: a buy fill opens the position at its fill price.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = BigInt(fill.price);
        peakClose = entryPrice;
      } else {
        entryPrice = null;
        peakClose = null;
      }
    }
    // Push this batch's bar (if CBBTC traded this minute).
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    const close = state.close(SYMBOL);
    if (close === null) return [];

    if (held !== undefined) {
      // We hold: manage the exit on the latest close.
      if (entryPrice === null) {
        // No fill seen (should not happen); anchor on the latest close.
        entryPrice = close;
        peakClose = close;
      }
      if (peakClose !== null && close > peakClose) peakClose = close;
      const ret = moveBps(close, entryPrice);
      let sell = false;
      if (entryKind === 'ride') {
        // Ride: no take-profit; only the stop and the wide trailing stop.
        if (ret <= RIDE_STOP_BPS) sell = true;
        else if (peakClose !== null && moveBps(peakClose, close) >= RIDE_TRAIL_BPS) sell = true;
      } else {
        // Dip (and fallback): take the profit, cut the loss, trail tight.
        if (ret >= DIP_TAKE_PROFIT_BPS) sell = true;
        else if (ret <= DIP_STOP_BPS) sell = true;
        else if (peakClose !== null && moveBps(peakClose, close) >= DIP_TRAIL_BPS) sell = true;
      }
      if (sell) {
        lastExitBar = state.seq;
        roundTrips += 1;
        const order: SellInput = {
          side: 'sell',
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [order];
      }
      return [];
    }

    // Flat: look for an entry, at most MAX_ROUND_TRIPS a day.
    if (roundTrips >= MAX_ROUND_TRIPS) return [];
    if (state.seq - lastExitBar < COOLDOWN_BARS) return [];
    let size: bigint | null = null;
    let kind: 'ride' | 'dip' = 'dip';
    if (strongRise() && longTrendUp()) {
      size = state.cash; // full size on the confirmed sustained rise
      kind = 'ride';
    } else if (sharpDrop() && bouncedOffLow(DIP_BOUNCE_BPS)) {
      size = state.cash; // full size on the confirmed V-bottom
      kind = 'dip';
    } else if (state.seq >= FALLBACK_BAR && roundTrips === 0 && trendNotFalling() && notInDeepDowntrend() && bouncedOffLow(FALLBACK_BOUNCE_BPS)) {
      size = state.cash / 4n; // quarter size, only to meet the 1-trade bar
      kind = 'dip';
    }
    if (size === null) return [];
    const room = state.weightRoom(SYMBOL);
    if (room < size) size = room;
    if (size < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryKind = kind;
    const order: BuyInput = {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: size,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
    return [order];
  },
});
