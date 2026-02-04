/**
 * User ID migration: copies Firestore documents and Storage files from
 * oldUserId to newUserId, rewrites imageUrl/userId in entries, then deletes old docs.
 */

const {getStorage} = require("firebase-admin/storage");
const {getFirestore} = require("firebase-admin/firestore");
const crypto = require("crypto");

const COLLECTIONS = ["users", "daily_tasks", "face-analysis", "meal-analysis", "videos"];
const STORAGE_FOLDERS = ["selfies", "meals"];
const USERS_ID_FIELD = "id";

/**
 * Builds Firebase Storage download URL for a file path and token.
 * @param {string} bucketName - Bucket name (e.g. rysy-dev.firebasestorage.app)
 * @param {string} path - File path (e.g. selfies/userId/file.jpg)
 * @param {string} token - firebaseStorageDownloadTokens value
 * @returns {string}
 */
function buildDownloadUrl(bucketName, path, token) {
  const encoded = encodeURIComponent(path).replace(/%2F/g, "%2F");
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

/**
 * Copies all files from a storage folder prefix to a new prefix and returns
 * a map of old URL -> new URL for rewriting Firestore fields.
 * @param {object} bucket - GCS Bucket
 * @param {string} bucketName - Bucket name for URLs
 * @param {string} folder - Folder name (selfies or meals)
 * @param {string} oldUserId - Source user ID path segment
 * @param {string} newUserId - Dest user ID path segment
 * @returns {Promise<Map<string, string>>} oldUrl -> newUrl
 */
async function copyStorageFolder(bucket, bucketName, folder, oldUserId, newUserId) {
  const prefix = `${folder}/${oldUserId}/`;
  const [files] = await bucket.getFiles({prefix});
  const urlMap = new Map();

  for (const file of files) {
    if (!file.name || file.name === prefix) continue;
    const fileName = file.name.slice(prefix.length);
    if (!fileName) continue;
    const oldPath = file.name;
    let oldUrl = "";
    try {
      const [oldMeta] = await file.getMetadata();
      const meta = oldMeta && oldMeta.metadata ? oldMeta.metadata : {};
      const oldToken = meta.firebaseStorageDownloadTokens || meta.firebaseStorageDownloadToken || "";
      if (oldToken) oldUrl = buildDownloadUrl(bucketName, oldPath, oldToken);
    } catch (_) {
      // Use urlMap by path if metadata unavailable
    }

    const newPath = `${folder}/${newUserId}/${fileName}`;
    const destFile = bucket.file(newPath);
    await file.copy(destFile);
    const [meta] = await destFile.getMetadata();
    const metadata = (meta && meta.metadata) || {};
    let token = metadata.firebaseStorageDownloadTokens || metadata.firebaseStorageDownloadToken;
    if (!token) {
      token = crypto.randomUUID();
      await destFile.setMetadata({metadata: {firebaseStorageDownloadTokens: token}});
    }
    const newUrl = buildDownloadUrl(bucketName, newPath, token);
    if (oldUrl) urlMap.set(oldUrl, newUrl);
    urlMap.set(oldPath, newUrl);
  }

  return urlMap;
}

/**
 * Copies all storage files from selfies/oldUserId and meals/oldUserId to
 * newUserId paths. Returns a combined map of old URL -> new URL.
 * @param {string} oldUserId
 * @param {string} newUserId
 * @returns {Promise<Map<string, string>>}
 */
async function copyStorageForUser(oldUserId, newUserId) {
  const storage = getStorage();
  const bucket = storage.bucket();
  const bucketName = bucket.name;
  const combined = new Map();

  for (const folder of STORAGE_FOLDERS) {
    try {
      const map = await copyStorageFolder(bucket, bucketName, folder, oldUserId, newUserId);
      map.forEach((v, k) => combined.set(k, v));
    } catch (err) {
      console.warn("userSetup copyStorageForUser:", folder, oldUserId, err);
    }
  }

  return combined;
}

/**
 * Rewrites imageUrl and userId in face-analysis or meal-analysis entries.
 * @param {object} data - Document data with entries array
 * @param {string} newUserId
 * @param {Map<string, string>} urlMap - oldUrl -> newUrl (and oldPath -> newUrl)
 */
function rewriteEntries(data, newUserId, urlMap) {
  if (!data || !Array.isArray(data.entries)) return data;
  const entries = data.entries.map((entry) => {
    const out = {...entry};
    if (out.userId !== undefined) out.userId = newUserId;
    if (typeof out.imageUrl === "string" && out.imageUrl) {
      const newUrl = urlMap.get(out.imageUrl);
      if (newUrl) out.imageUrl = newUrl;
      else {
        for (const [oldKey, newUrl] of urlMap) {
          if (oldKey.length > 10 && (out.imageUrl.includes(oldKey) || out.imageUrl === oldKey)) {
            out.imageUrl = newUrl;
            break;
          }
        }
      }
    }
    return out;
  });
  return {...data, entries};
}

/**
 * Builds an update object with only the fields that need to be changed (userId and imageUrl).
 * This ensures we only update specific fields without replacing the entire document.
 * Uses Firestore's dot notation for nested fields.
 * @param {object} originalData - Original document data
 * @param {string} oldUserId
 * @param {string} newUserId
 * @param {Map<string, string>} urlMap
 * @returns {object} Update object with only changed fields (using dot notation for nested)
 */
function buildUpdateObject(originalData, oldUserId, newUserId, urlMap) {
  if (!originalData || typeof originalData !== "object") return {userId: newUserId};

  const updateFields = {userId: newUserId};

  // Recursively find and update imageUrl fields using Firestore dot notation
  const updateUrls = (obj, pathPrefix = "") => {
    if (!obj || typeof obj !== "object") return;

    // Check for imageUrl at current level
    if (typeof obj.imageUrl === "string" && obj.imageUrl) {
      const newUrl = urlMap.get(obj.imageUrl);
      if (newUrl) {
        const fieldPath = pathPrefix ? `${pathPrefix}.imageUrl` : "imageUrl";
        updateFields[fieldPath] = newUrl;
      } else if (obj.imageUrl.includes(oldUserId)) {
        const fieldPath = pathPrefix ? `${pathPrefix}.imageUrl` : "imageUrl";
        updateFields[fieldPath] = obj.imageUrl.split(oldUserId).join(newUserId);
      }
    }

    // Recursively check nested objects (skip arrays as Firestore doesn't support array index updates)
    if (Array.isArray(obj)) {
      // For arrays, we can't update individual elements, so skip
      return;
    }

    Object.keys(obj).forEach((key) => {
      const value = obj[key];
      // Only process nested objects, skip arrays and primitives
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nestedPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        updateUrls(value, nestedPath);
      }
    });
  };

  updateUrls(originalData);
  return updateFields;
}

