/**
 * Firestore trigger: when a user document is updated and currentStreak goes
 * from >0 to 0, sends a push notification (via notification service).
 * Does not send when the user is first created (currentStreak is 0 initially).
 */

const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {sendPushToUser} = require("./notifications/service");

const USERS_PATH = "users/{userId}";

const notifyStreakBroken = onDocumentUpdated(
  {
    document: USERS_PATH,
    region: "us-central1",
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.before || !change.after) return;

    const before = change.before.data();
    const after = change.after.data();
    const userId = event.params.userId;

    const prevStreak = typeof before.currentStreak === "number" ? before.currentStreak : 0;
    const nextStreak = typeof after.currentStreak === "number" ? after.currentStreak : 0;

    if (nextStreak !== 0) return;
    if (prevStreak <= 0) return;

    await sendPushToUser(userId, {
      title: "Streak broken",
      body: "You missed a day. Start a new streak today!",
      data: {type: "streak_broken"},
    });
  },
);

module.exports = {notifyStreakBroken};
