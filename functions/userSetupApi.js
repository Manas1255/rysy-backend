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
    console.log("[userSetupApi] Request received", {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"],
        "user-agent": req.headers["user-agent"],
      },
      bodyKeys: req.body ? Object.keys(req.body) : [],
      timestamp: new Date().toISOString(),
    });

    if (req.method !== "POST") {
      console.log("[userSetupApi] Method not allowed", {
        method: req.method,
      });
      res.status(405).json({ok: false, error: "Method Not Allowed"});
      return;
    }

    const body = typeof req.body === "object" && req.body !== null ? req.body : {};
    const oldUserId = (body.oldUserId ?? body.old_user_id ?? "").toString().trim();
    const newUserId = (body.newUserId ?? body.new_user_id ?? "").toString().trim();

    console.log("[userSetupApi] Parsed request body", {
      oldUserId: oldUserId || "(empty)",
      newUserId: newUserId || "(empty)",
      bodyKeys: Object.keys(body),
    });

    if (!newUserId) {
      console.error("[userSetupApi] Missing newUserId");
      res.status(400).json({
        ok: false,
        error: "Missing newUserId. Send JSON: { newUserId } or { oldUserId, newUserId }.",
      });
      return;
    }

    // Allow only newUserId: we will find the user doc by id field and migrate so doc ID = id
    if (oldUserId && oldUserId === newUserId) {
      console.error("[userSetupApi] oldUserId and newUserId are the same", {
        oldUserId,
        newUserId,
      });
      res.status(400).json({ok: false, error: "oldUserId and newUserId must be different when both provided."});
      return;
    }

    console.log("[userSetupApi] Starting migration", {
      oldUserId: oldUserId || "(empty)",
      newUserId,
    });

    const db = getFirestore();
    try {
      const result = await migrateUser(oldUserId, newUserId, db);

      console.log("[userSetupApi] Migration result", {
        ok: result.ok,
        error: result.error || null,
      });

      if (result.error) {
        console.error("[userSetupApi] Migration failed with error", {
          error: result.error,
        });
        res.status(400).json({ok: false, error: result.error});
        return;
      }

      console.log("[userSetupApi] Migration completed successfully");
      res.status(200).json({ok: true, message: "User data migrated successfully."});
    } catch (err) {
      console.error("[userSetupApi] Unexpected error", {
        error: err.message,
        stack: err.stack,
        name: err.name,
      });
      console.error("userSetupApi:", err);
      res.status(500).json({ok: false, error: err.message || "Migration failed."});
    }
  },
);

module.exports = {userSetupApi};
