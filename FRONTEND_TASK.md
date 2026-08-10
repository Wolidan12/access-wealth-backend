# Frontend Task: Admin Change User Package + User Self-Upgrade

Build the UI for two new flows against the Access Wealth backend. All
endpoints are JSON unless stated otherwise. Auth header required on every call:

```
Authorization: Bearer <token>
```

Base URL: use the existing `API_BASE` your app already uses.

---

## 1. Admin — Change a user's active package

**Endpoint:** `POST /api/admin/change-user-plan`
**Auth:** admin only.

### Request body
```json
{ "username": "jane@example.com", "packageId": "growth_pro" }
```
- `username` — exact username/email of the target user.
- `packageId` — one of the fixed package ids (see package list below).

### Response (200)
```json
{
  "success": true,
  "message": "jane@example.com is now on the Growth Pro plan. Wallet balances were not changed."
}
```

### Errors
- `400` — missing/invalid username or package.
- `404` — user not found.
- `403` — non-admin.
- `500` — database error.

> **Important:** this endpoint replaces the user's active package WITHOUT
> touching their wallet balance (it does not charge or refund). It is an admin
> override/correction tool. Show a confirmation dialog that says exactly that,
> and log/refresh the user list on success.

### Where to add it
- In the **Admin dashboard → Users management** table, add a "Change Plan"
  action button per user row.
- Clicking opens a modal:
  - Shows the user's current plan (from `users[].activePackage` /
    `activePackageId`).
  - A dropdown/select of all packages from `GET /api/packages`.
  - A warning: "This changes the user's active package immediately. No wallet
    balance is charged or refunded."
  - Confirm / Cancel buttons.
- On confirm, call the endpoint, then re-fetch `GET /api/admin/users` and show a
  toast with the returned message.

---

## 2. User — Upgrade their active package to a higher one

A user can only move to a package with **larger capital**. They pay only the
difference: `upgradeCost = newPackage.capital - currentPackage.capital`,
deducted from their wallet. The old cycle is closed and a new one starts.

### 2a. Get the user's current active package + balance

**Endpoint:** `GET /api/active-investment`

### Response (200)
```json
{
  "success": true,
  "hasActive": true,
  "balance": 18500,
  "investment": {
    "id": 12,
    "package_id": "starter_gold",
    "package_name": "Starter Gold",
    "capital": 4500,
    "daily_rate": 0.01,
    "cycle_days": 10,
    "daily_earning": 45,
    "total_payout": 4950,
    "referral_bonus": 2250,
    "days_credited": 3,
    "status": "active",
    "activated_at": "2026-08-01 10:00:00",
    "completed_at": null
  }
}
```
If `hasActive` is `false`, `investment` is `null` — the user must activate a
package first (existing activation flow) instead of upgrading.

### 2b. List all packages (to show upgrade options)

**Endpoint:** `GET /api/packages`
Returns `{ success: true, packages: [ { id, name, tier, capital, daily_rate,
cycle_days, daily_earning, total_payout, referral_bonus }, ... ] }` ordered by
capital ascending.

### 2c. Perform the upgrade

**Endpoint:** `POST /api/upgrade-package`

### Request body
```json
{ "package_id": "growth_plus" }
```
(also accepts `packageId` or `name`)

### Response (200)
```json
{
  "success": true,
  "message": "Successfully upgraded to Growth Plus. ₦5,500 was deducted from your wallet.",
  "upgrade_cost": 5500,
  "newBalance": 13000,
  "previous_package": { "id": "starter_gold", "name": "Starter Gold", "capital": 4500 },
  "package": { "id": "growth_plus", "name": "Growth Plus", "capital": 10000, "daily_earning": 120, "cycle_days": 15, "total_payout": 11800, "referral_bonus": 5000 }
}
```

### Validation rules the UI must enforce (the server also enforces them)
- Target package must have **capital greater than the current package**.
  Disable or hide lower/equal packages; label them "Not eligible (lower tier)".
- User's wallet `balance` must be `>= upgradeCost`. If not, disable the confirm
  button and show: "Insufficient balance. You need ₦X more. Please fund your
  wallet." with a link/button to the deposit page.
- If there is no active investment, show an "Activate a package" CTA instead of
  the upgrade UI.

### Where to add it
- On the **user dashboard / Plans page**:
  - When a user has an active package, show an "Upgrade Plan" button.
  - The upgrade modal lists every package from `GET /api/packages` whose
    `capital > investment.capital`, sorted ascending.
  - Each option shows: name, tier, daily earning, cycle days, total payout, and
    the **upgrade cost** = `capital - investment.capital`.
  - Show the current wallet balance and a highlighted "You pay" amount.
  - Confirm button is disabled when the user can't afford the selected option.
  - On success: update the local wallet balance (`newBalance`), refresh
    `GET /api/active-investment`, show the success toast, and navigate back to
    the dashboard.

---

## Fixed packages reference (for display/labels)

| id | name | tier | capital | daily_earning | cycle_days |
|---|---|---|---|---|---|
| starter_basic | Starter Basic | Starter | 500 | 5 | 10 |
| starter_bronze | Starter Bronze | Starter | 1500 | 15 | 10 |
| starter_silver | Starter Silver | Starter | 3000 | 30 | 10 |
| starter_gold | Starter Gold | Starter | 4500 | 45 | 10 |
| growth_plus | Growth Plus | Growth | 10000 | 120 | 15 |
| growth_pro | Growth Pro | Growth | 25000 | 300 | 15 |
| growth_max | Growth Max | Growth | 50000 | 600 | 15 |
| wealth_standard | Wealth Standard | Wealth | 100000 | 1400 | 21 |
| wealth_premium | Wealth Premium | Wealth | 250000 | 3500 | 21 |
| elite_vanguard | Elite Vanguard | Elite | 500000 | 7500 | 30 |
| elite_apex | Elite Apex | Elite | 1000000 | 15000 | 30 |

Always prefer the live `GET /api/packages` data over hardcoding.

---

## Acceptance criteria

**Admin**
- [ ] Admin can open "Change Plan" from the users table.
- [ ] Current plan is shown; all packages are selectable.
- [ ] Confirmation warns that no balance is charged/refunded.
- [ ] On success the users list refreshes and a toast shows the message.
- [ ] Non-admins cannot reach the action (button hidden; 403 handled).

**User upgrade**
- [ ] Dashboard shows an "Upgrade Plan" button only when a package is active.
- [ ] Only higher-capital packages are offered; upgrade cost is shown per option.
- [ ] Insufficient balance disables the button with a clear message and a fund
      wallet link.
- [ ] Successful upgrade deducts the difference, updates balance, and starts the
      new package (refresh active investment).
- [ ] Loading and error states are handled for every request; server `error`
      messages are displayed to the user.
- [ ] Mobile-friendly layout (the deposit receipt upload should also use the new
      multipart `POST /api/request-deposit/upload` endpoint with a `FormData`
      file field named `receipt` — never base64 — to avoid mobile crashes).

## Notes
- Currency is Naira (₦). Format amounts with thousand separators.
- All three endpoints are already deployed; no backend work is required beyond
  what is described here.
