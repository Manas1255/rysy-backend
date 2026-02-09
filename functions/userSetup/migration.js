/**
 * User ID migration: migrates guest user data to a real authenticated user.
 * - Updates the user document's id field to newUserId
 * - Updates userId in daily_tasks, face-analysis, meal-analysis collections
 */

const {getFirestore} = require("firebase-admin/firestore");

// Logging utility for consistent prefixed logs
const log = {
  info: (...args) => console.log("[MIGRATION INFO]", ...args),
  warn: (...args) => console.warn("[MIGRATION WARN]", ...args),
  error: (...args) => console.error("[MIGRATION ERROR]", ...args),
  debug: (...args) => console.log("[MIGRATION DEBUG]", ...args),
};

// Collections that need userId updated
const COLLECTIONS_TO_UPDATE = ["daily_tasks", "face-analysis", "meal-analysis", "reel_progress"];

/**
 * Finds the existing user document by document ID or by `id` field.
 */
async function findUserDoc(usersColl, searchId) {
  log.info(`findUserDoc: Searching for user doc with searchId="${searchId}"`);

  // Try by document ID first
  const byDocId = usersColl.doc(searchId);
  const snap = await byDocId.get();
  log.debug(`findUserDoc: Document lookup by ID="${searchId}", exists=${snap.exists}`);

  if (snap.exists) {
    log.info(`findUserDoc: Found user doc by document ID="${searchId}"`);
    const data = snap.data();
    log.debug(`findUserDoc: User doc data keys: ${Object.keys(data || {}).join(", ")}`);
    log.debug(`findUserDoc: User doc id field value: "${data?.id}"`);
    return {ref: byDocId, data: data};
  }

  // Try by id field
  log.debug(`findUserDoc: Document not found by ID, trying query where id=="${searchId}"`);
  const byIdField = await usersColl.where("id", "==", searchId).limit(1).get();
  log.debug(`findUserDoc: Query result empty=${byIdField.empty}, size=${byIdField.size}`);

  if (!byIdField.empty) {
    const doc = byIdField.docs[0];
    log.info(`findUserDoc: Found user doc by id field. Doc ID="${doc.ref.id}"`);
    return {ref: doc.ref, data: doc.data()};
  }

  log.info(`findUserDoc: No user document found for searchId="${searchId}"`);
  return null;
}

/**
 * Lists all documents in a collection that match either oldUserId or newUserId.
 * This helps us understand the current state of the collection.
 */
async function debugListCollectionDocs(firestore, collectionName, oldUserId, newUserId) {
  log.info(`debugListCollectionDocs: Checking "${collectionName}" for both old and new userIds`);

  const coll = firestore.collection(collectionName);

  // Check for oldUserId
  const oldSnapshot = await coll.where("userId", "==", oldUserId).get();
  log.info(`debugListCollectionDocs: "${collectionName}" docs with userId="${oldUserId}": ${oldSnapshot.size}`);
  for (const doc of oldSnapshot.docs) {
    log.debug(`  - Doc ID="${doc.id}", userId="${doc.data().userId}"`);
  }

  // Check for newUserId
  const newSnapshot = await coll.where("userId", "==", newUserId).get();
  log.info(`debugListCollectionDocs: "${collectionName}" docs with userId="${newUserId}": ${newSnapshot.size}`);
  for (const doc of newSnapshot.docs) {
    log.debug(`  - Doc ID="${doc.id}", userId="${doc.data().userId}"`);
  }

  return {
    oldCount: oldSnapshot.size,
    newCount: newSnapshot.size,
    oldDocs: oldSnapshot.docs.map((d) => d.id),
    newDocs: newSnapshot.docs.map((d) => d.id),
  };
}

/**
 * Updates userId field in a collection for all documents matching oldUserId.
 */
async function updateCollectionUserIds(firestore, collectionName, oldUserId, newUserId) {
  log.info(`updateCollectionUserIds: Processing collection "${collectionName}"`);
  log.info(`updateCollectionUserIds: Looking for userId="${oldUserId}" to replace with "${newUserId}"`);

  const coll = firestore.collection(collectionName);
  const snapshot = await coll.where("userId", "==", oldUserId).get();

  log.info(`updateCollectionUserIds: "${collectionName}" - found ${snapshot.size} docs with userId="${oldUserId}"`);

  if (snapshot.empty) {
    log.warn(`updateCollectionUserIds: "${collectionName}" - NO DOCUMENTS FOUND with userId="${oldUserId}"`);
    return 0;
  }

  const batch = firestore.batch();
  let updateCount = 0;

  for (const docSnap of snapshot.docs) {
    const ref = docSnap.ref;
    const currentData = docSnap.data();
    log.info(`updateCollectionUserIds: "${collectionName}" - UPDATING doc ID="${ref.id}"`);
    log.debug(`updateCollectionUserIds: "${collectionName}" - doc "${ref.id}" current userId="${currentData.userId}"`);

    batch.update(ref, {userId: newUserId});
    updateCount++;
  }

  log.info(`updateCollectionUserIds: "${collectionName}" - committing batch for ${updateCount} docs`);
  await batch.commit();
  log.info(`updateCollectionUserIds: "${collectionName}" - batch committed successfully`);

  return updateCount;
}

