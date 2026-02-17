/**
 * Scheduled function every hour: sends "come back" push at 10am in each user's
 * local time to users inactive 3+ days (based on users.lastLoggedIn). Milestones:
 * 3, 7, 14, 21, 30 days, then once every 30 days. Uses user "timezone" (e.g. "UTC+5").
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {getFirestore} = require("firebase-admin/firestore");
const {
  parseTimezoneToOffsetMinutes,
  getLocalTimeForOffset,
  normalizeTaskDateToYYYYMMDD,
  USERS_COLLECTION,
  DAILY_TASKS_COLLECTION,
} = require("./streaks");
const {sendPushToUser} = require("./notifications/service");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MILESTONES_DAYS = [3, 7, 14, 21, 30];
const MONTHLY_DAYS = 30;
const TARGET_LOCAL_HOUR = 10; // 10am

function toDate(value) {
  if (!value) return null;
  if (value.toDate && typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return null;
}

function getInactiveState(userData, nowMs) {
  const lastLoggedIn = toDate(userData.lastLoggedIn);
  if (!lastLoggedIn) return {daysInactive: 0, lastSentAt: null, lastMilestone: null};
  const daysInactive = Math.floor((nowMs - lastLoggedIn.getTime()) / MS_PER_DAY);
  const lastSentAt = toDate(userData.lastInactiveNotificationSentAt);
  const lastMilestone = typeof userData.lastInactiveNotificationMilestone === "number"
    ? userData.lastInactiveNotificationMilestone
    : null;
  return {daysInactive, lastSentAt, lastMilestone};
}

function getMessageForMilestone(days) {
  if (days === 3) {
    return {
      title: "We miss you!",
      body: "It's been a few days — your glow-up journey is waiting. Open the app and keep your streak alive!",
    };
  }
  if (days === 7) {
    return {
      title: "Come back to your routine",
      body: "A week without you! Your goals are still here. Open the app and pick up where you left off.",
    };
  }
  if (days === 14) {
    return {
      title: "Your streak is calling",
      body: "Two weeks ago you were building something great. Open the app and start again — we're here for you.",
    };
  }
  if (days === 21) {
    return {
      title: "Ready when you are",
      body: "Three weeks — no pressure. When you're ready, open the app and we'll help you get back on track.",
    };
  }
  if (days === 30) {
    return {
      title: "A month without you",
      body: "Your glow-up journey is still here. Open the app and make today the day you come back.",
    };
  }
  return {
    title: "We're still here",
    body: "Your goals haven't gone anywhere. Open the app when you're ready to continue your glow-up.",
  };
}

const notifyInactiveComeback = onSchedule(
  {
    schedule: "0 * * * *",
    region: "us-central1",
  },
  async () => {
    const db = getFirestore();
    const now = new Date();
    const nowMs = now.getTime();
    const threeDaysAgo = new Date(nowMs - 3 * MS_PER_DAY);

    const snapshot = await db.collection(USERS_COLLECTION)
      .where("lastLoggedIn", "<", threeDaysAgo)
      .get();

    // First pass: collect candidates that pass timezone + milestone checks
    const candidates = [];
    for (const doc of snapshot.docs) {
      const userData = doc.data();
      const offsetMin = parseTimezoneToOffsetMinutes(userData.timezone);
      const {hour: localHour} = getLocalTimeForOffset(offsetMin, nowMs);
      if (localHour !== TARGET_LOCAL_HOUR) continue;

      const {daysInactive, lastSentAt, lastMilestone} = getInactiveState(userData, nowMs);
      if (daysInactive < 3) continue;

      let sendNow = false;
      let milestoneToSend = null;

      if (lastMilestone === null) {
        if (daysInactive >= MILESTONES_DAYS[0]) {
          sendNow = true;
          milestoneToSend = MILESTONES_DAYS[0];
        }
      } else {
        const nextIndex = MILESTONES_DAYS.indexOf(lastMilestone) + 1;
        if (nextIndex < MILESTONES_DAYS.length && daysInactive >= MILESTONES_DAYS[nextIndex]) {
          sendNow = true;
          milestoneToSend = MILESTONES_DAYS[nextIndex];
        } else if (lastMilestone === 30 && lastSentAt) {
          const daysSinceLastSent = (nowMs - lastSentAt.getTime()) / MS_PER_DAY;
          if (daysSinceLastSent >= MONTHLY_DAYS) {
            sendNow = true;
            milestoneToSend = 30;
          }
        }
      }

      if (!sendNow || milestoneToSend === null) continue;
      candidates.push({doc, milestoneToSend});
    }

    if (candidates.length === 0) return;

    // Safety net: batch-fetch daily_tasks to catch users active since lastLoggedIn was written
    const dailyTasksRefs = candidates.map(({doc}) =>
      db.collection(DAILY_TASKS_COLLECTION).doc(doc.id)
    );
    const dailyTasksSnaps = await db.getAll(...dailyTasksRefs);
    const dailyTasksMap = {};
    for (const snap of dailyTasksSnaps) {
      dailyTasksMap[snap.id] = snap.exists ? snap.data() : null;
    }

    // Second pass: skip users with recent daily_tasks activity, send to the rest
    for (const {doc, milestoneToSend} of candidates) {
      const taskData = dailyTasksMap[doc.id];
      if (taskData && taskData.taskDate) {
        const taskDateStr = normalizeTaskDateToYYYYMMDD(taskData.taskDate);
        if (taskDateStr && new Date(taskDateStr).getTime() >= threeDaysAgo.getTime()) {
          continue; // user has recent app activity, skip
        }
      }

      const userId = doc.id;
      const {title, body} = getMessageForMilestone(milestoneToSend);
      const result = await sendPushToUser(userId, {
        title,
        body,
        data: {type: "inactive_comeback", days: String(milestoneToSend)},
      }, db);

      if (result.sent) {
        await doc.ref.update({
          lastInactiveNotificationSentAt: now,
          lastInactiveNotificationMilestone: milestoneToSend,
        });
      }
    }
  },
);

module.exports = {notifyInactiveComeback};
