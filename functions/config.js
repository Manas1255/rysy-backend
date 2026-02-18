/**
 * Reads RevenueCat-related config from environment variables (Cloud Functions v2).
 */

/**
 * Gets RevenueCat webhook config from env vars.
 * @returns {{ auth: string, monthlyProductIds: string[], yearlyProductIds: string[] }}
 */
function getRevenueCatConfig() {
  const auth = process.env.REVENUECAT_WEBHOOK_AUTH ?? "";
  const monthlyRaw = process.env.REVENUECAT_MONTHLY_PRODUCT_IDS ?? "";
  const yearlyRaw = process.env.REVENUECAT_YEARLY_PRODUCT_IDS ?? "";

  const monthlyProductIds = monthlyRaw ? String(monthlyRaw).split(",").map((s) => s.trim()) : [];
  const yearlyProductIds = yearlyRaw ? String(yearlyRaw).split(",").map((s) => s.trim()) : [];

  return {auth, monthlyProductIds, yearlyProductIds};
}

module.exports = {getRevenueCatConfig};
