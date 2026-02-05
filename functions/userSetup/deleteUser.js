/**
 * User Deletion: Completely removes a user from the app.
 * - Deletes user document from users collection
 * - Deletes all documents with userId from related collections
 * - Deletes user's files from storage (meals/, selfies/)
 * - Deletes user from Firebase Authentication
 */

const {getFirestore} = require("firebase-admin/firestore");
const {getStorage} = require("firebase-admin/storage");
const {getAuth} = require("firebase-admin/auth");

// Logging utility for consistent prefixed logs
const log = {
  info: (...args) => console.log("[DELETE_USER INFO]", ...args),
  warn: (...args) => console.warn("[DELETE_USER WARN]", ...args),
  error: (...args) => console.error("[DELETE_USER ERROR]", ...args),
  debug: (...args) => console.log("[DELETE_USER DEBUG]", ...args),
};

// Collections to delete user data from
const COLLECTIONS_TO_DELETE = ["daily_tasks", "face-analysis", "meal-analysis", "reel_progress"];

// Storage folders to delete user files from
const STORAGE_FOLDERS = ["meals", "selfies"];

/**
 * Deletes all documents in a collection where userId matches.
 */
async function deleteFromCollection(firestore, collectionName, userId) {
  log.info(`deleteFromCollection: Processing "${collectionName}" for userId="${userId}"`);

  const coll = firestore.collection(collectionName);
  const snapshot = await coll.where("userId", "==", userId).get();

  log.info(`deleteFromCollection: "${collectionName}" - found ${snapshot.size} documents to delete`);

  if (snapshot.empty) {
    log.info(`deleteFromCollection: "${collectionName}" - no documents found`);
    return 0;
  }

  const batch = firestore.batch();
  let deleteCount = 0;

  for (const docSnap of snapshot.docs) {
    log.debug(`deleteFromCollection: "${collectionName}" - deleting doc ID="${docSnap.id}"`);
    batch.delete(docSnap.ref);
    deleteCount++;
  }

  await batch.commit();
  log.info(`deleteFromCollection: "${collectionName}" - deleted ${deleteCount} documents`);

  return deleteCount;
}

/**
 * Deletes user document from users collection.
 * Searches by document ID and by id field.
 */
async function deleteUserDocument(firestore, userId) {
  log.info(`deleteUserDocument: Searching for user document with userId="${userId}"`);

  const usersColl = firestore.collection("users");
  let deleted = false;

  // Try by document ID
  const byDocId = usersColl.doc(userId);
  const snap = await byDocId.get();
  if (snap.exists) {
    log.info(`deleteUserDocument: Found user doc by document ID="${userId}", deleting...`);
    await byDocId.delete();
    deleted = true;
  }

  // Also try by id field (in case document ID differs)
  const byIdField = await usersColl.where("id", "==", userId).get();
  if (!byIdField.empty) {
    log.info(`deleteUserDocument: Found ${byIdField.size} user doc(s) by id field="${userId}", deleting...`);
    const batch = firestore.batch();
    for (const doc of byIdField.docs) {
      log.debug(`deleteUserDocument: Deleting doc ID="${doc.id}"`);
      batch.delete(doc.ref);
    }
    await batch.commit();
    deleted = true;
  }

  if (!deleted) {
    log.warn(`deleteUserDocument: No user document found for userId="${userId}"`);
  }

  return deleted;
}

/**
 * Deletes all files in a storage folder for a user.
 */
async function deleteStorageFolder(bucket, folder, userId) {
  const prefix = `${folder}/${userId}/`;
  log.info(`deleteStorageFolder: Deleting files with prefix="${prefix}"`);

  try {
    const [files] = await bucket.getFiles({prefix});
    log.info(`deleteStorageFolder: Found ${files.length} files in "${folder}/" for userId="${userId}"`);

    if (files.length === 0) {
      log.info(`deleteStorageFolder: No files to delete in "${folder}/"`);
      return 0;
    }

    let deleteCount = 0;
    for (const file of files) {
      log.debug(`deleteStorageFolder: Deleting file "${file.name}"`);
      await file.delete();
      deleteCount++;
    }

    log.info(`deleteStorageFolder: Deleted ${deleteCount} files from "${folder}/"`);
    return deleteCount;
  } catch (err) {
    log.error(`deleteStorageFolder: Error deleting files from "${folder}/":`, err.message);
    return 0;
  }
}

