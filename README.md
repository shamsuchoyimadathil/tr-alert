# tr-bot — XAUUSD 15m EMA 21/50 crossover alerts to Telegram

A port of this Pine script, running outside TradingView so you don't need a paid plan for webhooks:

```pine
ema21 = ta.ema(close, 21)
ema50 = ta.ema(close, 50)
buy   = ta.crossover(ema21, ema50)
sell  = ta.crossunder(ema21, ema50)
```

A Cloudflare Worker polls 15m XAU/USD candles every 2 minutes, computes EMA21/EMA50 **including the
still-forming candle**, and pushes a BUY/SELL message to your Telegram chat the moment the lines
cross — it does not wait for the bar to close.

Everything runs on free tiers: Cloudflare Workers + KV, a free Twelve Data key, Telegram Bot API.

---

## 1. Get your keys (about 5 minutes)

**Telegram bot**

1. Open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts.
2. Copy the token it gives you (`123456789:AA...`).
3. Send any message (e.g. `hi`) to your new bot — a bot cannot message you first.
4. Get your chat id:
   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
   ```

**Twelve Data** — sign up at [twelvedata.com](https://twelvedata.com/register) (free, no card) and copy
the API key. Free plan: 800 credits/day, 8 requests/minute. We use ~720/day.

## 2. Check the feed before deploying anything

```bash
cp .dev.vars.example .dev.vars   # then fill in TWELVEDATA_KEY
npm install
npm run check
```

This prints the last 5 candles, EMA21, EMA50, the current side and the most recent cross for every
provider. **Open your TradingView XAUUSD 15m chart and compare the EMA values** — they should agree
to within a fraction of a dollar. That comparison is the real proof the port is correct.

If Twelve Data reports that the symbol needs a higher plan, set `PROVIDER = "yahoo"` (or
`"binance"`) in `wrangler.toml`. Nothing else changes.

## 3. Deploy

```bash
npx wrangler login
npx wrangler kv namespace create STATE     # paste the printed id into wrangler.toml

npx wrangler secret put TWELVEDATA_KEY
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TRIGGER_SECRET     # any long random string

npm run deploy
```

## 4. Confirm it works

```bash
# a labelled test message, using real current prices — proves token + chat id + formatting
curl "https://tr-bot.<your-subdomain>.workers.dev/trigger?secret=<TRIGGER_SECRET>&force=buy"

# state and market status, no secret needed
curl "https://tr-bot.<your-subdomain>.workers.dev/health"

# watch the 2-minute polls live
npm run tail
```

The first real poll only records which side the EMAs are on — it can't know when the last cross
happened, so it stays quiet. Alerts start from the next genuine cross.

---

## What a signal looks like

```
🟢 BUY — XAU/USD 15min
EMA21 crossed ABOVE EMA50

Price  4,424.90
EMA21  4,421.35
EMA50  4,419.80
Gap    0.035%

Bar 2026-09-20 14:15 UTC (forming)
```

## Configuration

All in `[vars]` in `wrangler.toml` — change and redeploy, no code edits.

| Variable | Default | What it does |
|---|---|---|
| `PROVIDER` | `twelvedata` | Primary feed. Comma-separate to set fallback order (`"yahoo,binance"`). Any provider you leave out is appended as a fallback anyway. |
| `SYMBOL` | `XAU/USD` | Twelve Data symbol (spot gold). |
| `YAHOO_SYMBOL` | `GC=F` | Fallback symbol — COMEX gold futures. |
| `BINANCE_SYMBOL` | `XAUTUSDT` | Last-resort symbol — Tether Gold. |
| `INTERVAL` | `15min` | Candle size. `5min`, `30min`, `1h` also work. |
| `FAST_LEN` / `SLOW_LEN` | `21` / `50` | EMA lengths. |
| `OUTPUTSIZE` | `300` | Candles per poll (EMA warmup). |
| `MIN_GAP_PCT` | `0.02` | A cross only alerts once the EMAs separate by this % of price (~$0.90 at gold 4400). Raise it if you get noisy signals. |
| `COOLDOWN_MIN` | `10` | Minimum minutes between alerts. |
| `SEND_FADE_NOTICE` | `true` | Tell you when a live cross reverses before its bar closes. |
| `FAIL_ALERT_AFTER` | `3` | Consecutive failed polls before the bot messages you. |
| `IGNORE_MARKET_HOURS` | `false` | Set `true` to poll around the clock (useful only with the Binance feed). |

Change the polling rate in `[triggers]`. Note the Twelve Data budget: `*/2` = 720 calls/day against
an 800/day free limit. Don't go to `*/1` unless you're on `PROVIDER = "yahoo"` or `"binance"`.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/health` | none | Market status + current stored state. |
| `/trigger?secret=…` | `TRIGGER_SECRET` | Run one poll immediately. |
| `/trigger?secret=…&force=buy` | `TRIGGER_SECRET` | Send a labelled test BUY (or `sell`) message. |
| `/reset?secret=…` | `TRIGGER_SECRET` | Wipe stored state; the next poll re-primes silently. |

## How the alerting avoids noise

Because the last candle is still forming, EMAs can cross and un-cross within one bar. Three guards:

1. **Gap filter** — a flip is held back until `|EMA21 − EMA50| ≥ MIN_GAP_PCT × price`. It *delays*
   the alert, it never cancels it: once the lines separate, the signal fires.
2. **Cooldown** — at most one alert per `COOLDOWN_MIN` minutes.
3. **Fade notice** — if a cross reverses inside the same bar it sent an alert for, you get a short
   `⚠️ Cross faded` message instead of a full opposite signal, and the bot re-arms.

State lives in Workers KV and is written **only when it changes**, keeping us far under the free
tier's 1,000 writes/day.

## Market hours

The worker doesn't poll when spot gold is closed (Sat all day, Sun before 18:00 ET, after Fri 17:00
ET, and the daily 17:00–18:00 ET break). US daylight saving is handled via the `America/New_York`
timezone, not a hardcoded UTC offset.

## Data sources, and what they cost you in accuracy

| Provider | Instrument | Key | Notes |
|---|---|---|---|
| `twelvedata` | spot XAU/USD | free key | Matches your TradingView chart most closely. 800 credits/day. |
| `yahoo` | `GC=F` COMEX futures | none | Trades ~$30–50 above spot with a 1h daily break. **Yahoo rate-limits by IP and returns 429 readily** — from Cloudflare's shared egress IPs this may fail often. Fallback only. |
| `binance` | `XAUT/USDT` Tether Gold | none | 24/7, no IP limits, tracks gold within a small premium but is thinner, so wicks differ. Last resort. |

Cross *timing* is nearly identical across all three; the printed prices are not.

## Development

```bash
npm test                  # 29 unit + integration tests, no network
npm run check             # live feed comparison across all providers
npm run dev               # local worker; then:
curl "http://localhost:8787/__scheduled"   # fire the cron handler by hand
```

## Known limitations

- Live (intrabar) crossing repaints by nature. The gap filter and fade notice reduce false signals
  but cannot eliminate them. If you'd rather only get confirmed signals, raise `MIN_GAP_PCT`.
- Worst-case latency is one poll cycle (~2 minutes) after the lines actually cross.
- Twelve Data's spot feed and TradingView's broker feed differ by cents, so a cross can land one
  poll earlier or later than the label on your chart.
- The bot never alerts on the very first poll after deploy or `/reset` — it has no way to know when
  the previous cross happened.
