'use strict';

const { stmts } = require('./db');

const LIMITS = {
  minute: 10,
  hour:   50,
  day:    200,
};

// Returns the ceiling of the current window boundary as an ISO string.
// windowMs: window length in milliseconds.
function windowEnd(now, windowMs) {
  return new Date(Math.ceil(now / windowMs) * windowMs).toISOString();
}

/**
 * Check and increment rate-limit counters for a chat_id.
 * Returns { allowed: boolean, retryAfter: string|null }
 * retryAfter is a human-readable string like "60 seconds" when blocked.
 */
function checkRateLimit(chatId) {
  const now = Date.now();
  const minuteReset = windowEnd(now, 60 * 1000);
  const hourReset   = windowEnd(now, 60 * 60 * 1000);
  const dayReset    = windowEnd(now, 24 * 60 * 60 * 1000);

  const row = stmts.getRateLimit.get(chatId);

  if (!row) {
    // First message from this chat_id
    stmts.insertRateLimit.run(chatId, minuteReset, hourReset, dayReset);
    return { allowed: true, retryAfter: null };
  }

  const nowIso = new Date(now).toISOString();

  // Reset counters whose window has expired
  let minuteCount = nowIso >= row.minute_reset ? 0 : row.minute_count;
  let hourCount   = nowIso >= row.hour_reset   ? 0 : row.hour_count;
  let dayCount    = nowIso >= row.day_reset     ? 0 : row.day_count;

  const newMinuteReset = minuteCount === 0 ? minuteReset : row.minute_reset;
  const newHourReset   = hourCount   === 0 ? hourReset   : row.hour_reset;
  const newDayReset    = dayCount    === 0 ? dayReset    : row.day_reset;

  // Check limits before incrementing
  if (minuteCount >= LIMITS.minute) {
    const retryMs = new Date(newMinuteReset).getTime() - now;
    return { allowed: false, retryAfter: `${Math.ceil(retryMs / 1000)} seconds` };
  }
  if (hourCount >= LIMITS.hour) {
    const retryMs = new Date(newHourReset).getTime() - now;
    const retryMin = Math.ceil(retryMs / 60000);
    return { allowed: false, retryAfter: `${retryMin} minute${retryMin !== 1 ? 's' : ''}` };
  }
  if (dayCount >= LIMITS.day) {
    const retryMs = new Date(newDayReset).getTime() - now;
    const retryHr = Math.ceil(retryMs / 3600000);
    return { allowed: false, retryAfter: `${retryHr} hour${retryHr !== 1 ? 's' : ''}` };
  }

  // Increment
  stmts.updateRateLimit.run(
    minuteCount + 1,
    hourCount   + 1,
    dayCount    + 1,
    newMinuteReset,
    newHourReset,
    newDayReset,
    chatId,
  );

  return { allowed: true, retryAfter: null };
}

module.exports = { checkRateLimit };
