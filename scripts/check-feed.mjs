#!/usr/bin/env node
/**
 * Local preflight. Answers two questions before anything gets deployed:
 *
 *   1. Does your FREE Twelve Data key actually return XAU/USD 15min candles?
 *   2. Do our EMA21/EMA50 match what TradingView plots on your chart?
 *
 * Usage:
 *   TWELVEDATA_KEY=xxxx node scripts/check-feed.mjs
 *   node scripts/check-feed.mjs            # Yahoo only
 *
 * Reads TWELVEDATA_KEY from the environment or from .dev.vars.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluate } from '../src/ema.js';
import { PROVIDERS } from '../src/providers/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDevVars() {
  try {
    const raw = readFileSync(join(root, '.dev.vars'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .dev.vars, fine */
  }
}

loadDevVars();

const cfg = {
  symbol: process.env.SYMBOL ?? 'XAU/USD',
  yahooSymbol: process.env.YAHOO_SYMBOL ?? 'GC=F',
  binanceSymbol: process.env.BINANCE_SYMBOL ?? 'XAUTUSDT',
  interval: process.env.INTERVAL ?? '15min',
  outputsize: 300,
  twelvedataKey: process.env.TWELVEDATA_KEY,
};
const fastLen = Number(process.env.FAST_LEN ?? 21);
const slowLen = Number(process.env.SLOW_LEN ?? 50);

const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

async function check(name) {
  const provider = PROVIDERS[name];
  console.log(`\n\x1b[1m${name}\x1b[0m — ${provider.label}`);

  if (name === 'twelvedata' && !cfg.twelvedataKey) {
    console.log('  SKIPPED: TWELVEDATA_KEY not set (put it in .dev.vars or the environment)');
    return null;
  }

  const t0 = Date.now();
  let candles;
  try {
    candles = await provider.fetch(cfg);
  } catch (err) {
    console.log(`  \x1b[31mFAILED\x1b[0m: ${err.message}`);
    if (name === 'twelvedata') {
      console.log('  → If this says the symbol needs a higher plan, set PROVIDER=yahoo in wrangler.toml.');
    }
    return null;
  }

  console.log(`  ok: ${candles.length} candles in ${Date.now() - t0}ms`);
  console.log(`  range: ${utc(candles[0].time)}  →  ${utc(candles.at(-1).time)}`);

  const ageMin = (Date.now() - candles.at(-1).time) / 60000;
  console.log(`  newest bar age: ${ageMin.toFixed(1)} min ${ageMin > 30 ? '\x1b[33m(stale — market closed?)\x1b[0m' : ''}`);

  console.log('  last 5 bars:');
  for (const c of candles.slice(-5)) {
    console.log(`    ${utc(c.time)}  O ${fmt(c.open)}  H ${fmt(c.high)}  L ${fmt(c.low)}  C ${fmt(c.close)}`);
  }

  const now = evaluate(candles, fastLen, slowLen);
  console.log(
    `  \x1b[1mEMA${fastLen}\x1b[0m ${fmt(now.fast)}   \x1b[1mEMA${slowLen}\x1b[0m ${fmt(now.slow)}   ` +
      `side \x1b[1m${now.side === 'bull' ? '\x1b[32mBULL' : '\x1b[31mBEAR'}\x1b[0m   gap ${now.gapPct.toFixed(4)}%`,
  );

  // Where was the most recent cross, per the closed bars we have?
  const closes = candles.map((c) => c.close);
  const { ema } = await import('../src/ema.js');
  const f = ema(closes, fastLen);
  const s = ema(closes, slowLen);
  for (let i = closes.length - 1; i > slowLen; i--) {
    const nowUp = f[i] > s[i];
    const prevUp = f[i - 1] > s[i - 1];
    if (Number.isFinite(f[i - 1]) && nowUp !== prevUp) {
      console.log(`  last cross: ${nowUp ? '\x1b[32mBUY' : '\x1b[31mSELL'}\x1b[0m at ${utc(candles[i].time)} (price ${fmt(closes[i])})`);
      break;
    }
  }

  return now;
}

const td = await check('twelvedata');
const yh = await check('yahoo');
const bn = await check('binance');

for (const [name, other] of [['yahoo', yh], ['binance', bn]]) {
  if (td && other) {
    console.log(
      `\nagreement twelvedata vs ${name}: ${td.side === other.side ? '\x1b[32mMATCH\x1b[0m' : '\x1b[33mDIFFER\x1b[0m'}` +
        ` (${td.side}/${other.side}), basis ${fmt(other.price - td.price)}`,
    );
  }
}

console.log('\nNow open your TradingView XAUUSD 15m chart and compare the EMA values above.');
if (!td && cfg.twelvedataKey) {
  console.log('Twelve Data failed with your key → set PROVIDER=yahoo (or binance) in wrangler.toml.');
} else if (!td) {
  console.log('Add TWELVEDATA_KEY to .dev.vars and re-run to confirm spot XAU/USD works on your free plan.');
}
