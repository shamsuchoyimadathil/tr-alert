/**
 * Persisted signal state in Workers KV.
 *
 * The free KV tier allows 1000 writes/day and we poll ~720 times/day, so writes
 * happen ONLY when something actually changed. Reads (100k/day) are unconstrained
 * for our purposes.
 */

const KEY = 'signal-state';

const EMPTY = {
  side: null,          // last observed side: 'bull' | 'bear'
  alertedSide: null,   // side of the last alert we sent
  alertedAt: null,     // epoch ms of the last alert
  alertedBar: null,    // bar open time of the last alert
  failStreak: 0,       // consecutive failed polls
  failNotifiedAt: null,// epoch ms of the last failure alert
};

/** @param {KVNamespace} kv */
export async function readState(kv) {
  const stored = await kv.get(KEY, 'json');
  return { ...EMPTY, ...(stored ?? {}) };
}

/**
 * Write only if the value differs from what we read.
 * @param {KVNamespace} kv
 * @param {object} previous state as read
 * @param {object} next state to persist
 * @returns {Promise<boolean>} whether a write happened
 */
export async function writeState(kv, previous, next) {
  const merged = { ...EMPTY, ...next };
  if (JSON.stringify({ ...EMPTY, ...previous }) === JSON.stringify(merged)) return false;
  await kv.put(KEY, JSON.stringify(merged));
  return true;
}

export async function clearState(kv) {
  await kv.delete(KEY);
}
