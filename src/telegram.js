/** Telegram Bot API — message formatting and delivery. */

const API = 'https://api.telegram.org';

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {{token: string, chatId: string, text: string}} opts
 */
export async function sendMessage({ token, chatId, text }) {
  if (!token || !chatId) throw new Error('TELEGRAM_TOKEN / TELEGRAM_CHAT_ID not set');

  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`telegram send failed (${res.status}): ${body?.description ?? 'unknown error'}`);
  }
  return body.result;
}

const price = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function utcStamp(ms) {
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/**
 * @param {'buy'|'sell'} action
 * @param {object} snapshot result of evaluate()
 * @param {{symbol: string, interval: string, fastLen: number, slowLen: number, provider: string, fellBack: boolean, test?: boolean}} meta
 */
export function formatSignal(action, snapshot, meta) {
  const buy = action === 'buy';
  const head = buy ? '🟢 <b>BUY</b>' : '🔴 <b>SELL</b>';
  const dir = buy ? 'ABOVE' : 'BELOW';

  const lines = [
    `${head} — ${escapeHtml(meta.symbol)} ${escapeHtml(meta.interval)}`,
    `EMA${meta.fastLen} crossed ${dir} EMA${meta.slowLen}`,
    '',
    `<pre>Price  ${price(snapshot.price)}`,
    `EMA${String(meta.fastLen).padEnd(2)}  ${price(snapshot.fast)}`,
    `EMA${String(meta.slowLen).padEnd(2)}  ${price(snapshot.slow)}`,
    `Gap    ${snapshot.gapPct.toFixed(3)}%</pre>`,
    `Bar ${utcStamp(snapshot.barTime)} (forming)`,
  ];

  if (meta.fellBack) lines.push(`⚠️ fallback feed: ${escapeHtml(meta.provider)}`);
  if (meta.test) lines.push('🧪 <i>test message — not a real signal</i>');

  return lines.join('\n');
}

/** A live cross that reversed before its bar closed. */
export function formatFade(snapshot, meta) {
  return [
    `⚠️ <b>Cross faded</b> — ${escapeHtml(meta.symbol)} ${escapeHtml(meta.interval)}`,
    `EMA${meta.fastLen} slipped back ${snapshot.side === 'bull' ? 'above' : 'below'} EMA${meta.slowLen} inside the same bar.`,
    `Treat the previous signal as unconfirmed.`,
    '',
    `<pre>Price  ${price(snapshot.price)}`,
    `EMA${String(meta.fastLen).padEnd(2)}  ${price(snapshot.fast)}`,
    `EMA${String(meta.slowLen).padEnd(2)}  ${price(snapshot.slow)}</pre>`,
  ].join('\n');
}

export function formatFailure(failStreak, errorText) {
  return [
    `🛑 <b>Feed problem</b>`,
    `${failStreak} consecutive failed polls — alerts may be missed.`,
    '',
    `<pre>${escapeHtml(errorText).slice(0, 600)}</pre>`,
  ].join('\n');
}

export function formatRecovery(provider) {
  return `✅ <b>Feed recovered</b> — polling normally again via ${escapeHtml(provider)}.`;
}
