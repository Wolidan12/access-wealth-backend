# Access Wealth HQ — API Contract (frozen)

**Audience:** backend contributors, frontend (installed PWA/TWA) contributors.
**Enforcement:** `tests/api.contract.test.js` fails CI on any violation.

The installed app caches API GET responses for offline use and renders them
field-by-field. This document freezes the response shape of every endpoint the
app consumes.

## Rules

1. **Additive only.** You may ADD new fields to any response. You may NOT
   rename, remove, or change the JSON type of an existing field
   (e.g. number → string, object → array, string → null).
2. **Nullable fields stay nullable.** A field documented `string?` arrives as
   `string` or `null`. Never collapse it to empty string or omit the key.
3. **Every error body is** `{ "success": false, "error": "<message>" }` —
   including 401/403/404/409/413/429/5xx and unknown `/api/*` routes.
   Bare HTML and empty bodies are contract violations. Extra keys (e.g.
   `code`, `already_claimed`) are allowed and documented below.
   Enforcement is structural: the `/api` error-envelope middleware injects
   `success: false` into any error response that lacks it, and the global
   error handler only emits this shape.
4. Success responses keep `"success": true`.
5. Changing any shape below requires a coordinated frontend release first.

## Pinned response shapes

Legend: `?` = nullable (`type | null`). Types are JSON/JS runtime types.

### Auth & session

`POST /api/login`, `POST /api/refresh-token` — `200`:
`{ success:boolean, token:string, accessToken:string, access_token:string,
   newToken:string, user:User }`
(the four token aliases are one value; keep all four)

`POST /api/register` — same as login, plus `message:string`.

`POST /api/user/sync` — `{ success:boolean, user:User }`

`GET /api/user/:username` — `{ success:boolean, user:User }`

`User` object (same everywhere):
```
id:number, username:string, role:string, status:string,
planActivated:string,            // 'true' | 'false'
activePackage:string,            // 'None' when unset
activePackageId:string?,
my_referral_id:string?, referred_by:string?,
full_name:string, phone:string,
bank_name:string, bank_account_number:string, bank_account_holder:string,
balance:number, wallet_balance:number, taskEarnings:number,
daily_earnings:number, affiliate_balance:number,
profile_complete:boolean, bank_complete:boolean, account_complete:boolean
```

### Packages & investment

`GET /api/packages` → `{ success:boolean, packages:Package[] }`
`Package`: `id:string, name:string, tier:string, capital:number,
daily_rate:number, cycle_days:number, daily_earning:number,
total_payout:number, referral_bonus:number`

`POST /api/activate` → `{ success:boolean, message:string, newBalance:number, package:Package }`

`GET /api/active-investment` → `{ success:boolean, hasActive:boolean, balance:number, investment:Investment|null }`
`Investment`: `id:number?, package_id:string?, package_name:string?,
capital:number?, daily_rate:number?, cycle_days:number?, daily_earning:number?,
total_payout:number?, referral_bonus:number?, days_credited:number?,
status:string, activated_at:string?, completed_at:string?`

`POST /api/upgrade-package` → `{ success:boolean, message:string,
upgrade_cost:number, newBalance:number,
previous_package:{id:string,name:string,capital:number}, package:Package }`

### Daily task claim (`/api/claim-daily-task`)

Success `200`: `{ success:true, message:string, claimed_amount:number,
dailyEarning:number, newBalance:number, next_claim_at:string,
balances:{ balance:number, wallet_balance:number, taskEarnings:number,
daily_earnings:number, affiliate_balance:number } }`

Already claimed `400`: `{ success:false, error:string, already_claimed:true,
claimed_amount:number, next_claim_at:string }`

Plan required `403`: `{ success:false, error:string, code:'PLAN_REQUIRED' }`

### Deposits

`POST /api/request-deposit/upload` (multipart; file field `receipt`) and
`POST /api/request-deposit` → `{ success:boolean, message:string }`
(duplicate-ref variant adds `already_submitted:true`)

`GET /api/my-deposits` → `{ success:boolean, deposits:Deposit[] }`
`Deposit`: `id:number, amount:number, sender_name:string,
payment_method:string, transaction_ref:string?, status:string,
admin_note:string?, created_at:string, reviewed_at:string?`

`GET /api/user/deposit/:id/receipt` → binary image/PDF (not JSON) — the only
non-JSON success response in the API.

### Withdrawals

`POST /api/request-withdrawal` → `{ success:boolean, message:string }`
`GET /api/user/pending-withdrawal` → `{ success:boolean, hasPending:boolean, status:string? }`
`GET /api/user/withdrawals` → `{ success:boolean, withdrawals:Withdrawal[] }`
`Withdrawal`: `id:number, amount:number, wallet_type:string, status:string,
admin_note:string?, created_at:string, reviewed_at:string?`

### Referrals

`GET /api/referral/stats/:username` → `{ success:boolean, totalReferrals:number,
earnings:number, referrals:Array<{ username:string, created_at:string, planActivated:string? }> }`

