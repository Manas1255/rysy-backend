/**
 * Delete User API: HTTP endpoint that deletes a user and all their
 * related documents from Firestore and Storage.
 * Requires Firebase ID token authentication and reauthentication.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {getFirestore} = require("firebase-admin/firestore");
const {getAuth} = require("firebase-admin/auth");
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

    // ==================== Step 1: Verify Authentication Token ====================
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.error("[deleteUserApi] Missing or invalid Authorization header");
      res.status(401).json({
        ok: false,
        error: "Authentication required. Send Firebase ID token in Authorization header: 'Bearer <token>'.",
      });
      return;
    }

    const idToken = authHeader.split("Bearer ")[1];
    let decodedToken;
    try {
      const auth = getAuth();
      decodedToken = await auth.verifyIdToken(idToken);
      console.log("[deleteUserApi] Token verified", {
        uid: decodedToken.uid,
        email: decodedToken.email || null,
      });
    } catch (err) {
      console.error("[deleteUserApi] Token verification failed", {
        error: err.message,
        code: err.code,
      });
      
      // Handle specific Firebase Auth errors
      if (err.code === "auth/id-token-expired") {
        res.status(401).json({
          ok: false,
          error: "Token expired. Please reauthenticate and try again.",
          requiresReauth: true,
        });
        return;
      }
      
      res.status(401).json({
        ok: false,
        error: "Invalid authentication token. Please reauthenticate and try again.",
        requiresReauth: true,
      });
      return;
    }

    // ==================== Step 2: Parse and Validate Request Body ====================
    const body = typeof req.body === "object" && req.body !== null ? req.body : {};
    const userId = (body.userId ?? body.user_id ?? "").toString().trim();

    console.log("[deleteUserApi] Parsed request body", {
      userId: userId || "(empty)",
      bodyKeys: Object.keys(body),
      tokenUid: decodedToken.uid,
    });

    if (!userId) {
      console.error("[deleteUserApi] Missing userId");
      res.status(400).json({
        ok: false,
        error: "Missing userId. Send JSON: { userId }.",
      });
      return;
    }

    // ==================== Step 3: Verify User Authorization ====================
    // Ensure the authenticated user can only delete their own account
    if (decodedToken.uid !== userId) {
      console.error("[deleteUserApi] User ID mismatch", {
        tokenUid: decodedToken.uid,
        requestedUserId: userId,
      });
      res.status(403).json({
        ok: false,
        error: "You can only delete your own account. Token UID does not match requested userId.",
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
