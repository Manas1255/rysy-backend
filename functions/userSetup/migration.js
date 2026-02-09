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
  console.log("[copyStorageFolder] Starting folder copy", {
    folder,
    prefix,
    oldUserId,
    newUserId,
  });

  const [files] = await bucket.getFiles({prefix});
  console.log("[copyStorageFolder] Found files", {
    folder,
    prefix,
    fileCount: files.length,
    fileNames: files.map((f) => f.name).slice(0, 10), // Log first 10 file names
  });

  const urlMap = new Map();

  for (const file of files) {
    if (!file.name || file.name === prefix) {
      console.log("[copyStorageFolder] Skipping invalid file", {
        folder,
        fileName: file.name || "(empty)",
      });
      continue;
    }

    const fileName = file.name.slice(prefix.length);
    if (!fileName) {
      console.log("[copyStorageFolder] Skipping empty fileName", {
        folder,
        filePath: file.name,
      });
      continue;
    }

    const oldPath = file.name;
    let oldUrl = "";

    console.log("[copyStorageFolder] Processing file", {
      folder,
      oldPath,
      fileName,
    });

    try {
      const [oldMeta] = await file.getMetadata();
      const meta = oldMeta && oldMeta.metadata ? oldMeta.metadata : {};
      const oldToken = meta.firebaseStorageDownloadTokens || meta.firebaseStorageDownloadToken || "";
      if (oldToken) {
        oldUrl = buildDownloadUrl(bucketName, oldPath, oldToken);
        console.log("[copyStorageFolder] Retrieved old URL", {
          folder,
          fileName,
          hasOldUrl: !!oldUrl,
        });
      }
    } catch (err) {
      console.log("[copyStorageFolder] Could not get metadata, will use path mapping", {
        folder,
        fileName,
        error: err.message,
      });
      // Use urlMap by path if metadata unavailable
    }

    const newPath = `${folder}/${newUserId}/${fileName}`;
    const destFile = bucket.file(newPath);

    console.log("[copyStorageFolder] Copying file", {
      folder,
      from: oldPath,
      to: newPath,
    });

    await file.copy(destFile);

    const [meta] = await destFile.getMetadata();
    const metadata = (meta && meta.metadata) || {};
    let token = metadata.firebaseStorageDownloadTokens || metadata.firebaseStorageDownloadToken;

    if (!token) {
      console.log("[copyStorageFolder] Generating new token", {
        folder,
        fileName,
      });
      token = crypto.randomUUID();
      await destFile.setMetadata({metadata: {firebaseStorageDownloadTokens: token}});
    }

    const newUrl = buildDownloadUrl(bucketName, newPath, token);

    if (oldUrl) {
      urlMap.set(oldUrl, newUrl);
      console.log("[copyStorageFolder] Added URL mapping (oldUrl -> newUrl)", {
        folder,
        fileName,
        oldUrl,
        newUrl,
      });
    }
    urlMap.set(oldPath, newUrl);

    console.log("[copyStorageFolder] File copy completed", {
      folder,
      fileName,
      newUrl,
    });
  }

  console.log("[copyStorageFolder] Folder copy completed", {
    folder,
    filesProcessed: files.length,
    urlMapSize: urlMap.size,
  });

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
  console.log("[copyStorageForUser] Starting storage copy", {
    oldUserId,
    newUserId,
    folders: STORAGE_FOLDERS,
  });

  const storage = getStorage();
  const bucket = storage.bucket();
  const bucketName = bucket.name;

  console.log("[copyStorageForUser] Storage initialized", {
    bucketName,
  });

  const combined = new Map();

  for (const folder of STORAGE_FOLDERS) {
    console.log("[copyStorageForUser] Processing folder", {
      folder,
      oldUserId,
      newUserId,
    });

    try {
      const map = await copyStorageFolder(bucket, bucketName, folder, oldUserId, newUserId);
      console.log("[copyStorageForUser] Folder copy completed", {
        folder,
        urlMapSize: map.size,
      });
      map.forEach((v, k) => combined.set(k, v));
    } catch (err) {
      console.error("[copyStorageForUser] Error copying folder", {
        folder,
        oldUserId,
        error: err.message,
        stack: err.stack,
      });
      console.warn("userSetup copyStorageForUser:", folder, oldUserId, err);
    }
  }

  console.log("[copyStorageForUser] Storage copy completed", {
    totalUrlMapSize: combined.size,
    foldersProcessed: STORAGE_FOLDERS.length,
  });

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
  console.log("[buildUpdateObject] Building update object", {
    hasOriginalData: !!originalData,
    originalDataType: typeof originalData,
    oldUserId,
    newUserId,
    urlMapSize: urlMap.size,
  });

  if (!originalData || typeof originalData !== "object") {
    console.log("[buildUpdateObject] No original data, returning userId only");
    return {userId: newUserId};
  }

  // Always update the top-level userId field
  const updateFields = {userId: newUserId};
  console.log("[buildUpdateObject] Initial updateFields", {
    updateFields,
  });

  // Handle entries array if it exists (for face-analysis and meal-analysis)
  // Update imageUrl fields in entries, but entries don't have userId fields
  if (Array.isArray(originalData.entries)) {
    console.log("[buildUpdateObject] Found entries array", {
      entriesLength: originalData.entries.length,
    });

    let entriesUpdated = false;
    const updatedEntries = originalData.entries.map((entry, index) => {
      if (!entry || typeof entry !== "object") return entry;

      const updated = {...entry};
      let entryChanged = false;

      // Update imageUrl if it exists and references the old user ID
      if (typeof updated.imageUrl === "string" && updated.imageUrl) {
        const newUrl = urlMap.get(updated.imageUrl);
        if (newUrl) {
          updated.imageUrl = newUrl;
          entryChanged = true;
          console.log("[buildUpdateObject] Updated entry imageUrl from urlMap", {
            index,
            oldUrl: entry.imageUrl.substring(0, 100),
            newUrl: newUrl.substring(0, 100),
          });
        } else if (updated.imageUrl.includes(oldUserId)) {
          updated.imageUrl = updated.imageUrl.split(oldUserId).join(newUserId);
          entryChanged = true;
          console.log("[buildUpdateObject] Updated entry imageUrl by string replacement", {
            index,
            oldUrl: entry.imageUrl.substring(0, 100),
            newUrl: updated.imageUrl.substring(0, 100),
          });
        }
      }

      if (entryChanged) {
        entriesUpdated = true;
      }

      return updated;
    });

    // Only update entries array if we actually changed something
    if (entriesUpdated) {
      updateFields.entries = updatedEntries;
      console.log("[buildUpdateObject] Set entries array update", {
        entriesCount: updatedEntries.length,
        entriesUpdated: true,
      });
    } else {
      console.log("[buildUpdateObject] No changes needed in entries array", {
        entriesCount: updatedEntries.length,
      });
    }
  }

  // Check for other top-level imageUrl fields (not in entries array)
  if (typeof originalData.imageUrl === "string" && originalData.imageUrl) {
    const newUrl = urlMap.get(originalData.imageUrl);
    if (newUrl) {
      updateFields.imageUrl = newUrl;
      console.log("[buildUpdateObject] Updated top-level imageUrl from urlMap", {
        oldUrl: originalData.imageUrl.substring(0, 100),
        newUrl: newUrl.substring(0, 100),
      });
    } else if (originalData.imageUrl.includes(oldUserId)) {
      updateFields.imageUrl = originalData.imageUrl.split(oldUserId).join(newUserId);
      console.log("[buildUpdateObject] Updated top-level imageUrl by string replacement", {
        oldUrl: originalData.imageUrl.substring(0, 100),
        newUrl: updateFields.imageUrl.substring(0, 100),
      });
    }
  }

  console.log("[buildUpdateObject] Final updateFields", {
    updateFields,
    fieldCount: Object.keys(updateFields).length,
  });

  return updateFields;
}

