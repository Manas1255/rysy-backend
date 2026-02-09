/**
 * Delete User API: HTTP endpoint that deletes a user and all their
 * related documents from Firestore and Storage.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {getFirestore} = require("firebase-admin/firestore");
const {deleteUser} = require("./userSetup/migration");

const deleteUserApi = onRequest(
  {
    region: "us-central1",
    invoker: "public",
  },
  async (req, res) => {
    console.log("[deleteUserApi] Request received", {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"],
        "user-agent": req.headers["user-agent"],
      },
      bodyKeys: req.body ? Object.keys(req.body) : [],
      timestamp: new Date().toISOString(),
    });

    if (req.method !== "POST") {
      console.log("[deleteUserApi] Method not allowed", {
        method: req.method,
      });
      res.status(405).json({ok: false, error: "Method Not Allowed"});
      return;
    }

    const body = typeof req.body === "object" && req.body !== null ? req.body : {};
    const userId = (body.userId ?? body.user_id ?? "").toString().trim();

    console.log("[deleteUserApi] Parsed request body", {
      userId: userId || "(empty)",
      bodyKeys: Object.keys(body),
    });

    if (!userId) {
      console.error("[deleteUserApi] Missing userId");
      res.status(400).json({
        ok: false,
        error: "Missing userId. Send JSON: { userId }.",
      });
      return;
    }

    console.log("[deleteUserApi] Starting user deletion", {
      userId,
    });

    const db = getFirestore();
    try {
      const result = await deleteUser(userId, db);

      console.log("[deleteUserApi] Deletion result", {
        ok: result.ok,
        error: result.error || null,
        deleted: result.deleted || null,
      });

      if (result.error) {
        console.error("[deleteUserApi] Deletion failed with error", {
          error: result.error,
        });
        res.status(400).json({ok: false, error: result.error, deleted: result.deleted || null});
        return;
      }

      console.log("[deleteUserApi] User deletion completed successfully");
      res.status(200).json({
        ok: true,
        message: "User and all related data deleted successfully.",
        deleted: result.deleted,
      });
    } catch (err) {
      console.error("[deleteUserApi] Unexpected error", {
        error: err.message,
        stack: err.stack,
        name: err.name,
      });
      console.error("deleteUserApi:", err);
      res.status(500).json({ok: false, error: err.message || "Deletion failed."});
    }
  },
);

module.exports = {deleteUserApi};
