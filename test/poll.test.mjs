import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { poll } from '../src/index.js';

/** Minimal in-memory stand-in for a KV namespace. */
function fakeKV() {
  const store = new Map();
  return {
    store,
    writes: 0,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      this.writes += 1;
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

/** Candles whose fast EMA sits clearly above/below the slow one. */
function candles(direction, { bars = 200, base = 4400, step = 1.5 } = {}) {
  const startTime = Date.UTC(2026, 8, 16, 0, 0, 0);
  return Array.from({ length: bars }, (_, i) => {
    const drift = direction === 'up' ? i * step : -i * step;
    const close = base + drift;
    return {
      datetime: new Date(startTime + i * 900_000).toISOString().replace('T', ' ').slice(0, 19),
      open: String(close),
      high: String(close),
      low: String(close),
      close: String(close),
    };
  });
}

const sent = [];
let realFetch;

beforeEach(() => {
  sent.length = 0;
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub network: Twelve Data returns `values`, Telegram records the message. */
function stubNetwork(values, { tdFails = false } = {}) {
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('twelvedata.com')) {
      if (tdFails) {
        return new Response(JSON.stringify({ status: 'error', code: 403, message: 'plan gated' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'ok', values }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch to ${href}`);
  };
}

function makeEnv(overrides = {}) {
  return {
    STATE: fakeKV(),
    PROVIDER: 'twelvedata',
    TWELVEDATA_KEY: 'test-key',
    TELEGRAM_TOKEN: 'test-token',
    TELEGRAM_CHAT_ID: '123',
    TRIGGER_SECRET: 'shh',
    IGNORE_MARKET_HOURS: 'true',
    COOLDOWN_MIN: '0',
    ...overrides,
  };
}

// A Wednesday 14:30 UTC — inside the session — used as "now" for freshness checks.
const marketOpenNow = Date.UTC(2026, 8, 16, 14, 30, 0);
const lastBarNow = (values) => Date.parse(`${values.at(-1).datetime.replace(' ', 'T')}Z`) + 60_000;

test('poll: skips entirely while the market is closed', async () => {
  const env = makeEnv({ IGNORE_MARKET_HOURS: 'false' });
  stubNetwork(candles('up'));
  const result = await poll(env, { now: Date.UTC(2026, 8, 19, 12, 0, 0) }); // Saturday
  assert.equal(result.skipped, true);
  assert.equal(sent.length, 0);
  assert.equal(env.STATE.writes, 0);
});

test('poll: first run primes state silently, second run is quiet too', async () => {
  const env = makeEnv();
  const values = candles('up');
  stubNetwork(values);
  const now = lastBarNow(values);

  const first = await poll(env, { now });
  assert.equal(first.action, 'none');
  assert.match(first.reason, /priming/);
  assert.equal(sent.length, 0);

  const second = await poll(env, { now: now + 120_000 });
  assert.equal(second.action, 'none');
  assert.equal(sent.length, 0);
  // Nothing changed on the second poll, so no KV write was spent.
  assert.equal(env.STATE.writes, 1);
});

test('poll: a genuine cross sends one BUY and does not repeat', async () => {
  const env = makeEnv();
  const down = candles('down');
  stubNetwork(down);
  const now = lastBarNow(down);
  await poll(env, { now }); // prime as bear

  const up = candles('up');
  stubNetwork(up);
  const crossAt = lastBarNow(up);
  const crossed = await poll(env, { now: crossAt });

  assert.equal(crossed.action, 'buy');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /BUY/);
  assert.match(sent[0].text, /EMA21 crossed ABOVE EMA50/);

  const again = await poll(env, { now: crossAt + 120_000 });
  assert.equal(again.action, 'none');
  assert.equal(sent.length, 1, 'must not re-alert the same cross');
});

test('poll: stale candles are treated as a feed failure, not a signal', async () => {
  const env = makeEnv({ FAIL_ALERT_AFTER: '1' });
  const values = candles('up');
  stubNetwork(values);
  // "now" is hours past the newest bar.
  const result = await poll(env, { now: lastBarNow(values) + 6 * 3600_000 });
  assert.equal(result.failed, true);
  assert.match(result.error, /stale/);
  assert.match(sent[0].text, /Feed problem/);
});

test('poll: failures only alert after the configured streak, then recover', async () => {
  const env = makeEnv({ FAIL_ALERT_AFTER: '3', PROVIDER: 'twelvedata' });
  stubNetwork([], { tdFails: true });

  for (let i = 1; i <= 2; i++) {
    const r = await poll(env, { now: marketOpenNow });
    assert.equal(r.failed, true);
    assert.equal(sent.length, 0, `no alert at failure ${i}`);
  }

  const third = await poll(env, { now: marketOpenNow });
  assert.equal(third.failStreak, 3);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Feed problem/);

  // Feed comes back.
  const values = candles('up');
  stubNetwork(values);
  const ok = await poll(env, { now: lastBarNow(values) });
  assert.equal(ok.recovered, true);
  assert.match(sent.at(-1).text, /Feed recovered/);
});

test('poll: force=buy sends a labelled test message without touching state', async () => {
  const env = makeEnv();
  const values = candles('up');
  stubNetwork(values);

  const result = await poll(env, { now: lastBarNow(values), force: 'buy' });
  assert.equal(result.test, true);
  assert.match(sent[0].text, /test message/);
  assert.equal(env.STATE.writes, 0);
});

test('poll: falls back to another provider when the primary fails', async () => {
  const env = makeEnv({ FAIL_ALERT_AFTER: '99' });
  const values = candles('up');
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('twelvedata.com')) return new Response('nope', { status: 500 });
    if (href.includes('finance.yahoo.com')) {
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                timestamp: values.map((v) => Date.parse(`${v.datetime.replace(' ', 'T')}Z`) / 1000),
                indicators: {
                  quote: [
                    {
                      open: values.map((v) => Number(v.open)),
                      high: values.map((v) => Number(v.high)),
                      low: values.map((v) => Number(v.low)),
                      close: values.map((v) => Number(v.close)),
                    },
                  ],
                },
              },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch to ${href}`);
  };

  const result = await poll(env, { now: lastBarNow(values) });
  assert.equal(result.provider, 'yahoo');
  assert.equal(result.fellBack, true);
});