// Collections to update userId in during migration
// Note: Collection names use different separators (underscore vs dash) - this is intentional
// and matches the actual Firestore collection names
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
  console.log("[findUserDocToMigrate] Starting search", {
    oldUserId: oldUserId || "(empty)",
    newUserId,
    searchStrategy: "byDocId_first",
  });

  // Only search by document ID if oldUserId is provided and different from newUserId
  // If oldUserId is empty or equals newUserId, skip document ID search and go straight to id field search
  const shouldSearchByDocId = oldUserId && oldUserId.trim() !== "" && oldUserId !== newUserId;

  if (shouldSearchByDocId) {
    const byDocId = usersColl.doc(oldUserId);
    console.log("[findUserDocToMigrate] Checking document by ID", {
      documentId: oldUserId,
    });

    const snap = await byDocId.get();

    console.log("[findUserDocToMigrate] Document by ID result", {
      documentId: oldUserId,
      exists: snap.exists,
    });

    if (snap.exists) {
      const data = snap.data();
      console.log("[findUserDocToMigrate] Found by document ID", {
        documentId: oldUserId,
        dataKeys: Object.keys(data || {}),
        idField: data?.[USERS_ID_FIELD],
      });
      return {ref: byDocId, data, actualOldUserId: oldUserId};
    }
  } else {
    console.log("[findUserDocToMigrate] Skipping document ID search", {
      reason: !oldUserId || oldUserId.trim() === "" ? "oldUserId is empty" : "oldUserId equals newUserId",
      oldUserId: oldUserId || "(empty)",
      newUserId,
    });
  }

  // If oldUserId is provided, search by id field using oldUserId
  // Otherwise, fall back to searching by newUserId (for cases where oldUserId wasn't provided)
  const searchValue = oldUserId && oldUserId.trim() !== "" ? oldUserId : newUserId;

  console.log("[findUserDocToMigrate] Not found by document ID, searching by id field", {
    idField: USERS_ID_FIELD,
    searchValue,
    usingOldUserId: oldUserId && oldUserId.trim() !== "",
  });

  const byIdField = await usersColl.where(USERS_ID_FIELD, "==", searchValue).limit(1).get();

  console.log("[findUserDocToMigrate] Query by id field result", {
    idField: USERS_ID_FIELD,
    searchValue,
    foundCount: byIdField.size,
  });

  if (!byIdField.empty) {
    const doc = byIdField.docs[0];
    console.log("[findUserDocToMigrate] Found by id field", {
      documentId: doc.ref.id,
      idFieldValue: doc.data()?.[USERS_ID_FIELD],
      newUserId,
    });

    if (doc.ref.id !== newUserId) {
      console.log("[findUserDocToMigrate] Document ID mismatch, will migrate", {
        documentId: doc.ref.id,
        idFieldValue: doc.data()?.[USERS_ID_FIELD],
        newUserId,
      });
      return {ref: doc.ref, data: doc.data(), actualOldUserId: doc.ref.id};
    } else {
      console.log("[findUserDocToMigrate] Document ID matches newUserId, no migration needed");
    }
  }

  console.log("[findUserDocToMigrate] No user document found");
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
  console.log("[migrateUser] Starting migration", {
    oldUserId: oldUserId || "(empty)",
    newUserId: newUserId || "(empty)",
    timestamp: new Date().toISOString(),
  });

  const firestore = db || getFirestore();
  if (!newUserId || newUserId.trim() === "") {
    console.error("[migrateUser] Error: newUserId is required");
    return {ok: false, error: "newUserId is required"};
  }
  const newUserIdTrimmed = newUserId.trim();
  const oldUserIdTrimmed = (oldUserId || "").trim();

  console.log("[migrateUser] Trimmed IDs", {
    oldUserIdTrimmed: oldUserIdTrimmed || "(empty)",
    newUserIdTrimmed,
  });

  const usersColl = firestore.collection("users");
  const newUserRef = usersColl.doc(newUserIdTrimmed);

  console.log("[migrateUser] Looking for user document", {
    searchOldUserId: oldUserIdTrimmed || newUserIdTrimmed,
    newUserIdTrimmed,
  });

  const found = await findUserDocToMigrate(usersColl, oldUserIdTrimmed || newUserIdTrimmed, newUserIdTrimmed);
  if (!found) {
    console.log("[migrateUser] No user document found to migrate");
    return {ok: true};
  }

  const {ref: oldUserRef, data: userData, actualOldUserId} = found;
  console.log("[migrateUser] Found user document", {
    actualOldUserId,
    oldDocId: oldUserRef.id,
    newUserIdTrimmed,
    userDataKeys: userData ? Object.keys(userData) : [],
  });

  if (actualOldUserId === newUserIdTrimmed) {
    console.log("[migrateUser] User already migrated (actualOldUserId === newUserIdTrimmed)");
    return {ok: true};
  }

  console.log("[migrateUser] Starting storage copy", {
    fromUserId: actualOldUserId,
    toUserId: newUserIdTrimmed,
  });
  const urlMap = await copyStorageForUser(actualOldUserId, newUserIdTrimmed);
  console.log("[migrateUser] Storage copy completed", {
    urlMapSize: urlMap.size,
    urlMapEntries: Array.from(urlMap.entries()).slice(0, 5), // Log first 5 entries
  });

  // 1. Users: create new doc and delete old in one transaction so the collection never briefly disappears
  const merged = {...userData, [USERS_ID_FIELD]: newUserIdTrimmed};
  console.log("[migrateUser] Starting user document migration transaction", {
    oldDocId: oldUserRef.id,
    newDocId: newUserRef.id,
    mergedKeys: Object.keys(merged),
  });

  await firestore.runTransaction(async (transaction) => {
    console.log("[migrateUser] Transaction: Reading documents", {
      oldDocId: oldUserRef.id,
      newDocId: newUserRef.id,
    });
    const [oldSnap, newSnap] = await Promise.all([oldUserRef.get(), newUserRef.get()]);

    console.log("[migrateUser] Transaction: Document states", {
      oldDocExists: oldSnap.exists,
      newDocExists: newSnap.exists,
    });

    if (!oldSnap.exists) {
      console.log("[migrateUser] Transaction: Old document does not exist, skipping");
      return;
    }

    const newData = newSnap.exists ? newSnap.data() : null;
    const alreadyMigrated = newData && newData[USERS_ID_FIELD] === newUserIdTrimmed;

    console.log("[migrateUser] Transaction: Migration check", {
      alreadyMigrated,
      newDataIdField: newData ? newData[USERS_ID_FIELD] : null,
    });

    if (alreadyMigrated) {
      console.log("[migrateUser] Transaction: Already migrated, skipping");
      return;
    }

    console.log("[migrateUser] Transaction: Setting new document and deleting old", {
      newDocId: newUserRef.id,
      oldDocId: oldUserRef.id,
    });
    transaction.set(newUserRef, merged);
    transaction.delete(oldUserRef);
  });

  console.log("[migrateUser] User document migration completed");

  // 2. Other collections: only update userId field (and imageUrl if needed) without replacing other data
  console.log("[migrateUser] Starting collection updates", {
    collections: SUBCOLLECTIONS_BY_USER_ID,
    actualOldUserId,
    newUserIdTrimmed,
  });

  for (const collName of SUBCOLLECTIONS_BY_USER_ID) {
    console.log(`[migrateUser] Processing collection: ${collName}`, {
      collectionName: collName,
      queryUserId: actualOldUserId,
    });

    const coll = firestore.collection(collName);
    console.log(`[migrateUser] Querying ${collName} for userId == ${actualOldUserId}`);

    const snapshot = await coll.where("userId", "==", actualOldUserId).get();

    console.log(`[migrateUser] Query result for ${collName}`, {
      collectionName: collName,
      documentCount: snapshot.size,
      documentIds: snapshot.docs.map((d) => d.id),
    });

    if (snapshot.empty) {
      console.log(`[migrateUser] No documents found in ${collName}, skipping`);
      continue;
    }

    console.log(`[migrateUser] Preparing batch update for ${collName}`, {
      collectionName: collName,
      documentCount: snapshot.size,
    });

    const writer = firestore.batch();
    let batchCount = 0;

    for (const docSnap of snapshot.docs) {
      const ref = docSnap.ref;
      const originalData = docSnap.data();

      console.log(`[migrateUser] Processing document in ${collName}`, {
        collectionName: collName,
        documentId: ref.id,
        originalUserId: originalData.userId,
        dataKeys: Object.keys(originalData),
      });

      // Build update object with only userId and any imageUrl fields that need updating
      const updateFields = buildUpdateObject(originalData, actualOldUserId, newUserIdTrimmed, urlMap);

      console.log(`[migrateUser] Update fields for ${collName}/${ref.id}`, {
        collectionName: collName,
        documentId: ref.id,
        updateFields,
        updateFieldKeys: Object.keys(updateFields),
      });

      // Use update() to only modify specified fields, preserving all other data
      writer.update(ref, updateFields);
      batchCount++;
    }

    console.log(`[migrateUser] Committing batch for ${collName}`, {
      collectionName: collName,
      batchSize: batchCount,
    });

    await writer.commit();

    console.log(`[migrateUser] Successfully updated ${collName}`, {
      collectionName: collName,
      documentsUpdated: batchCount,
    });
  }

  console.log("[migrateUser] Migration completed successfully", {
    oldUserId: actualOldUserId,
    newUserId: newUserIdTrimmed,
    timestamp: new Date().toISOString(),
  });

  return {ok: true};
}

