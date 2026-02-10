/**
 * Scheduled function every hour: sends a push at 11pm in each user's local time
 * to users who have a current streak but haven't completed any task for "today"
 * yet. Uses user document field "timezone" (e.g. "UTC+5", "UTC+5:30").
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {getFirestore} = require("firebase-admin/firestore");
const {
  parseTimezoneToOffsetMinutes,
  getLocalTimeForOffset,
  isDayDone,
  DAILY_TASKS_COLLECTION,
  USERS_COLLECTION,
} = require("./streaks");
const {sendPushToUser} = require("./notifications/service");

const TARGET_LOCAL_HOUR = 23; // 11pm
const BATCH_SIZE = 300;

/** User doc field: last date (user local YYYY-MM-DD) we sent this notification. */
const LAST_SENT_DATE_FIELD = "lastNotifiedStreakAboutToBreakDate";

const notifyStreakAboutToBreak = onSchedule(
  {
    schedule: "0 * * * *",
    region: "us-central1",
  },
  async () => {
    const db = getFirestore();
    const nowMs = Date.now();
    let lastDoc = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let q = db.collection(USERS_COLLECTION).orderBy("__name__").limit(BATCH_SIZE);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snapshot = await q.get();
      if (snapshot.empty) break;

      for (const doc of snapshot.docs) {
        lastDoc = doc;
        const userId = doc.id;
        const userData = doc.data();
        const offsetMin = parseTimezoneToOffsetMinutes(userData.timezone);
        const {dateYmd: userToday, hour: localHour} = getLocalTimeForOffset(offsetMin, nowMs);
        if (localHour !== TARGET_LOCAL_HOUR) continue;
        if (userData[LAST_SENT_DATE_FIELD] === userToday) continue;

        const taskSnap = await db.collection(DAILY_TASKS_COLLECTION).doc(userId).get();
        const data = taskSnap.exists ? taskSnap.data() : {};
        const taskDate = (data.taskDate && String(data.taskDate).slice(0, 10)) || "";
        if (taskDate !== userToday) continue;
        if (isDayDone(data)) continue;

        const currentStreak = typeof userData.currentStreak === "number" ? userData.currentStreak : 0;
        if (currentStreak <= 0) continue;

        const result = await sendPushToUser(userId, {
          title: "Your streak is about to break",
          body: "You have about an hour left — complete at least one task before midnight to keep your "
            + "glow-up streak alive!",
          data: {type: "streak_about_to_break"},
        }, db);

        if (result.sent) {
          await doc.ref.update({[LAST_SENT_DATE_FIELD]: userToday});
        }
      }
      if (snapshot.docs.length < BATCH_SIZE) break;
    }
  },
);

module.exports = {notifyStreakAboutToBreak};
