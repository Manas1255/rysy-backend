/**
 * Builds the subscription object for Firestore from a RevenueCat webhook event.
 * Matches the Flutter Subscription model: isActive, planType, subscribedAt,
 * expiresAt, isOnTrial, trialEndsAt, revenueCatUserId, lastCheckedAt.
 */

const TRIAL_DAYS_YEARLY = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolves plan type from RevenueCat product_id using configured product id lists.
 * @param {string} productId - RevenueCat product_id
 * @param {string[]} monthlyProductIds - Configured monthly product identifiers
 * @param {string[]} yearlyProductIds - Configured yearly product identifiers
 * @returns {'monthly'|'yearly'|null}
 */
function getPlanType(productId, monthlyProductIds, yearlyProductIds) {
  if (!productId) return null;
  const monthly = (monthlyProductIds || []).map((id) => id.trim()).filter(Boolean);
  const yearly = (yearlyProductIds || []).map((id) => id.trim()).filter(Boolean);
  if (monthly.includes(productId)) return "monthly";
  if (yearly.includes(productId)) return "yearly";
  return null;
}

/**
 * Builds Firestore subscription payload for active subscriptions.
 * For yearly plan INITIAL_PURCHASE without store trial, applies 3-day trial.
 * @param {object} event - RevenueCat webhook event object
 * @param {string} planType - 'monthly' or 'yearly'
 * @returns {object} Subscription object for Firestore (toJson shape)
 */
function buildActiveSubscription(event, planType) {
  const purchasedAtMs = event.purchased_at_ms ?? event.event_timestamp_ms;
  const expirationAtMs = event.expiration_at_ms;
  const periodType = event.period_type || "";
  const isStoreTrial = periodType === "TRIAL";

  const subscribedAt = purchasedAtMs ? new Date(purchasedAtMs).toISOString() : null;
  const expiresAt = expirationAtMs ? new Date(expirationAtMs).toISOString() : null;

  let isOnTrial = isStoreTrial;
  let trialEndsAt = null;

  if (isStoreTrial && expirationAtMs) {
    trialEndsAt = new Date(expirationAtMs).toISOString();
  } else if (planType === "yearly" && !isStoreTrial && purchasedAtMs) {
    isOnTrial = true;
    trialEndsAt = new Date(purchasedAtMs + TRIAL_DAYS_YEARLY * MS_PER_DAY).toISOString();
  }

  const lastCheckedAt = event.event_timestamp_ms ?
    new Date(event.event_timestamp_ms).toISOString() :
    null;

  const revenueCatUserId = event.app_user_id || event.original_app_user_id || null;

  return {
    isActive: true,
    planType: planType || null,
    subscribedAt,
    expiresAt,
    isOnTrial,
    trialEndsAt,
    revenueCatUserId,
    lastCheckedAt,
  };
}

/**
 * Returns subscription payload for Firestore from a RevenueCat event, or null for cancel/expire.
 * @param {object} event - RevenueCat webhook event (event object from body.event)
 * @param {object} config - { monthlyProductIds: string[], yearlyProductIds: string[] }
 * @returns {object|null} Subscription object or null
 */
function subscriptionFromEvent(event, config) {
  if (!event || !event.type) return null;

  const type = event.type;
  const productId =
    (type === "PRODUCT_CHANGE" && event.new_product_id) ?
      event.new_product_id :
      (event.product_id || "");
  const monthlyIds = config.monthlyProductIds || [];
  const yearlyIds = config.yearlyProductIds || [];
  const planType = getPlanType(productId, monthlyIds, yearlyIds);

  switch (type) {
  case "CANCELLATION":
  case "EXPIRATION":
    return null;

  case "INITIAL_PURCHASE":
  case "RENEWAL":
  case "UNCANCELLATION":
  case "SUBSCRIPTION_EXTENDED":
  case "REFUND_REVERSED":
  case "PRODUCT_CHANGE":
    if (!planType) return null;
    return buildActiveSubscription(event, planType);

  case "TEMPORARY_ENTITLEMENT_GRANT":
    if (planType) return buildActiveSubscription(event, planType);
    return null;

  case "TEST":
  case "BILLING_ISSUE":
  case "SUBSCRIPTION_PAUSED":
  case "NON_RENEWING_PURCHASE":
  case "TRANSFER":
  case "INVOICE_ISSUANCE":
  case "VIRTUAL_CURRENCY_TRANSACTION":
  case "EXPERIMENT_ENROLLMENT":
  default:
    return null;
  }
}

module.exports = {
  getPlanType,
  buildActiveSubscription,
  subscriptionFromEvent,
};