/**
 * Deletes all storage files for a user from selfies and meals folders.
 * @param {string} userId - User ID
 * @returns {Promise<{ deletedCount: number, errors: Array<string> }>}
 */
async function deleteStorageForUser(userId) {
  console.log("[deleteStorageForUser] Starting storage deletion", {
    userId,
    folders: STORAGE_FOLDERS,
  });

  const {getStorage} = require("firebase-admin/storage");
  const storage = getStorage();
  const bucket = storage.bucket();
  const bucketName = bucket.name;

  console.log("[deleteStorageForUser] Storage initialized", {
    bucketName,
  });

  let totalDeleted = 0;
  const errors = [];

  for (const folder of STORAGE_FOLDERS) {
    const prefix = `${folder}/${userId}/`;
    console.log("[deleteStorageForUser] Processing folder", {
      folder,
      prefix,
      userId,
    });

    try {
      const [files] = await bucket.getFiles({prefix});
      console.log("[deleteStorageForUser] Found files", {
        folder,
        prefix,
        fileCount: files.length,
      });

      if (files.length === 0) {
        console.log("[deleteStorageForUser] No files found in folder", {
          folder,
          prefix,
        });
        continue;
      }

      // Delete files in batches
      const deletePromises = files.map(async (file) => {
        try {
          await file.delete();
          console.log("[deleteStorageForUser] Deleted file", {
            folder,
            fileName: file.name,
          });
          return true;
        } catch (err) {
          console.error("[deleteStorageForUser] Error deleting file", {
            folder,
            fileName: file.name,
            error: err.message,
          });
          errors.push(`Failed to delete ${file.name}: ${err.message}`);
          return false;
        }
      });

      const results = await Promise.all(deletePromises);
      const deletedCount = results.filter((r) => r === true).length;
      totalDeleted += deletedCount;

      console.log("[deleteStorageForUser] Folder deletion completed", {
        folder,
        filesFound: files.length,
        filesDeleted: deletedCount,
      });
    } catch (err) {
      console.error("[deleteStorageForUser] Error processing folder", {
        folder,
        userId,
        error: err.message,
        stack: err.stack,
      });
      errors.push(`Failed to process folder ${folder}: ${err.message}`);
    }
  }

  console.log("[deleteStorageForUser] Storage deletion completed", {
    totalDeleted,
    errorsCount: errors.length,
  });

  return {deletedCount: totalDeleted, errors};
}

