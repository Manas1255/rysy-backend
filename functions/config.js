/**
 * Reads RevenueCat-related config from Firebase config or environment variables.
 */

/**
 * Gets RevenueCat webhook config from Firebase config or env vars.
 * @returns {{ auth: string, monthlyProductIds: string[], yearlyProductIds: string[] }}
 */
function getRevenueCatConfig() {
  const {config} = require("firebase-functions");
  const rc = typeof config === "function" ? config().revenuecat : {};

  const auth = rc?.auth ?? process.env.REVENUECAT_WEBHOOK_AUTH ?? "";
  const monthlyRaw = rc?.monthly_product_ids ?? process.env.REVENUECAT_MONTHLY_PRODUCT_IDS ?? "";
  const yearlyRaw = rc?.yearly_product_ids ?? process.env.REVENUECAT_YEARLY_PRODUCT_IDS ?? "";

  const monthlyProductIds = monthlyRaw ? String(monthlyRaw).split(",").map((s) => s.trim()) : [];
  const yearlyProductIds = yearlyRaw ? String(yearlyRaw).split(",").map((s) => s.trim()) : [];

  return {auth, monthlyProductIds, yearlyProductIds};
}

module.exports = {getRevenueCatConfig};
