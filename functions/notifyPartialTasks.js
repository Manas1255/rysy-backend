/**
 * Scheduled function every hour: sends a push at 8pm in each user's local time
 * to users who have completed some but not all of "today's" tasks. Message varies
 * by how many tasks are left (1/5 … 4/5). Uses user document field "timezone".
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {getFirestore} = require("firebase-admin/firestore");
const {
  parseTimezoneToOffsetMinutes,
  getLocalTimeForOffset,
  isDayDone,
  TASK_FIELDS,
  DAILY_TASKS_COLLECTION,
  USERS_COLLECTION,
} = require("./streaks");
const {sendPushToUser} = require("./notifications/service");

const TOTAL_TASKS = TASK_FIELDS.length;
const TARGET_LOCAL_HOUR = 20; // 8pm
const BATCH_SIZE = 300;

/** User doc field: last date (user local YYYY-MM-DD) we sent this notification. */
const LAST_SENT_DATE_FIELD = "lastNotifiedPartialTasksDate";

/** Human-readable labels for the one remaining task (4/5 case). */
const TASK_LABELS = {
  activity: "get moving",
  education: "learn something",
  hydration: "stay hydrated",
  nutrition: "eat well",
  recovery: "recover",
};

function getCompletedAndRemaining(data) {
  let completed = 0;
  const remaining = [];
  for (const key of TASK_FIELDS) {
    if (data[key] === true) completed++;
    else remaining.push(TASK_LABELS[key] || key);
  }
  return {completed, remaining};
}

function getMessageForPartial(completed, remaining) {
  if (completed === 1) {
    return {
      title: "4 tasks left today",
      body: "You completed one task — finish the other 4 before the day ends to keep your glow-up streak going!",
    };
  }
  if (completed === 2) {
    return {
      title: "3 tasks left today",
      body: "Two down! Wrap up the other 3 tasks before midnight to maintain your streak.",
    };
  }
  if (completed === 3) {
    return {
      title: "Almost there — 2 to go",
      body: "You're so close! Just 2 tasks left. Finish them before the day ends to keep your glow going.",
    };
  }
  const lastTask = remaining[0] || "your last task";
  return {
    title: "One task left!",
    body: `You're almost there! All you need to do is ${lastTask} before the day ends to keep your streak alive.`,
  };
}

const notifyPartialTasks = onSchedule(
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
        if (!isDayDone(data)) continue;

        const {completed, remaining} = getCompletedAndRemaining(data);
        if (completed >= TOTAL_TASKS || completed < 1) continue;

        const {title, body} = getMessageForPartial(completed, remaining);
        const result = await sendPushToUser(userId, {
          title,
          body,
          data: {type: "partial_tasks", completed: String(completed), total: String(TOTAL_TASKS)},
        }, db);

        if (result.sent) {
          await doc.ref.update({[LAST_SENT_DATE_FIELD]: userToday});
        }
      }
      if (snapshot.docs.length < BATCH_SIZE) break;
    }
  },
);

module.exports = {notifyPartialTasks};