/**
 * Deletes a storage file from a URL if it's a Firebase Storage URL.
 * @param {string} url - Storage URL
 * @returns {Promise<boolean>} True if deleted, false otherwise
 */
async function deleteStorageFileFromUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  // Check if it's a Firebase Storage URL
  const storageUrlPattern = /firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?]+)/;
  const match = url.match(storageUrlPattern);
  if (!match) {
    console.log("[deleteStorageFileFromUrl] Not a Firebase Storage URL", {
      url: url.substring(0, 100),
    });
    return false;
  }

  const bucketName = match[1];
  const encodedPath = match[2];
  const filePath = decodeURIComponent(encodedPath);

  console.log("[deleteStorageFileFromUrl] Parsed URL", {
    bucketName,
    filePath,
  });

  try {
    const {getStorage} = require("firebase-admin/storage");
    const storage = getStorage();
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePath);

    const [exists] = await file.exists();
    if (!exists) {
      console.log("[deleteStorageFileFromUrl] File does not exist", {
        filePath,
      });
      return false;
    }

    await file.delete();
    console.log("[deleteStorageFileFromUrl] Deleted file", {
      filePath,
    });
    return true;
  } catch (err) {
    console.error("[deleteStorageFileFromUrl] Error deleting file", {
      filePath,
      error: err.message,
    });
    return false;
  }
}

