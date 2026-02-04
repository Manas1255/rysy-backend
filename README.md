# Firebase Functions Project

This is a Firebase Cloud Functions project using JavaScript (Node.js 18+).

## Prerequisites

- Node.js 18 or higher
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project

## Setup

1. **Install dependencies:**
   ```bash
   cd functions
   npm install
   ```

2. **Configure Firebase project:**
   - Update `.firebaserc` with your Firebase project ID
   - Or run `firebase use --add` to select/add a project

3. **Configure RevenueCat webhook:**
   ```bash
   firebase functions:config:set revenuecat.auth="YOUR_SECRET"
   firebase functions:config:set revenuecat.monthly_product_ids="monthly_1,monthly_2"
   firebase functions:config:set revenuecat.yearly_product_ids="yearly_1,yearly_2"
   ```
   
   Or set environment variables:
   - `REVENUECAT_WEBHOOK_AUTH`
   - `REVENUECAT_MONTHLY_PRODUCT_IDS`
   - `REVENUECAT_YEARLY_PRODUCT_IDS`

4. **Login to Firebase (if not already):**
   ```bash
   firebase login
   ```

## Development

- **Run locally with emulator:**
  ```bash
  cd functions
  npm run serve
  ```

- **Lint code:**
  ```bash
  cd functions
  npm run lint
   ```

## Deployment

Deploy all functions:
```bash
firebase deploy --only functions
```

Deploy a specific function:
```bash
firebase deploy --only functions:revenueCatWebhook
```

## Project Structure

```
.
├── functions/
│   ├── index.js          # Main functions file
│   ├── package.json
│   └── .eslintrc.js
├── firebase.json         # Firebase configuration
└── .firebaserc          # Firebase project aliases
```

## Functions

### `revenueCatWebhook`

A webhook handler for RevenueCat subscription events that:
- Validates incoming webhook requests with Authorization header
- Handles idempotency to prevent duplicate processing
- Updates user subscription status in Firestore
- Supports monthly and yearly plans
- Implements 3-day trial for yearly subscriptions
- Handles cancellation and expiration events

### `notifyStreakBroken`

A Firestore-triggered function that runs when a user document in `users/{userId}` is updated:
- Detects when `currentStreak` goes from &gt;0 to 0
- Skips users on trial (`subscription.isOnTrial === true`)
- Skips if `notificationsEnabled === false`
- Sends an FCM multicast to the user’s `fcmTokens`
- Removes invalid/expired FCM tokens from the user document

### `updateUserStreaksDaily`

A scheduled function (2:00 AM daily, Asia/Karachi):
- Runs over `daily_tasks` docs for **yesterday** (by `taskDate` in that timezone)
- Uses `ymdInTZ` / `yesterdayYMD` for timezone-safe YYYY-MM-DD
- Considers a day “done” if any of `activity`, `education`, `hydration`, `nutrition`, `recovery` is true
- Updates each user’s `currentStreak` and `bestStreak` in `users/{userId}`
- Sets `lastStreakProcessedDate` on the `daily_tasks` doc for idempotency
- Batches writes (commits every 400 ops) to stay under Firestore limits

## Resources

- [Firebase Functions Documentation](https://firebase.google.com/docs/functions)
- [RevenueCat Webhooks](https://www.revenuecat.com/docs/webhooks)
# rysy-backend
