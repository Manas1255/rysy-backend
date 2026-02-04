/**
 * Scheduled function at 8pm daily: sends a push to users whose daily_tasks
 * for today have all task fields false ("You haven't been active today").
 * Uses notification service (skips users on trial / notifications disabled).
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {getFirestore} = require("firebase-admin/firestore");
const {
  getTodayYMD,
  getDayAfterYYYYMMDD,
  isDayDone,
  DAILY_TASKS_COLLECTION,
  DEFAULT_TIMEZONE,
} = require("./streaks");
const {sendPushToUser} = require("./notifications/service");

const notifyInactiveToday = onSchedule(
  {
    schedule: "0 20 * * *",
    timeZone: DEFAULT_TIMEZONE,
    region: "us-central1",
  },
  async () => {
    const db = getFirestore();
    const todayStr = getTodayYMD(DEFAULT_TIMEZONE);
    const dayAfter = getDayAfterYYYYMMDD(todayStr);

    const snapshot = await db.collection(DAILY_TASKS_COLLECTION)
      .where("taskDate", ">=", todayStr)
      .where("taskDate", "<", dayAfter)
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (isDayDone(data)) continue;

      const userId = doc.id;
      await sendPushToUser(userId, {
        title: "You haven't been active today",
        body: "Complete at least one task to keep your streak going.",
        data: {type: "inactive_today"},
      }, db);
    }
  },
);

module.exports = {notifyInactiveToday};
