// Launch sniper for pump.fun bonding curves.
//
// Idea: a brand-new coin's opening tape tells you whether a crowd is actually
// showing up. We watch every CreateEvent, and only step in while the coin is
// still minutes old (within 3 slots of creation) when the first trades show
// real dispersed buying: several different buyers, several trades, strong net
// buy flow over the last 5 slots, and a creator who is still holding instead
// of dumping or loading up. We risk a fixed 0.3 SOL per coin, take profit at
// +15%, cut at -20%, never hold longer than 10 slots, and dump immediately if
// the creator sells while we hold.
//
// Deterministic by construction: every decision is a pure function of the
// event batches the harness hands us. No clock, no randomness, no I/O, and
// every map is walked in insertion order.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type ChainEvent,
  type OrderInput,
} from './vendor/agentfun-bot.ts';

// ------------------------------------------------------------------ tuning

// Fixed stake per coin.
const STAKE_LAMPORTS = 300_000_000n; // 0.3 SOL
// Smallest buy piece we will send; the harness caps each batch's buys on one
// mint at 1% of its real SOL reserve, so a small coin's stake is built up in
// pieces across batches instead of all at once.
const MIN_PIECE_LAMPORTS = 2_000_000n; // 0.002 SOL
// How many buy pieces one entry may be split into at most.
const MAX_SPLITS = 6;
// Entry window: the coin must still be this fresh when we first buy it.
const ENTRY_WINDOW_SLOTS = 3;
// Flow filter, all measured on the coin's tape since its CreateEvent.
const MIN_BUYERS = 4; // distinct non-creator buyers
const MIN_TRADES = 3; // trades of either side
const MIN_NET_FLOW_LAMPORTS = 8n * LAMPORTS_PER_SOL; // net buys, last 5 slots
const FLOW_WINDOW_SLOTS = 5;
const MAX_CREATOR_BUYS_LAMPORTS = 2_500_000_000n; // 2.5 SOL
// Real SOL reserves must sit inside this band at entry time.
const MIN_REAL_SOL_LAMPORTS = 300_000_000n; // 0.3 SOL
const MAX_REAL_SOL_LAMPORTS = 30n * LAMPORTS_PER_SOL; // 30 SOL
// Exits, measured against the virtual price (SOL per token) at entry.
const TAKE_PROFIT_NUM = 115n; // +15%
const STOP_LOSS_NUM = 80n; // -20%
const PRICE_DEN = 100n;
const MAX_HOLD_SLOTS = 10;
// Both sides accept any fill the harness offers.
const SLIPPAGE_BPS = 10_000;

// ------------------------------------------------------------- per-coin tape

interface Tape {
  creator: string;
  createdSlot: number;
  buyers: Set<string>;
  trades: number;
  creatorBuys: bigint;
  creatorSold: boolean;
  // Signed SOL flow per slot: buys add, sells subtract.
  flowBySlot: Map<number, bigint>;
}

// One entry plan: the stake we are still trying to build, the slot we
// entered on (for the max-hold clock), and the virtual price (SOL per
// token) at the moment we decided to enter. Profit and loss are measured
// against that decision-time price: on a fast coin the burst that made the
// tape hot is the move to bank, and waiting for +15% over the (later, higher)
// fill price just lets the coin retrace to the stop.
interface Entry {
  remaining: bigint;
  splits: number;
  entrySlot: number;
  priceNum: bigint; // virtual quote reserves at first buy decision
  priceDen: bigint; // virtual token reserves at first buy decision
}

const tapes = new Map<string, Tape>();
const entries = new Map<string, Entry>();
// Mints we have already bought (or are buying): never enter the same coin twice.
const bought = new Set<string>();
// Mints we exited: if a late buy fill lands after the exit, sell it too.
const exited = new Set<string>();

function tapeFor(mint: string, creator: string, createdSlot: number): Tape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = {
      creator,
      createdSlot,
      buyers: new Set<string>(),
      trades: 0,
      creatorBuys: 0n,
      creatorSold: false,
      flowBySlot: new Map<number, bigint>(),
    };
    tapes.set(mint, tape);
  }
  return tape;
}

function foldEvent(event: ChainEvent): void {
  if (event.event === 'CreateEvent') {
    tapeFor(event.mint, event.creator, event.slot);
    return;
  }
  if (event.event !== 'TradeEvent') return;
  const tape = tapes.get(event.mint);
  if (tape === undefined) return;
  const amount = BigInt(event.sol_amount);
  tape.trades += 1;
  if (event.is_buy) {
    if (event.user !== tape.creator) tape.buyers.add(event.user);
    if (event.user === tape.creator) tape.creatorBuys += amount;
  } else if (event.user === tape.creator) {
    tape.creatorSold = true;
  }
  const signed = event.is_buy ? amount : -amount;
  tape.flowBySlot.set(event.slot, (tape.flowBySlot.get(event.slot) ?? 0n) + signed);
}

// Net buy flow over the last FLOW_WINDOW_SLOTS slots, inclusive of this one.
function recentFlow(tape: Tape, slot: number): bigint {
  let total = 0n;
  for (const [at, flow] of tape.flowBySlot) {
    if (at > slot - FLOW_WINDOW_SLOTS && at <= slot) total += flow;
    if (at <= slot - FLOW_WINDOW_SLOTS) tape.flowBySlot.delete(at);
  }
  return total;
}

