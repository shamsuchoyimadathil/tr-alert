import * as twelvedata from './twelvedata.js';
import * as yahoo from './yahoo.js';
import * as binance from './binance.js';

/**
 * Each provider gets the config it needs and returns normalized candles,
 * oldest first, with a numeric epoch-ms `time`.
 */
export const PROVIDERS = {
  twelvedata: {
    label: 'Twelve Data (spot XAU/USD)',
    defaultSymbol: 'XAU/USD',
    fetch: (cfg) =>
      twelvedata.fetchCandles({
        symbol: cfg.symbol,
        interval: cfg.interval,
        outputsize: cfg.outputsize,
        apiKey: cfg.twelvedataKey,
      }),
  },
  yahoo: {
    label: 'Yahoo Finance (GC=F gold futures)',
    defaultSymbol: 'GC=F',
    fetch: (cfg) =>
      yahoo.fetchCandles({
        symbol: cfg.yahooSymbol ?? 'GC=F',
        interval: cfg.interval,
      }),
  },
  binance: {
    label: 'Binance (XAUT/USDT tokenized gold)',
    defaultSymbol: 'XAUTUSDT',
    fetch: (cfg) =>
      binance.fetchCandles({
        symbol: cfg.binanceSymbol ?? 'XAUTUSDT',
        interval: cfg.interval,
        outputsize: cfg.outputsize,
      }),
  },
};

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`unknown provider "${name}" (have: ${Object.keys(PROVIDERS).join(', ')})`);
  return p;
}

/**
 * Fetch from the primary provider, falling back to the next one on failure.
 *
 * @param {string[]} chain provider names, most-preferred first
 * @param {object} cfg
 * @returns {Promise<{provider: string, candles: object[], fellBack: boolean, errors: string[]}>}
 */
export async function fetchWithFallback(chain, cfg) {
  const errors = [];
  for (const [i, name] of chain.entries()) {
    try {
      const candles = await getProvider(name).fetch(cfg);
      return { provider: name, candles, fellBack: i > 0, errors };
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`all providers failed — ${errors.join(' | ')}`);
}
