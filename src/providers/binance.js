/**
 * Binance klines for XAUT/USDT (Tether Gold — 1 token = 1 troy oz of gold).
 *
 * Last-resort fallback. No API key, no IP reputation problems from cloud hosts,
 * weight-based limits we come nowhere near. It is NOT spot XAU/USD: it trades at
 * a small premium/discount and is thinner, so wicks differ. Use it to stay alive
 * during a Twelve Data outage, not as a permanent primary.
 */

const BASE = 'https://api.binance.com/api/v3/klines';

const INTERVAL_MAP = {
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '1h': '1h',
};

/**
 * @param {{symbol: string, interval: string, outputsize: number}} opts
 * @returns {Promise<{time: number, open: number, high: number, low: number, close: number}[]>} oldest first
 */
export async function fetchCandles({ symbol = 'XAUTUSDT', interval, outputsize = 300 }) {
  const url = new URL(BASE);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', INTERVAL_MAP[interval] ?? interval);
  url.searchParams.set('limit', String(Math.min(outputsize, 1000)));

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(`binance HTTP ${res.status}: ${body ? JSON.stringify(body).slice(0, 200) : res.statusText}`);
  }
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error('binance returned no candles');
  }

  // [ openTime, open, high, low, close, volume, closeTime, ... ]
  const candles = body.map((k) => ({
    time: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
  }));

  const clean = candles.filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0);
  clean.sort((a, b) => a.time - b.time);
  if (clean.length === 0) throw new Error('binance candles were all unusable');
  return clean;
}
