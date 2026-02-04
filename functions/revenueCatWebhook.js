/**
 * RevenueCat webhook HTTP handler. Validates requests, resolves user id from the
 * event, builds subscription payload (or null for cancel/expire), and updates
 * the user document in Firestore.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {getFirestore} = require("firebase-admin/firestore");
const {getRevenueCatConfig} = require("./config");
const {subscriptionFromEvent} = require("./subscription");

const USERS_COLLECTION = "users";

/**
 * Resolves the user ID to update from a RevenueCat event. Prefers app_user_id (last seen),
 * then transferred_to for TRANSFER events, then original_app_user_id.
 * @param {object} event - RevenueCat webhook event
 * @returns {string[]} Single-element array with user ID, or empty if none
 */
function resolveUserIds(event) {
  if (!event) return [];

  if (event.type === "TRANSFER" && Array.isArray(event.transferred_to) && event.transferred_to.length > 0) {
    const id = String(event.transferred_to[0]).trim();
    return id ? [id] : [];
  }

  const primary = (event.app_user_id || event.original_app_user_id || "").trim();
  return primary ? [primary] : [];
}

/**
 * Validates RevenueCat webhook Authorization header (Bearer or Basic with shared secret).
 * @param {string} authHeader - Request Authorization header
 * @param {string} expectedAuth - Configured secret
 * @returns {boolean}
 */
function validateAuth(authHeader, expectedAuth) {
  if (!expectedAuth || !authHeader) return false;
  const trimmed = authHeader.trim();
  if (trimmed.startsWith("Bearer ")) {
    return trimmed.slice(7).trim() === expectedAuth.trim();
  }
  if (trimmed.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(trimmed.slice(6).trim(), "base64").toString("utf8");
      const parts = decoded.split(":");
      const secret = parts.length > 1 ? parts.slice(1).join(":") : parts[0];
      return secret === expectedAuth.trim();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * RevenueCat webhook handler. Expects POST with JSON body and Authorization header.
 * Updates users/{userId}.subscription from the event, or sets subscription to null on cancel/expire.
 */
const revenueCatWebhook = onRequest(
  {
    region: "us-central1",
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const config = getRevenueCatConfig();
    if (!validateAuth(req.headers.authorization || "", config.auth)) {
      res.status(401).send("Unauthorized");
      return;
    }

    const body = typeof req.body === "object" && req.body !== null ? req.body : {};

    const event = body?.event;
    if (!event || typeof event !== "object") {
      res.status(400).send("Missing event");
      return;
    }

    const userIds = resolveUserIds(event);
    if (userIds.length === 0) {
      res.status(200).send("OK");
      return;
    }

    const subscriptionPayload = subscriptionFromEvent(event, {
      monthlyProductIds: config.monthlyProductIds,
      yearlyProductIds: config.yearlyProductIds,
    });

    const db = getFirestore();
    const update = subscriptionPayload === null ? {subscription: null} : {subscription: subscriptionPayload};

    for (const userId of userIds) {
      try {
        await db.collection(USERS_COLLECTION).doc(userId).set(update, {merge: true});
      } catch (err) {
        console.error("revenueCatWebhook: failed to update user", userId, err);
      }
    }

    res.status(200).send("OK");
  },
);

module.exports = {revenueCatWebhook, validateAuth, resolveUserIds};
