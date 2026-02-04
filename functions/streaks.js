/**
 * Daily streak logic: yesterday's date in a timezone, day-done check from
 * daily_tasks fields, and normalizing taskDate to YYYY-MM-DD.
 */

const TASK_FIELDS = ["activity", "education", "hydration", "nutrition", "recovery"];
const DAILY_TASKS_COLLECTION = "daily_tasks";
const USERS_COLLECTION = "users";
const DEFAULT_TIMEZONE = "Asia/Karachi";

/**
 * Returns today's date as YYYY-MM-DD in the given timezone.
 * @param {string} timeZone - IANA timezone (e.g. "Asia/Karachi")
 * @returns {string} YYYY-MM-DD
 */
function getTodayYMD(timeZone = DEFAULT_TIMEZONE) {
  return new Date().toLocaleDateString("en-CA", {timeZone});
}

/**
 * Returns yesterday's date as YYYY-MM-DD in the given timezone.
 * @param {string} timeZone - IANA timezone (e.g. "Asia/Karachi")
 * @returns {string} YYYY-MM-DD
 */
function getYesterdayYMD(timeZone = DEFAULT_TIMEZONE) {
  const todayStr = getTodayYMD(timeZone);
  const [y, m, d] = todayStr.split("-").map(Number);
  const yesterday = new Date(y, m - 1, d - 1);
  return yesterday.toISOString().slice(0, 10);
}

/**
 * Returns the day after a YYYY-MM-DD date string (handles month/year boundaries).
 * @param {string} yyyyMmDd - YYYY-MM-DD
 * @returns {string} YYYY-MM-DD
 */
function getDayAfterYYYYMMDD(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const next = new Date(y, m - 1, d + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Normalizes taskDate to YYYY-MM-DD (handles "2026-01-28T00:00:00.000" or "2026-01-28").
 * @param {string|null|undefined} value - Raw taskDate from Firestore
 * @returns {string|null} YYYY-MM-DD or null
 */
function normalizeTaskDateToYYYYMMDD(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (s.length >= 10) return s.slice(0, 10);
  return s;
}

/**
 * Returns true if the daily_tasks document counts as "day done" (at least one task true).
 * @param {object} data - Document data (activity, education, hydration, nutrition, recovery)
 * @returns {boolean}
 */
function isDayDone(data) {
  if (!data || typeof data !== "object") return false;
  for (const key of TASK_FIELDS) {
    if (data[key] === true) return true;
  }
  return false;
}

/**
 * Builds Firestore update for users/{userId} streak (currentStreak, bestStreak).
 * @param {boolean} dayDone - Whether yesterday was completed
 * @param {number} currentStreak - Current streak before this day
 * @param {number} bestStreak - Best streak before this day
 * @returns {{ currentStreak: number, bestStreak: number }}
 */
function computeNewStreaks(dayDone, currentStreak, bestStreak) {
  const prev = Number(currentStreak) || 0;
  const best = Number(bestStreak) || 0;
  if (dayDone) {
    const next = prev + 1;
    return {currentStreak: next, bestStreak: Math.max(best, next)};
  }
  return {currentStreak: 0, bestStreak: best};
}

module.exports = {
  TASK_FIELDS,
  DAILY_TASKS_COLLECTION,
  USERS_COLLECTION,
  DEFAULT_TIMEZONE,
  getTodayYMD,
  getYesterdayYMD,
  getDayAfterYYYYMMDD,
  normalizeTaskDateToYYYYMMDD,
  isDayDone,
  computeNewStreaks,
};