/**
 * Performs the migration:
 * 1. Find old user document and update its id field (if exists)
 * 2. ALWAYS update userId in daily_tasks, face-analysis, meal-analysis collections
 */
async function migrateUser(oldUserId, newUserId, db) {
  log.info("=".repeat(70));
  log.info("migrateUser: STARTING MIGRATION");
  log.info(`migrateUser: oldUserId="${oldUserId}"`);
  log.info(`migrateUser: newUserId="${newUserId}"`);
  log.info("=".repeat(70));

  const firestore = db || getFirestore();

  // Validate inputs
  if (!newUserId || newUserId.trim() === "") {
    log.error("migrateUser: FAILED - newUserId is required");
    return {ok: false, error: "newUserId is required"};
  }
  if (!oldUserId || oldUserId.trim() === "") {
    log.error("migrateUser: FAILED - oldUserId is required");
    return {ok: false, error: "oldUserId is required"};
  }

  const oldUserIdTrimmed = oldUserId.trim();
  const newUserIdTrimmed = newUserId.trim();

  if (oldUserIdTrimmed === newUserIdTrimmed) {
    log.error("migrateUser: FAILED - oldUserId and newUserId are the same");
    return {ok: false, error: "oldUserId and newUserId must be different"};
  }

  // ==================== DEBUG: Check current state of all collections ====================
  log.info("=".repeat(70));
  log.info("migrateUser: DEBUG - Checking current state of all collections BEFORE migration");
  log.info("=".repeat(70));

  for (const collName of COLLECTIONS_TO_UPDATE) {
    await debugListCollectionDocs(firestore, collName, oldUserIdTrimmed, newUserIdTrimmed);
  }

  // ==================== Step 1: Handle user document ====================
  log.info("=".repeat(70));
  log.info("migrateUser: Step 1 - Finding and updating user document...");
  log.info("=".repeat(70));

  const usersColl = firestore.collection("users");
  const found = await findUserDoc(usersColl, oldUserIdTrimmed);

  let userDocMigrated = false;
  let newDocId = null;

  if (found) {
    const {ref: oldUserRef, data: oldUserData} = found;
    log.info(`migrateUser: Found old user doc at path="${oldUserRef.path}"`);
    log.info(`migrateUser: Old user doc id field="${oldUserData?.id}"`);

    // Create new document with auto-generated ID, copying all data and updating id field
    const newUserData = {
      ...oldUserData,
      id: newUserIdTrimmed,
    };

    log.info("migrateUser: Creating new user document with auto-generated ID...");
    const newDocRef = await usersColl.add(newUserData);
    newDocId = newDocRef.id;
    log.info(`migrateUser: Created new user document with ID="${newDocId}"`);

    log.info(`migrateUser: Deleting old user document at path="${oldUserRef.path}"...`);
    await oldUserRef.delete();
    log.info("migrateUser: Old user document deleted");

    userDocMigrated = true;
  } else {
    log.warn("migrateUser: No user document found for oldUserId - skipping user doc migration");
    log.warn("migrateUser: Will still attempt to update other collections");
  }

  // ==================== Step 2: Update related collections ====================
  // IMPORTANT: We do this REGARDLESS of whether user doc was found
  log.info("=".repeat(70));
  log.info("migrateUser: Step 2 - Updating userId in related collections...");
  log.info(`migrateUser: Collections to update: ${COLLECTIONS_TO_UPDATE.join(", ")}`);
  log.info(`migrateUser: Searching for userId="${oldUserIdTrimmed}"`);
  log.info(`migrateUser: Replacing with userId="${newUserIdTrimmed}"`);
  log.info("=".repeat(70));

  const updateResults = {};
  for (const collName of COLLECTIONS_TO_UPDATE) {
    log.info(`migrateUser: Processing "${collName}"...`);
    const count = await updateCollectionUserIds(firestore, collName, oldUserIdTrimmed, newUserIdTrimmed);
    updateResults[collName] = count;
    log.info(`migrateUser: "${collName}" - updated ${count} documents`);
  }

  // ==================== DEBUG: Check state AFTER migration ====================
  log.info("=".repeat(70));
  log.info("migrateUser: DEBUG - Checking state of all collections AFTER migration");
  log.info("=".repeat(70));

  for (const collName of COLLECTIONS_TO_UPDATE) {
    await debugListCollectionDocs(firestore, collName, oldUserIdTrimmed, newUserIdTrimmed);
  }

  // ==================== Summary ====================
  log.info("=".repeat(70));
  log.info("migrateUser: MIGRATION COMPLETED");
  log.info(`migrateUser: User doc migrated: ${userDocMigrated}`);
  if (newDocId) {
    log.info(`migrateUser: New user doc ID: ${newDocId}`);
  }
  log.info(`migrateUser: Collection updates: ${JSON.stringify(updateResults)}`);
  log.info("=".repeat(70));

  return {ok: true, userDocMigrated, newDocId, updateResults};
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
  migrateUser,
  COLLECTIONS_TO_UPDATE,
};
