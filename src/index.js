import { evaluate, decide } from './ema.js';
import { marketStatus } from './market.js';
import { fetchWithFallback, getProvider } from './providers/index.js';
import { readState, writeState, clearState } from './state.js';
import {
  sendMessage,
  formatSignal,
  formatFade,
  formatFailure,
  formatRecovery,
} from './telegram.js';

/** Newest candle older than this means the feed is stale, not merely quiet. */
const STALE_AFTER_MIN = 45;

function config(env) {
  const chain = String(env.PROVIDER ?? 'twelvedata')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Always keep a fallback behind the primary, without duplicating it.
  for (const fallback of ['twelvedata', 'yahoo', 'binance']) {
    if (!chain.includes(fallback)) chain.push(fallback);
  }

  return {
    // No key means Twelve Data can only ever fail — don't waste a hop on it.
    chain: chain.filter((name) => name !== 'twelvedata' || env.TWELVEDATA_KEY),
    symbol: env.SYMBOL ?? 'XAU/USD',
    yahooSymbol: env.YAHOO_SYMBOL ?? 'GC=F',
    binanceSymbol: env.BINANCE_SYMBOL ?? 'XAUTUSDT',
    interval: env.INTERVAL ?? '15min',
    outputsize: Number(env.OUTPUTSIZE ?? 300),
    fastLen: Number(env.FAST_LEN ?? 21),
    slowLen: Number(env.SLOW_LEN ?? 50),
    minGapPct: Number(env.MIN_GAP_PCT ?? 0.02),
    cooldownMin: Number(env.COOLDOWN_MIN ?? 10),
    sendFadeNotice: String(env.SEND_FADE_NOTICE ?? 'true') === 'true',
    failAlertAfter: Number(env.FAIL_ALERT_AFTER ?? 3),
    ignoreMarketHours: String(env.IGNORE_MARKET_HOURS ?? 'false') === 'true',
    twelvedataKey: env.TWELVEDATA_KEY,
    token: env.TELEGRAM_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  };
}

/**
 * One poll: fetch, compute, decide, maybe alert, persist.
 * @returns {Promise<object>} a log-friendly summary
 */
export async function poll(env, { force = null, now = Date.now() } = {}) {
  const cfg = config(env);
  const status = marketStatus(new Date(now));

  if (!status.open && !cfg.ignoreMarketHours && !force) {
    return { skipped: true, reason: status.reason };
  }

  const state = await readState(env.STATE);

  let fetched;
  try {
    fetched = await fetchWithFallback(cfg.chain, cfg);
  } catch (err) {
    return handleFailure(env, cfg, state, err.message, now);
  }

  const { provider, candles, fellBack } = fetched;
  const ageMin = (now - candles.at(-1).time) / 60000;
  if (ageMin > STALE_AFTER_MIN) {
    return handleFailure(
      env,
      cfg,
      state,
      `${provider} returned stale data — newest bar is ${ageMin.toFixed(0)} min old`,
      now,
    );
  }

  let snapshot;
  try {
    snapshot = evaluate(candles, cfg.fastLen, cfg.slowLen);
  } catch (err) {
    return handleFailure(env, cfg, state, err.message, now);
  }

  const meta = {
    symbol: cfg.symbol,
    interval: cfg.interval,
    fastLen: cfg.fastLen,
    slowLen: cfg.slowLen,
    provider: getProvider(provider).label,
    fellBack,
  };

  // Manual test trigger: send the message, touch nothing.
  if (force === 'buy' || force === 'sell') {
    await sendMessage({
      token: cfg.token,
      chatId: cfg.chatId,
      text: formatSignal(force, snapshot, { ...meta, test: true }),
    });
    return { test: true, sent: force, provider, snapshot };
  }

  const recovered = state.failStreak >= cfg.failAlertAfter;
  const outcome = decide(snapshot, state, {
    minGapPct: cfg.minGapPct,
    cooldownMin: cfg.cooldownMin,
    sendFadeNotice: cfg.sendFadeNotice,
    now,
  });

  if (outcome.action === 'buy' || outcome.action === 'sell') {
    await sendMessage({
      token: cfg.token,
      chatId: cfg.chatId,
      text: formatSignal(outcome.action, snapshot, meta),
    });
  } else if (outcome.action === 'fade') {
    await sendMessage({ token: cfg.token, chatId: cfg.chatId, text: formatFade(snapshot, meta) });
  }

  if (recovered) {
    await sendMessage({ token: cfg.token, chatId: cfg.chatId, text: formatRecovery(meta.provider) });
  }

  const wrote = await writeState(env.STATE, state, {
    ...outcome.nextState,
    failStreak: 0,
    failNotifiedAt: null,
  });

  return {
    provider,
    fellBack,
    action: outcome.action,
    reason: outcome.reason,
    price: snapshot.price,
    fast: snapshot.fast,
    slow: snapshot.slow,
    gapPct: snapshot.gapPct,
    side: snapshot.side,
    barTime: new Date(snapshot.barTime).toISOString(),
    stateWritten: wrote,
    recovered,
  };
}

async function handleFailure(env, cfg, state, message, now) {
  const failStreak = (state.failStreak ?? 0) + 1;
  let notified = state.failNotifiedAt;

  // Alert once when we cross the threshold, then at most hourly while still broken.
  const dueAgain = !notified || now - notified > 3600_000;
  if (failStreak >= cfg.failAlertAfter && dueAgain) {
    try {
      await sendMessage({
        token: cfg.token,
        chatId: cfg.chatId,
        text: formatFailure(failStreak, message),
      });
      notified = now;
    } catch (err) {
      console.error('could not deliver failure alert:', err.message);
    }
  }

  await writeState(env.STATE, state, { ...state, failStreak, failNotifiedAt: notified });
  console.error(`poll failed (${failStreak}): ${message}`);
  return { failed: true, failStreak, error: message };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      poll(env)
        .then((result) => console.log(JSON.stringify(result)))
        .catch((err) => console.error('unhandled poll error:', err.stack ?? err.message)),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const state = await readState(env.STATE);
      const status = marketStatus();
      return json({ ok: true, market: status, state });
    }

    // Everything below mutates or sends — gate it.
    if (url.searchParams.get('secret') !== env.TRIGGER_SECRET || !env.TRIGGER_SECRET) {
      return json({ error: 'forbidden' }, 403);
    }

    if (url.pathname === '/trigger') {
      const force = url.searchParams.get('force');
      const result = await poll(env, { force });
      return json(result);
    }

    if (url.pathname === '/reset') {
      await clearState(env.STATE);
      return json({ ok: true, reset: true });
    }

    return json({ error: 'not found', paths: ['/health', '/trigger', '/reset'] }, 404);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
