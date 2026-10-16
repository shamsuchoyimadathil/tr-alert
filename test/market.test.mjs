import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketStatus, isMarketOpen } from '../src/market.js';

// EDT (UTC-4) during these dates, so 17:00 ET = 21:00 UTC.
const at = (iso) => new Date(iso);

test('Saturday is closed all day', () => {
  assert.equal(isMarketOpen(at('2026-09-19T12:00:00Z')), false);
  assert.equal(isMarketOpen(at('2026-09-19T23:00:00Z')), false);
});

test('Sunday opens at 18:00 ET', () => {
  assert.equal(isMarketOpen(at('2026-09-20T21:00:00Z')), false); // 17:00 ET
  assert.equal(isMarketOpen(at('2026-09-20T22:00:00Z')), true); // 18:00 ET
});

test('Friday closes at 17:00 ET', () => {
  assert.equal(isMarketOpen(at('2026-09-18T20:00:00Z')), true); // 16:00 ET
  assert.equal(isMarketOpen(at('2026-09-18T21:30:00Z')), false); // 17:30 ET
});

test('weekdays pause for the 17:00-18:00 ET break', () => {
  assert.equal(isMarketOpen(at('2026-09-16T21:30:00Z')), false); // Wed 17:30 ET
  assert.equal(isMarketOpen(at('2026-09-16T22:30:00Z')), true); // Wed 18:30 ET
  assert.match(marketStatus(at('2026-09-16T21:30:00Z')).reason, /break/);
});

test('London and New York sessions are open', () => {
  assert.equal(isMarketOpen(at('2026-09-16T09:00:00Z')), true);
  assert.equal(isMarketOpen(at('2026-09-16T14:30:00Z')), true);
});

test('EST (winter) shifts the boundary with the timezone, not against it', () => {
  // January: ET is UTC-5, so 17:00 ET = 22:00 UTC.
  assert.equal(isMarketOpen(at('2026-01-14T21:30:00Z')), true); // 16:30 ET
  assert.equal(isMarketOpen(at('2026-01-14T22:30:00Z')), false); // 17:30 ET break
});