/**
 * Deletes a user and all their related documents from Firestore and Storage.
 * @param {string} userId - User ID to delete
 * @param {FirebaseFirestore.Firestore} [db]
 * @returns {Promise<{ ok: boolean, error?: string, deleted: { users: number, collections: Record<string, number>, storage: number } }>}
 */
async function deleteUser(userId, db) {
  console.log("[deleteUser] Starting user deletion", {
    userId: userId || "(empty)",
    timestamp: new Date().toISOString(),
  });

  const firestore = db || getFirestore();
  if (!userId || userId.trim() === "") {
    console.error("[deleteUser] Error: userId is required");
    return {ok: false, error: "userId is required"};
  }
  const userIdTrimmed = userId.trim();

  const deleted = {
    users: 0,
    collections: {},
    storage: 0,
  };

  try {
    // 1. Find and get user document to check for storage URLs
    const usersColl = firestore.collection("users");
    let userDoc = null;
    let userData = null;

    // Try by document ID first
    const userRef = usersColl.doc(userIdTrimmed);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      userDoc = userRef;
      userData = userSnap.data();
    } else {
      // Try by id field
      const byIdField = await usersColl.where(USERS_ID_FIELD, "==", userIdTrimmed).limit(1).get();
      if (!byIdField.empty) {
        userDoc = byIdField.docs[0].ref;
        userData = byIdField.docs[0].data();
      }
    }

    if (userDoc && userData) {
      console.log("[deleteUser] Found user document", {
        documentId: userDoc.id,
        dataKeys: Object.keys(userData),
      });

      // Delete imageForAiUrl file if it exists
      if (userData.imageForAiUrl && typeof userData.imageForAiUrl === "string") {
        console.log("[deleteUser] Deleting imageForAiUrl file", {
          url: userData.imageForAiUrl.substring(0, 100),
        });
        await deleteStorageFileFromUrl(userData.imageForAiUrl);
      }
    } else {
      console.log("[deleteUser] User document not found, continuing with collection cleanup", {
        userId: userIdTrimmed,
      });
    }

    // 2. Delete documents from collections that reference this user
    const collectionsToClean = [
      "daily_tasks",
      "face-analysis",
      "meal-analysis",
      "videos",
      "reel_progress",
      "reels",
    ];

    for (const collName of collectionsToClean) {
      console.log(`[deleteUser] Processing collection: ${collName}`, {
        collectionName: collName,
        userId: userIdTrimmed,
      });

      const coll = firestore.collection(collName);
      const snapshot = await coll.where("userId", "==", userIdTrimmed).get();

      console.log(`[deleteUser] Query result for ${collName}`, {
        collectionName: collName,
        documentCount: snapshot.size,
      });

      if (snapshot.empty) {
        console.log(`[deleteUser] No documents found in ${collName}, skipping`);
        deleted.collections[collName] = 0;
        continue;
      }

      // Delete documents in batches
      const batch = firestore.batch();
      let batchCount = 0;

      for (const docSnap of snapshot.docs) {
        batch.delete(docSnap.ref);
        batchCount++;

        // Firestore batch limit is 500 operations
        if (batchCount >= 500) {
          await batch.commit();
          console.log(`[deleteUser] Committed batch for ${collName}`, {
            collectionName: collName,
            batchSize: batchCount,
          });
          batchCount = 0;
        }
      }

      if (batchCount > 0) {
        await batch.commit();
        console.log(`[deleteUser] Committed final batch for ${collName}`, {
          collectionName: collName,
          batchSize: batchCount,
        });
      }

      deleted.collections[collName] = snapshot.size;
      console.log(`[deleteUser] Successfully deleted documents from ${collName}`, {
        collectionName: collName,
        documentsDeleted: snapshot.size,
      });
    }

    // 3. Delete user document
    if (userDoc) {
      await userDoc.delete();
      deleted.users = 1;
      console.log("[deleteUser] Deleted user document", {
        documentId: userDoc.id,
      });
    }

    // 4. Delete storage files (selfies and meals folders)
    const storageResult = await deleteStorageForUser(userIdTrimmed);
    deleted.storage = storageResult.deletedCount;

    if (storageResult.errors.length > 0) {
      console.warn("[deleteUser] Storage deletion had errors", {
        errors: storageResult.errors,
      });
    }

    console.log("[deleteUser] User deletion completed successfully", {
      userId: userIdTrimmed,
      deleted,
      timestamp: new Date().toISOString(),
    });

    return {ok: true, deleted};
  } catch (err) {
    console.error("[deleteUser] Error during deletion", {
      userId: userIdTrimmed,
      error: err.message,
      stack: err.stack,
      name: err.name,
    });
    return {ok: false, error: err.message || "Deletion failed", deleted};
  }
}

module.exports = {
  copyStorageForUser,
  migrateUser,
  rewriteEntries,
  buildUpdateObject,
  deleteUser,
  deleteStorageForUser,
  COLLECTIONS,
  STORAGE_FOLDERS,
};