/**
 * Deletes all user files from storage.
 */
async function deleteUserStorage(userId) {
  log.info(`deleteUserStorage: Deleting storage files for userId="${userId}"`);

  const storage = getStorage();
  const bucket = storage.bucket();

  const results = {};
  for (const folder of STORAGE_FOLDERS) {
    const count = await deleteStorageFolder(bucket, folder, userId);
    results[folder] = count;
  }

  log.info(`deleteUserStorage: Storage deletion results: ${JSON.stringify(results)}`);
  return results;
}

/**
 * Deletes user from Firebase Authentication.
 */
async function deleteFromAuth(userId) {
  log.info(`deleteFromAuth: Attempting to delete user from Firebase Auth, uid="${userId}"`);

  try {
    const auth = getAuth();
    await auth.deleteUser(userId);
    log.info("deleteFromAuth: Successfully deleted user from Firebase Auth");
    return true;
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      log.warn("deleteFromAuth: User not found in Firebase Auth (may not be an auth user)");
      return false;
    }
    log.error("deleteFromAuth: Error deleting user from Firebase Auth:", err.message);
    throw err;
  }
}

/**
 * Completely deletes a user from the app.
 * @param {string} userId - The user ID to delete
 * @param {FirebaseFirestore.Firestore} [db] - Optional Firestore instance
 * @returns {Promise<object>} Deletion results
 */
async function deleteUser(userId, db) {
  log.info("=".repeat(70));
  log.info("deleteUser: STARTING USER DELETION");
  log.info(`deleteUser: userId="${userId}"`);
  log.info("=".repeat(70));

  const firestore = db || getFirestore();

  // Validate input
  if (!userId || userId.trim() === "") {
    log.error("deleteUser: FAILED - userId is required");
    return {ok: false, error: "userId is required"};
  }

  const userIdTrimmed = userId.trim();

  const results = {
    userDocument: false,
    collections: {},
    storage: {},
    auth: false,
  };

  // ==================== Step 1: Delete from related collections ====================
  log.info("=".repeat(70));
  log.info("deleteUser: Step 1 - Deleting from related collections...");
  log.info(`deleteUser: Collections: ${COLLECTIONS_TO_DELETE.join(", ")}`);
  log.info("=".repeat(70));

  for (const collName of COLLECTIONS_TO_DELETE) {
    const count = await deleteFromCollection(firestore, collName, userIdTrimmed);
    results.collections[collName] = count;
  }

  // ==================== Step 2: Delete user document ====================
  log.info("=".repeat(70));
  log.info("deleteUser: Step 2 - Deleting user document...");
  log.info("=".repeat(70));

  results.userDocument = await deleteUserDocument(firestore, userIdTrimmed);

  // ==================== Step 3: Delete from storage ====================
  log.info("=".repeat(70));
  log.info("deleteUser: Step 3 - Deleting from storage...");
  log.info(`deleteUser: Storage folders: ${STORAGE_FOLDERS.join(", ")}`);
  log.info("=".repeat(70));

  results.storage = await deleteUserStorage(userIdTrimmed);

  // ==================== Step 4: Delete from Firebase Auth ====================
  log.info("=".repeat(70));
  log.info("deleteUser: Step 4 - Deleting from Firebase Authentication...");
  log.info("=".repeat(70));

  results.auth = await deleteFromAuth(userIdTrimmed);

  // ==================== Summary ====================
  log.info("=".repeat(70));
  log.info("deleteUser: DELETION COMPLETED");
  log.info(`deleteUser: User document deleted: ${results.userDocument}`);
  log.info(`deleteUser: Collections: ${JSON.stringify(results.collections)}`);
  log.info(`deleteUser: Storage: ${JSON.stringify(results.storage)}`);
  log.info(`deleteUser: Auth deleted: ${results.auth}`);
  log.info("=".repeat(70));

  return {ok: true, ...results};
}

module.exports = {
  deleteUser,
  COLLECTIONS_TO_DELETE,
  STORAGE_FOLDERS,
};
