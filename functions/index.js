const {initializeApp} = require("firebase-admin/app");
const {revenueCatWebhook} = require("./revenueCatWebhook");
const {updateUserStreaksDaily} = require("./updateUserStreaksDaily");
const {notifyStreakBroken} = require("./notifyStreakBroken");
const {notifyInactiveToday} = require("./notifyInactiveToday");
const {userSetupApi} = require("./userSetupApi");

initializeApp();

exports.revenueCatWebhook = revenueCatWebhook;
exports.updateUserStreaksDaily = updateUserStreaksDaily;
exports.notifyStreakBroken = notifyStreakBroken;
exports.notifyInactiveToday = notifyInactiveToday;
exports.userSetupApi = userSetupApi;
