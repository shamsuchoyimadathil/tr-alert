/**
 * EMA + crossover state, ported from the Pine script:
 *
 *   ema21 = ta.ema(close, 21)
 *   ema50 = ta.ema(close, 50)
 *   buy   = ta.crossover(ema21, ema50)
 *   sell  = ta.crossunder(ema21, ema50)
 *
 * Pine seeds ta.ema with the SMA of the first `length` values, then recurses.
 * With ~300 bars of warmup the seed choice is worth well under 0.01% of price.
 */

/**
 * @param {number[]} values close prices, oldest first
 * @param {number} length
 * @returns {number[]} same length as `values`; the first `length - 1` entries are NaN
 */
export function ema(values, length) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array');
  if (!Number.isInteger(length) || length < 1) throw new RangeError('length must be a positive integer');

  const out = new Array(values.length).fill(NaN);
  if (values.length < length) return out;

  const alpha = 2 / (length + 1);

  let seed = 0;
  for (let i = 0; i < length; i++) seed += values[i];
  seed /= length;

  out[length - 1] = seed;
  let prev = seed;
  for (let i = length; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Evaluate the current state of the pair, INCLUDING the still-forming last candle.
 *
 * @param {{time: number, close: number}[]} candles oldest first; last one may be forming
 * @param {number} fastLen
 * @param {number} slowLen
 * @returns {{price: number, fast: number, slow: number, side: 'bull'|'bear', gapPct: number, barTime: number}}
 */
export function evaluate(candles, fastLen, slowLen) {
  if (!candles || candles.length < slowLen + 1) {
    throw new Error(`need at least ${slowLen + 1} candles, got ${candles ? candles.length : 0}`);
  }

  const closes = candles.map((c) => c.close);
  const fastSeries = ema(closes, fastLen);
  const slowSeries = ema(closes, slowLen);

  const i = closes.length - 1;
  const fast = fastSeries[i];
  const slow = slowSeries[i];
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) {
    throw new Error('EMA warmup incomplete — not enough candles');
  }

  const price = closes[i];
  return {
    price,
    fast,
    slow,
    side: fast > slow ? 'bull' : 'bear',
    gapPct: (Math.abs(fast - slow) / price) * 100,
    barTime: candles[i].time,
  };
}

/**
 * Decide what to do given the freshly evaluated state and what we last saw.
 *
 * Decisions compare against `alertedSide` — the side we last told the user about —
 * not against the previous poll's raw side. That way the gap filter DELAYS a cross
 * until the lines separate rather than swallowing it.
 *
 * @param {ReturnType<typeof evaluate>} current
 * @param {{side?: string, alertedSide?: string, alertedAt?: number, alertedBar?: number}} state
 * @param {{minGapPct: number, cooldownMin: number, sendFadeNotice: boolean, now: number}} opts
 * @returns {{action: 'none'|'buy'|'sell'|'fade', reason: string, nextState: object}}
 */
export function decide(current, state, opts) {
  const { minGapPct, cooldownMin, sendFadeNotice, now } = opts;
  const base = { ...state, side: current.side };

  // First ever run: adopt the current side silently. We have no idea when the last
  // real cross happened, so alerting here would be a lie.
  if (!state.alertedSide) {
    return {
      action: 'none',
      reason: `priming state on first run (${current.side})`,
      nextState: { ...base, alertedSide: current.side, alertedBar: current.barTime },
    };
  }

  if (current.side === state.alertedSide) {
    return { action: 'none', reason: `no cross (${current.side})`, nextState: base };
  }

  // The lines have crossed relative to what we last reported, but may still be glued
  // together. Hold the alert without touching alertedSide, so it fires once they part.
  if (current.gapPct < minGapPct) {
    return {
      action: 'none',
      reason: `cross to ${current.side} held: gap ${current.gapPct.toFixed(4)}% < ${minGapPct}%`,
      nextState: base,
    };
  }

  // Reversed inside the very same forming bar as the alert we sent: that is a repaint,
  // report it as a fade and re-arm rather than firing a full opposite signal.
  // `alertedAt` guards this: priming also stamps alertedBar, but sent no alert to fade.
  if (sendFadeNotice && state.alertedAt && state.alertedBar === current.barTime) {
    return {
      action: 'fade',
      reason: `cross faded back to ${current.side} inside the same bar`,
      nextState: { ...base, alertedSide: current.side, alertedAt: now },
    };
  }

  const sinceLast = state.alertedAt ? (now - state.alertedAt) / 60000 : Infinity;
  if (sinceLast < cooldownMin) {
    return {
      action: 'none',
      reason: `cooldown active (${sinceLast.toFixed(1)}m < ${cooldownMin}m)`,
      nextState: base,
    };
  }

  return {
    action: current.side === 'bull' ? 'buy' : 'sell',
    reason: `fast EMA crossed ${current.side === 'bull' ? 'above' : 'below'} slow EMA`,
    nextState: {
      ...base,
      alertedSide: current.side,
      alertedAt: now,
      alertedBar: current.barTime,
    },
  };
}
