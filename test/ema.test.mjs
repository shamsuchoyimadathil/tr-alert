import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ema, evaluate, decide } from '../src/ema.js';

const close = (v, i) => ({ time: 1_700_000_000_000 + i * 900_000, close: v });
const series = (values) => values.map(close);

test('ema: warmup entries are NaN until the seed bar', () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(out[0]));
  assert.ok(Number.isNaN(out[1]));
  assert.equal(out[2], 2); // SMA(1,2,3)
});

test('ema: recursion matches hand computation', () => {
  // seed SMA(1,2,3) = 2; alpha = 2/4 = 0.5
  // bar 4: 0.5*4 + 0.5*2   = 3
  // bar 5: 0.5*5 + 0.5*3   = 4
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.equal(out[3], 3);
  assert.equal(out[4], 4);
});

test('ema: a flat series converges to the flat value', () => {
  const out = ema(new Array(100).fill(42), 21);
  assert.equal(out.at(-1), 42);
});

test('ema: too few values yields all NaN', () => {
  assert.ok(ema([1, 2], 21).every(Number.isNaN));
});

test('ema: rejects a bad length', () => {
  assert.throws(() => ema([1, 2, 3], 0), RangeError);
});

test('evaluate: reports the side from the fast/slow relationship', () => {
  const rising = series(Array.from({ length: 120 }, (_, i) => 100 + i));
  const r = evaluate(rising, 21, 50);
  assert.equal(r.side, 'bull');
  assert.ok(r.fast > r.slow);
  assert.equal(r.price, 219);

  const falling = series(Array.from({ length: 120 }, (_, i) => 300 - i));
  assert.equal(evaluate(falling, 21, 50).side, 'bear');
});

test('evaluate: refuses to guess without enough warmup', () => {
  assert.throws(() => evaluate(series(new Array(40).fill(10)), 21, 50), /need at least 51/);
});

const OPTS = { minGapPct: 0.02, cooldownMin: 10, sendFadeNotice: true, now: 1_000_000_000 };
const snap = (side, gapPct = 0.05, barTime = 500) => ({
  side,
  gapPct,
  barTime,
  price: 4400,
  fast: 4400,
  slow: 4399,
});

test('decide: first run primes state without alerting', () => {
  const out = decide(snap('bull'), {}, OPTS);
  assert.equal(out.action, 'none');
  assert.equal(out.nextState.alertedSide, 'bull');
});

test('decide: no cross means no alert', () => {
  const out = decide(snap('bull'), { alertedSide: 'bull', side: 'bull' }, OPTS);
  assert.equal(out.action, 'none');
});

test('decide: a separated cross alerts', () => {
  const out = decide(snap('bull', 0.05), { alertedSide: 'bear', side: 'bear' }, OPTS);
  assert.equal(out.action, 'buy');
  assert.equal(out.nextState.alertedSide, 'bull');
  assert.equal(out.nextState.alertedAt, OPTS.now);

  const down = decide(snap('bear', 0.05), { alertedSide: 'bull', side: 'bull' }, OPTS);
  assert.equal(down.action, 'sell');
});

test('decide: the gap filter DELAYS a cross rather than swallowing it', () => {
  const held = decide(snap('bull', 0.005), { alertedSide: 'bear', side: 'bear' }, OPTS);
  assert.equal(held.action, 'none');
  // Crucially, alertedSide is untouched, so the signal is still pending.
  assert.equal(held.nextState.alertedSide, 'bear');

  const fired = decide(snap('bull', 0.05), held.nextState, OPTS);
  assert.equal(fired.action, 'buy');
});

test('decide: reversal inside the same bar is a fade, not an opposite signal', () => {
  const state = { alertedSide: 'bull', side: 'bull', alertedAt: OPTS.now - 60_000, alertedBar: 500 };
  const out = decide(snap('bear', 0.05, 500), state, OPTS);
  assert.equal(out.action, 'fade');
  assert.equal(out.nextState.alertedSide, 'bear');
});

test('decide: the same reversal in a LATER bar is a real signal', () => {
  const state = { alertedSide: 'bull', side: 'bull', alertedAt: OPTS.now - 20 * 60_000, alertedBar: 500 };
  const out = decide(snap('bear', 0.05, 1400), state, OPTS);
  assert.equal(out.action, 'sell');
});

test('decide: cooldown suppresses rapid alternating alerts', () => {
  const state = { alertedSide: 'bull', side: 'bull', alertedAt: OPTS.now - 60_000, alertedBar: 100 };
  const out = decide(snap('bear', 0.05, 1400), state, OPTS);
  assert.equal(out.action, 'none');
  assert.match(out.reason, /cooldown/);
  assert.equal(out.nextState.alertedSide, 'bull'); // still pending
});

test('decide: a cross in the priming bar is a real signal, not a fade', () => {
  // Priming stamps alertedBar but never alerted, so there is nothing to fade.
  const primed = decide(snap('bear'), {}, OPTS).nextState;
  const out = decide(snap('bull', 0.05, primed.alertedBar), primed, OPTS);
  assert.equal(out.action, 'buy');
});

test('decide: fade notices can be switched off', () => {
  const state = { alertedSide: 'bull', side: 'bull', alertedAt: OPTS.now - 60_000, alertedBar: 500 };
  const out = decide(snap('bear', 0.05, 500), state, { ...OPTS, sendFadeNotice: false });
  assert.equal(out.action, 'none'); // falls through to cooldown
});
