/**
 * Yahoo Finance chart API — no API key, no quota that we can hit.
 *
 * Symbol is GC=F (COMEX gold futures front month), NOT spot: it trades ~$30-50
 * above XAU/USD and pauses 17:00-18:00 ET. EMA cross TIMING tracks spot closely,
 * the absolute prices in the alert will not match your TradingView spot chart.
 */

const BASE = 'https://query2.finance.yahoo.com/v8/finance/chart/';

const INTERVAL_MAP = {
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '1h': '60m',
};

/**
 * @param {{symbol: string, interval: string}} opts
 * @returns {Promise<{time: number, open: number, high: number, low: number, close: number}[]>} oldest first
 */
export async function fetchCandles({ symbol, interval }) {
  const yInterval = INTERVAL_MAP[interval] ?? interval;
  const url = new URL(encodeURIComponent(symbol), BASE);
  url.searchParams.set('interval', yInterval);
  url.searchParams.set('range', '5d');

  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      // Yahoo rejects requests without a browser-ish UA.
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(`yahoo HTTP ${res.status}: ${body ? JSON.stringify(body).slice(0, 200) : res.statusText}`);
  }
  const result = body?.chart?.result?.[0];
  if (!result?.timestamp || !result?.indicators?.quote?.[0]) {
    throw new Error(`yahoo returned no candles${body?.chart?.error ? `: ${JSON.stringify(body.chart.error)}` : ''}`);
  }

  const q = result.indicators.quote[0];
  const candles = result.timestamp.map((t, i) => ({
    time: t * 1000,
    open: q.open?.[i],
    high: q.high?.[i],
    low: q.low?.[i],
    close: q.close?.[i],
  }));

  // Yahoo pads gaps with nulls, and its final "bar" is a partial snapshot of the
  // current minute — both are handled by dropping anything without a usable close.
  const clean = candles.filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0);
  clean.sort((a, b) => a.time - b.time);
  if (clean.length === 0) throw new Error('yahoo candles were all unusable');
  return clean;
}
