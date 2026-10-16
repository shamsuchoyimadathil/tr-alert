/**
 * Twelve Data — spot XAU/USD ("Gold Spot").
 * Free plan: 800 API credits/day, 8 requests/minute. time_series costs 1 credit
 * per request regardless of outputsize.
 */

const BASE = 'https://api.twelvedata.com/time_series';

/**
 * @param {{symbol: string, interval: string, outputsize: number, apiKey: string}} opts
 * @returns {Promise<{time: number, open: number, high: number, low: number, close: number}[]>} oldest first
 */
export async function fetchCandles({ symbol, interval, outputsize, apiKey }) {
  if (!apiKey) throw new Error('TWELVEDATA_KEY is not set');

  const url = new URL(BASE);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', String(outputsize));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('order', 'ASC');
  url.searchParams.set('apikey', apiKey);

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(`twelvedata HTTP ${res.status}: ${body ? JSON.stringify(body).slice(0, 200) : res.statusText}`);
  }
  // Twelve Data answers 200 + {status:"error"} for plan-gated symbols and bad keys.
  if (!body || body.status === 'error') {
    throw new Error(`twelvedata error ${body?.code ?? '?'}: ${body?.message ?? 'unknown'}`);
  }
  if (!Array.isArray(body.values) || body.values.length === 0) {
    throw new Error('twelvedata returned no candles');
  }

  const candles = body.values.map((v) => ({
    time: parseDatetime(v.datetime),
    open: Number(v.open),
    high: Number(v.high),
    low: Number(v.low),
    close: Number(v.close),
  }));

  return normalize(candles);
}

/** "2026-09-20 14:15:00" (intraday) or "2026-09-20" (daily) — always UTC, we asked for it. */
function parseDatetime(dt) {
  const iso = dt.includes(' ') ? dt.replace(' ', 'T') : `${dt}T00:00:00`;
  return Date.parse(`${iso}Z`);
}

function normalize(candles) {
  const clean = candles.filter(
    (c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0,
  );
  clean.sort((a, b) => a.time - b.time);
  if (clean.length === 0) throw new Error('twelvedata candles were all unusable');
  return clean;
}
