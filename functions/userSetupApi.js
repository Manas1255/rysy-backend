/**
 * User Setup API: HTTP endpoint that migrates all user data from oldUserId
 * to newUserId (Firestore docs + Storage selfies/meals), then deletes old docs.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {getFirestore} = require("firebase-admin/firestore");
const {migrateUser} = require("./userSetup/migration");

const userSetupApi = onRequest(
  {
    region: "us-central1",
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ok: false, error: "Method Not Allowed"});
      return;
    }

    const body = typeof req.body === "object" && req.body !== null ? req.body : {};
    const oldUserId = (body.oldUserId ?? body.old_user_id ?? "").toString().trim();
    const newUserId = (body.newUserId ?? body.new_user_id ?? "").toString().trim();

    if (!newUserId) {
      res.status(400).json({
        ok: false,
        error: "Missing newUserId. Send JSON: { newUserId } or { oldUserId, newUserId }.",
      });
      return;
    }

    // Allow only newUserId: we will find the user doc by id field and migrate so doc ID = id
    if (oldUserId && oldUserId === newUserId) {
      res.status(400).json({ok: false, error: "oldUserId and newUserId must be different when both provided."});
      return;
    }

    const db = getFirestore();
    try {
      const result = await migrateUser(oldUserId, newUserId, db);
      if (result.error) {
        res.status(400).json({ok: false, error: result.error});
        return;
      }
      res.status(200).json({ok: true, message: "User data migrated successfully."});
    } catch (err) {
      console.error("userSetupApi:", err);
      res.status(500).json({ok: false, error: err.message || "Migration failed."});
    }
  },
);

module.exports = {userSetupApi};
