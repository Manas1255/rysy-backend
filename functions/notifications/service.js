/**
 * Push notification service: sends FCM messages to a user's devices.
 * Skips users on trial, with notifications disabled, or with no FCM tokens.
 * Removes invalid/expired tokens from the user document after send.
 */

const {getMessaging} = require("firebase-admin/messaging");
const {getFirestore} = require("firebase-admin/firestore");

const USERS_COLLECTION = "users";
const FCM_TOKEN_FIELD = "fcmToken";

const INVALID_TOKEN_CODES = [
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
  "messaging/invalid-argument",
];

/**
 * Returns true if we should send push notifications to this user.
 * Skips when: on trial, notifications disabled, or no FCM token.
 * @param {object} userData - User document data
 * @returns {boolean}
 */
function shouldSendToUser(userData) {
  if (!userData || typeof userData !== "object") return false;
  if (userData.notificationsEnabled === false) return false;
  if (userData.subscription?.isOnTrial === true) return false;
  const token = userData[FCM_TOKEN_FIELD];
  const valid = typeof token === "string" && token.trim().length > 0;
  return valid;
}

/**
 * Sends a push notification to the user's FCM token. Does not send if user is
 * on trial, has notifications disabled, or has no token. Clears invalid/expired
 * token from the user document after send.
 * @param {string} userId - User document ID
 * @param {{ title: string, body?: string, data?: object }} payload - title, optional body, optional data
 * @param {FirebaseFirestore.Firestore} [db] - Firestore instance (uses default if omitted)
 * @returns {Promise<{ sent: boolean, invalidTokenCount?: number }>}
 */
async function sendPushToUser(userId, payload, db) {
  const firestore = db || getFirestore();
  const userRef = firestore.collection(USERS_COLLECTION).doc(userId);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};

  if (!shouldSendToUser(userData)) {
    return {sent: false};
  }

  const token = (userData[FCM_TOKEN_FIELD] || "").trim();
  if (!token) return {sent: false};

  const tokens = [token];
  const messaging = getMessaging();
  const message = {
    tokens,
    notification: {
      title: payload.title || "Notification",
      body: payload.body || "",
    },
    ...(payload.data && Object.keys(payload.data).length > 0 ? {data: payload.data} : {}),
  };

  let batchResponse;
  try {
    batchResponse = await messaging.sendEachForMulticast(message);
  } catch (err) {
    console.warn("notifications/service sendPushToUser failed:", userId, err);
    return {sent: false};
  }

  const invalidIndices = [];
  batchResponse.responses.forEach((resp, idx) => {
    if (!resp.success && resp.error) {
      const code = (resp.error.code || "").toString();
      if (INVALID_TOKEN_CODES.some((c) => code.includes(c) || code.endsWith(c))) {
        invalidIndices.push(idx);
      }
    }
  });

  if (invalidIndices.length > 0) {
    await userRef.update({
      [FCM_TOKEN_FIELD]: null,
    });
  }

  const sent = (batchResponse.successCount || 0) > 0;
  return {
    sent,
    invalidTokenCount: invalidIndices.length,
  };
}

module.exports = {
  shouldSendToUser,
  sendPushToUser,
  USERS_COLLECTION,
  FCM_TOKEN_FIELD,
};
