/**
 * Delete User API: HTTP endpoint that completely removes a user from the app.
 * Deletes from all collections, storage, and Firebase Authentication.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {getFirestore} = require("firebase-admin/firestore");
const {deleteUser} = require("./userSetup/deleteUser");

const deleteUserApi = onRequest(
  {
    region: "us-central1",
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST" && req.method !== "DELETE") {
      res.status(405).json({ok: false, error: "Method Not Allowed. Use POST or DELETE."});
      return;
    }

    const body = typeof req.body === "object" && req.body !== null ? req.body : {};
    const userId = (body.userId ?? body.user_id ?? "").toString().trim();

    if (!userId) {
      res.status(400).json({
        ok: false,
        error: "Missing userId. Send JSON: { userId: \"user-id-to-delete\" }",
      });
      return;
    }

    const db = getFirestore();
    try {
      console.log(`deleteUserApi: Deleting user "${userId}"...`);
      const result = await deleteUser(userId, db);

      if (result.error) {
        res.status(400).json({ok: false, error: result.error});
        return;
      }

      res.status(200).json({
        ok: true,
        message: "User deleted successfully.",
        details: {
          userDocument: result.userDocument,
          collections: result.collections,
          storage: result.storage,
          authDeleted: result.auth,
        },
      });
    } catch (err) {
      console.error("deleteUserApi:", err);
      res.status(500).json({ok: false, error: err.message || "Deletion failed."});
    }
  },
);

module.exports = {deleteUserApi};