`GET /api/referral/leaderboard` (public) → `{ success:boolean,
leaderboard:Array<{ username:string, total_earned:number?, referral_count:number }> }`

### Support threads

`POST /api/chat/welcome`, `POST /api/chat/send` → `{ success:boolean, message:string }`
`GET /api/chat/history/:username` → `{ success:boolean, messages:Message[] }`
`Message`: `id:number, user_id:string, sender:string, message:string, created_at:string`
`GET /api/support/users` (admin) → `{ success:boolean, users:Array<{user_id:string}> }`
`GET /api/support/all-users` (admin/support) → `{ success:boolean, users:Array<{username:string, created_at:string}> }`

### Broadcasts

`POST /api/admin/broadcast` → `{ success:boolean, message:string }`
`GET /api/broadcasts`, `GET /api/broadcasts/all` → `{ success:boolean, broadcasts:Broadcast[] }`
`Broadcast`: `id:number, title:string, message:string, created_by:string?, created_at:string`

### Sponsored tasks

`POST /api/admin/sponsored-post` → `{ success:boolean, message:string }`
`GET /api/sponsored-posts` → `{ success:boolean, posts:SponsoredPost[] }`
`SponsoredPost`: `id:number, title:string, description:string,
reward_amount:number, required_plan:string, image_url:string?, link:string?,
status:string, created_by:string?, created_at:string`
`POST /api/submit-sponsored-task` → `{ success:boolean, message:string }`
`GET /api/sponsored-submission-status/:post_id` → `{ success:boolean, status:string }`
`GET /api/admin/sponsored-submissions` → `{ success:boolean, submissions:array }`
`POST /api/admin/approve-sponsored-submission` → `{ success:boolean, message:string }`

### Premium purchases (airtime / data / bulk SMS / ads)

`POST /api/bills/airtime`, `/api/bills/data`, `/api/sms/send`, `/api/ads/create`
→ `{ success:boolean, newBalance:number }`
Locked (no active plan) → `403 { success:false, error:string }`

### Profile & payment info

`GET /api/user/profile/:username` → `{ success:boolean,
profile:{ full_name:string?, phone:string?, bank_name:string?,
bank_account_number:string?, bank_account_holder:string? } }`
`POST /api/user/update-profile`, `/api/user/update-bank`,
`/api/user/change-password` → `{ success:boolean, message:string }`

`GET /api/payment/manual-info` (public) → `{ success:boolean, payment:{
bank_name:string, account_name:string, account_number:string, bank_code:string,
currency:string, instructions:string, enabled:boolean } }`

`GET /api/site-settings` → `{ success:boolean, settings:object<string,string> }`

### Admin

`GET /api/admin/stats` → `{ success:boolean, stats:{ totalUsers:number,
activePlans:number, revenue:number, pendingDeposits:number,
pendingWithdrawals:number } }`

`GET /api/admin/users` → `{ success:boolean, users:AdminUser[] }`
`AdminUser`: `id:number, username:string, balance:number?,
wallet_balance:number?, taskEarnings:number?, daily_earnings:number?,
affiliate_balance:number?, planActivated:string?, activePackage:string?,
activePackageId:string?, role:string, status:string, created_at:string`
(`status` is always a string — never null)

`GET /api/admin/deposits`, `/api/admin/all-deposits` → `{ success:boolean,
deposits:AdminDeposit[] }`
`AdminDeposit`: `Deposit` plus `username:string, user_id:number?,
has_receipt:boolean, reviewed_by:string?`

`GET /api/admin/withdrawals`, `/api/admin/all-withdrawals` → `{ success:boolean,
withdrawals:AdminWithdrawal[] }`
`AdminWithdrawal`: `Withdrawal` plus `username:string, bank_details:string? (JSON-encoded), reviewed_by:string?`

`POST /api/admin/approve-deposit`, `decline-deposit`, `approve-withdrawal`,
`decline-withdrawal`, `adjust-balance`, `change-user-plan`,
`toggle-user-status`, `settings` → `{ success:boolean, message:string }`
`POST /api/admin/manual-credit` → `{ success:boolean, message:string, updatedBalance:object }`
`POST /api/admin/clear-total-balance` → `{ success:boolean, message:string, totalCleared:number }`
`POST /api/admin/packages/reseed` → `{ success:boolean, message:string, total:number }`
`GET /api/admin/migrations/legacy-plans/status` → `{ success:boolean, status:string, migration:object|null }`

## Known gaps (do NOT silently add — needs a coordinated release)

These names appear in the installed app but **do not exist in this backend
yet**: spin-win endpoints and `/api/tasks`/`/api/daily-tasks` list endpoints.
Daily earnings today flow exclusively through `/api/claim-daily-task` +
`/api/active-investment`. If the app needs spin-win or task lists, add them as
NEW endpoints (additive) — never by renaming the claim/investment responses.

## Maintenance windows

The API itself never returns HTML. During host maintenance, infrastructure
(Railway/proxy) may serve its own status page — the app must treat non-JSON or
empty responses as "server unreachable", exactly like a network failure.
