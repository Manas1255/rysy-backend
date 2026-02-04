/**
 * Scheduled function that runs daily (e.g. 2am Asia/Karachi), processes
 * yesterday's daily_tasks, and updates each user's currentStreak / bestStreak.
 * taskDate is normalized to YYYY-MM-DD where applicable.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {getFirestore} = require("firebase-admin/firestore");
const {
  getYesterdayYMD,
  getDayAfterYYYYMMDD,
  normalizeTaskDateToYYYYMMDD,
  isDayDone,
  computeNewStreaks,
  DAILY_TASKS_COLLECTION,
  USERS_COLLECTION,
  DEFAULT_TIMEZONE,
} = require("./streaks");

const BATCH_SIZE = 400;

/**
 * Runs at 2:00 AM Asia/Karachi every day. Queries daily_tasks where taskDate
 * is yesterday, then for each doc (doc id = userId): if any of activity,
 * education, hydration, nutrition, recovery is true → increment currentStreak
 * and update bestStreak; else set currentStreak to 0. Writes lastStreakProcessedDate
 * and normalizes taskDate to YYYY-MM-DD on the daily_tasks doc for idempotency.
 */
const updateUserStreaksDaily = onSchedule(
  {
    schedule: "0 2 * * *",
    timeZone: DEFAULT_TIMEZONE,
    region: "us-central1",
  },
  async () => {
    const db = getFirestore();
    const yesterdayStr = getYesterdayYMD(DEFAULT_TIMEZONE);
    const dayAfter = getDayAfterYYYYMMDD(yesterdayStr);

    const dailyTasksRef = db.collection(DAILY_TASKS_COLLECTION);
    const snapshot = await dailyTasksRef
      .where("taskDate", ">=", yesterdayStr)
      .where("taskDate", "<", dayAfter)
      .get();

    const updates = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.lastStreakProcessedDate === yesterdayStr) continue;
      const userId = doc.id;
      const dayDone = isDayDone(data);
      const normalizedTaskDate = normalizeTaskDateToYYYYMMDD(data.taskDate);

      const userRef = db.collection(USERS_COLLECTION).doc(userId);
      let userSnap;
      try {
        userSnap = await userRef.get();
      } catch (e) {
        console.warn("updateUserStreaksDaily: skip user " + userId, e);
        continue;
      }
      const userData = userSnap.exists ? userSnap.data() : {};
      const {currentStreak, bestStreak} = computeNewStreaks(
        dayDone,
        userData.currentStreak,
        userData.bestStreak,
      );

      updates.push({
        userId,
        userUpdate: {currentStreak, bestStreak},
        taskUpdate: {
          lastStreakProcessedDate: yesterdayStr,
          ...(normalizedTaskDate ? {taskDate: normalizedTaskDate} : {}),
        },
      });
    }

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const writeBatch = db.batch();
      const chunk = updates.slice(i, i + BATCH_SIZE);
      for (const {userId, userUpdate, taskUpdate} of chunk) {
        writeBatch.set(
          db.collection(USERS_COLLECTION).doc(userId),
          userUpdate,
          {merge: true},
        );
        writeBatch.set(
          db.collection(DAILY_TASKS_COLLECTION).doc(userId),
          taskUpdate,
          {merge: true},
        );
      }
      await writeBatch.commit();
    }
  },
);

module.exports = {updateUserStreaksDaily};
