/**
 * Spot gold trading hours, expressed in New York time so US daylight saving is
 * handled for us by the runtime's timezone database:
 *
 *   opens   Sunday    18:00 ET
 *   closes  Friday    17:00 ET
 *   daily break Mon-Thu 17:00-18:00 ET
 */

const ET = 'America/New_York';
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** @returns {{weekday: number, hour: number, minute: number}} */
export function nyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: WEEKDAYS[get('weekday')],
    // Intl can emit "24" for midnight in hour12:false mode.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

/**
 * @param {Date} date
 * @returns {{open: boolean, reason: string}}
 */
export function marketStatus(date = new Date()) {
  const { weekday, hour } = nyParts(date);

  if (weekday === 6) return { open: false, reason: 'Saturday — market closed' };
  if (weekday === 0) {
    return hour >= 18
      ? { open: true, reason: 'Sunday session open' }
      : { open: false, reason: 'Sunday before 18:00 ET open' };
  }
  if (weekday === 5 && hour >= 17) return { open: false, reason: 'after Friday 17:00 ET close' };
  if (hour === 17) return { open: false, reason: 'daily 17:00-18:00 ET break' };

  return { open: true, reason: 'session open' };
}

export function isMarketOpen(date = new Date()) {
  return marketStatus(date).open;
}
