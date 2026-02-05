const {initializeApp} = require("firebase-admin/app");
const {revenueCatWebhook} = require("./revenueCatWebhook");
const {updateUserStreaksDaily} = require("./updateUserStreaksDaily");
const {notifyStreakBroken} = require("./notifyStreakBroken");
const {notifyInactiveToday} = require("./notifyInactiveToday");
const {userSetupApi} = require("./userSetupApi");
const {deleteUserApi} = require("./deleteUserApi");

initializeApp();

exports.revenueCatWebhook = revenueCatWebhook;
exports.updateUserStreaksDaily = updateUserStreaksDaily;
exports.notifyStreakBroken = notifyStreakBroken;
exports.notifyInactiveToday = notifyInactiveToday;
exports.userSetupApi = userSetupApi;
exports.deleteUserApi = deleteUserApi;
