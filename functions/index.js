const {initializeApp} = require("firebase-admin/app");
const {revenueCatWebhook} = require("./revenueCatWebhook");
const {updateUserStreaksDaily} = require("./updateUserStreaksDaily");
const {notifyStreakBroken} = require("./notifyStreakBroken");
const {notifyStreakAboutToBreak} = require("./notifyStreakAboutToBreak");
const {notifyPartialTasks} = require("./notifyPartialTasks");
const {notifyInactiveComeback} = require("./notifyInactiveComeback");
const {userSetupApi} = require("./userSetupApi");
const {deleteUserApi} = require("./deleteUserApi");

initializeApp();

exports.revenueCatWebhook = revenueCatWebhook;
exports.updateUserStreaksDaily = updateUserStreaksDaily;
exports.notifyStreakBroken = notifyStreakBroken;
exports.notifyStreakAboutToBreak = notifyStreakAboutToBreak;
exports.notifyPartialTasks = notifyPartialTasks;
exports.notifyInactiveComeback = notifyInactiveComeback;
exports.userSetupApi = userSetupApi;
exports.deleteUserApi = deleteUserApi;