// Current virtual price of a mint, SOL per token, as a ratio. Null when the
// curve has no usable reserves.
function priceOf(state: BotState, mint: string): { num: bigint; den: bigint } | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_quote_reserves <= 0n || curve.virtual_token_reserves <= 0n) return null;
  return { num: curve.virtual_quote_reserves, den: curve.virtual_token_reserves };
}

// a/b >= c/d, cross-multiplied so no floating point ever appears.
function atLeast(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): boolean {
  return aNum * bDen >= bNum * aDen;
}

// --------------------------------------------------------------------- bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    // Mints already ordered in this reply: the harness caps all buys on one
    // mint in one reply together, so a second buy for the same mint in the
    // same batch would only be rejected.
    const ordered = new Set<string>();

    // Take the new tape in first, so this slot's trades count for decisions
    // made on this same batch.
    for (const event of batch.events) foldEvent(event);

    // --- exits: sell everything that hit a rule, before spending anything new.
    for (const [mint, holding] of state.positions) {
      const tape = tapes.get(mint);
      const entry = entries.get(mint);
      // A buy that filled after we already exited this mint: dump the orphan.
      if (entry === undefined) {
        if (exited.has(mint)) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: SLIPPAGE_BPS,
          });
          ordered.add(mint);
        }
        continue;
      }
      if (tape === undefined) continue;
      const price = priceOf(state, mint);
      let exit = false;
      // The creator sold while we hold: get out now.
      if (tape.creatorSold) exit = true;
      // Never hold longer than MAX_HOLD_SLOTS past the entry slot.
      if (!exit && slot - entry.entrySlot >= MAX_HOLD_SLOTS) exit = true;
      // Take profit / stop loss against the decision-time price.
      if (!exit && price !== null) {
        if (atLeast(price.num, price.den, entry.priceNum * TAKE_PROFIT_NUM, entry.priceDen * PRICE_DEN)) exit = true;
        if (!exit && atLeast(entry.priceNum * STOP_LOSS_NUM, entry.priceDen * PRICE_DEN, price.num, price.den)) exit = true;
      }
      if (exit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        ordered.add(mint);
        entries.delete(mint);
        exited.add(mint);
      }
    }

    // --- entries: fresh coins whose opening tape shows a real crowd.
    // Count buys placed in this batch too: pending only updates after we
    // return, so committedPositionCount() alone would let one batch open
    // more than the cap.
    let committed = state.committedPositionCount();
    if (committed < state.hello.caps.max_open_positions) {
      for (const [mint, tape] of tapes) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (committed >= state.hello.caps.max_open_positions) break;
        if (bought.has(mint)) continue;
        if (slot - tape.createdSlot > ENTRY_WINDOW_SLOTS) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (tape.trades < MIN_TRADES) continue;
        if (tape.buyers.size < MIN_BUYERS) continue;
        if (tape.creatorSold) continue;
        if (tape.creatorBuys > MAX_CREATOR_BUYS_LAMPORTS) continue;
        if (recentFlow(tape, slot) < MIN_NET_FLOW_LAMPORTS) continue;
        const realSol = curve.real_quote_reserves;
        if (realSol < MIN_REAL_SOL_LAMPORTS || realSol > MAX_REAL_SOL_LAMPORTS) continue;
        const price = priceOf(state, mint);
        if (price === null) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_PIECE_LAMPORTS) continue;
        if (state.freeCashLamports() < MIN_PIECE_LAMPORTS) continue;
        const piece = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        const spend = piece < state.freeCashLamports() ? piece : state.freeCashLamports();
        if (spend < MIN_PIECE_LAMPORTS) continue;
        bought.add(mint);
        entries.set(mint, {
          remaining: STAKE_LAMPORTS - spend,
          splits: 1,
          entrySlot: slot,
          priceNum: price.num,
          priceDen: price.den,
        });
        committed += 1;
        ordered.add(mint);
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: spend,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }

    // --- top-ups: keep building an open entry toward the full stake, one
    // piece per batch, while the per-batch reserve cap allows a real piece.
    // A plan whose first buy was rejected or failed simply retries here
    // while the entry is still young; a plan whose position was sold is
    // already gone from entries, so it never tops up.
    for (const [mint, entry] of entries) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (ordered.has(mint)) continue;
      if (entry.remaining < MIN_PIECE_LAMPORTS) continue;
      if (entry.splits >= MAX_SPLITS) continue;
      if (slot - entry.entrySlot > MAX_HOLD_SLOTS) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const tape = tapes.get(mint);
      if (tape !== undefined && tape.creatorSold) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_PIECE_LAMPORTS) continue;
      if (state.freeCashLamports() < MIN_PIECE_LAMPORTS) continue;
      let piece = cap < entry.remaining ? cap : entry.remaining;
      if (piece > state.freeCashLamports()) piece = state.freeCashLamports();
      if (piece < MIN_PIECE_LAMPORTS) continue;
      entry.remaining -= piece;
      entry.splits += 1;
      ordered.add(mint);
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: piece,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }

    return orders;
  },
});