const SUBCOLLECTIONS_BY_USER_ID = ["daily_tasks", "face-analysis", "meal-analysis", "videos"];

/**
 * Finds the existing user document to migrate: by document ID first, then by id field.
 * Returns { ref, data } or null. Ensures we resolve the actual document ID when the
 * client only knows the id field (e.g. auth UID) but the doc was created with .add().
 * @param {FirebaseFirestore.CollectionReference} usersColl
 * @param {string} oldUserId - Document ID or id field value to look up
 * @param {string} newUserId - Desired canonical user ID (e.g. auth UID)
 * @returns {Promise<{ ref: FirebaseFirestore.DocumentReference, data: object, actualOldUserId: string } | null>}
 */
async function findUserDocToMigrate(usersColl, oldUserId, newUserId) {
  const byDocId = usersColl.doc(oldUserId);
  const snap = await byDocId.get();
  if (snap.exists) {
    return {ref: byDocId, data: snap.data(), actualOldUserId: oldUserId};
  }
  const byIdField = await usersColl.where(USERS_ID_FIELD, "==", newUserId).limit(1).get();
  if (!byIdField.empty) {
    const doc = byIdField.docs[0];
    if (doc.ref.id !== newUserId) {
      return {ref: doc.ref, data: doc.data(), actualOldUserId: doc.ref.id};
    }
  }
  return null;
}

/**
 * Performs full migration:
 * - Users: copy user doc to a new document whose document ID = newUserId and id field = newUserId
 *   (so document ID and id stay the same), then delete the old doc. Preserves email, subscription, etc.
 * - daily_tasks, face-analysis, meal-analysis, videos: only update userId field (and
 *   rewrite imageUrl where needed); do not delete or create documents.
 * @param {string} oldUserId
 * @param {string} newUserId
 * @param {FirebaseFirestore.Firestore} [db]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function migrateUser(oldUserId, newUserId, db) {
  const firestore = db || getFirestore();
  if (!newUserId || newUserId.trim() === "") {
    return {ok: false, error: "newUserId is required"};
  }
  const newUserIdTrimmed = newUserId.trim();
  const oldUserIdTrimmed = (oldUserId || "").trim();

  const usersColl = firestore.collection("users");
  const newUserRef = usersColl.doc(newUserIdTrimmed);

  const found = await findUserDocToMigrate(usersColl, oldUserIdTrimmed || newUserIdTrimmed, newUserIdTrimmed);
  if (!found) {
    return {ok: true};
  }

  const {ref: oldUserRef, data: userData, actualOldUserId} = found;
  if (actualOldUserId === newUserIdTrimmed) {
    return {ok: true};
  }

  const urlMap = await copyStorageForUser(actualOldUserId, newUserIdTrimmed);

  // 1. Users: create new doc and delete old in one transaction so the collection never briefly disappears
  const merged = {...userData, [USERS_ID_FIELD]: newUserIdTrimmed};
  await firestore.runTransaction(async (transaction) => {
    const [oldSnap, newSnap] = await Promise.all([oldUserRef.get(), newUserRef.get()]);
    if (!oldSnap.exists) return;
    const newData = newSnap.exists ? newSnap.data() : null;
    const alreadyMigrated = newData && newData[USERS_ID_FIELD] === newUserIdTrimmed;
    if (alreadyMigrated) return;
    transaction.set(newUserRef, merged);
    transaction.delete(oldUserRef);
  });

  // 2. Other collections: only update userId field (and imageUrl if needed) without replacing other data
  for (const collName of SUBCOLLECTIONS_BY_USER_ID) {
    const coll = firestore.collection(collName);
    const snapshot = await coll.where("userId", "==", actualOldUserId).get();
    if (snapshot.empty) continue;

    const writer = firestore.batch();
    for (const docSnap of snapshot.docs) {
      const ref = docSnap.ref;
      const originalData = docSnap.data();
      // Build update object with only userId and any imageUrl fields that need updating
      const updateFields = buildUpdateObject(originalData, actualOldUserId, newUserIdTrimmed, urlMap);
      // Use update() to only modify specified fields, preserving all other data
      writer.update(ref, updateFields);
    }
    await writer.commit();
  }

  return {ok: true};
}

module.exports = {
  copyStorageForUser,
  migrateUser,
  rewriteEntries,
  buildUpdateObject,
  COLLECTIONS,
  STORAGE_FOLDERS,
};
