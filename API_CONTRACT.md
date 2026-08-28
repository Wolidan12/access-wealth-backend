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

## Offline caching policy (service-worker contract)

The app's service worker keeps a last-known-good copy of successful GET JSON
responses, cleared on sign-out. The backend cooperates as follows:

1. **Offline-mirrored reads are never marked no-store/no-cache.**
   `GET /api/packages`, `/api/active-investment`, `/api/referral/*`,
   `/api/tasks*` (when added), `/api/broadcasts`, `/api/broadcasts/all`,
   `/api/payment/manual-info` carry no cache-restricting headers. Pinned by
   test: *"offline-cacheable GETs never carry no-store/no-cache"*.
2. **Sensitive payloads carry `Cache-Control: no-store`**: everything under
   `/api/admin/*` and `/api/support/*`, plus `/api/chat/*`, `/api/user/*`
   (profile, withdrawals, receipts), `/api/my-deposits`,
   `/api/sponsored-submission-status/*`. These paths are the app's never-cache
   list; the two lists must stay in sync.
3. **Tokens, balances and account identifiers never appear in query strings,**
   and existing identifier-bearing paths (`/api/user/:username`,
   `/api/referral/stats/:username`, `/api/chat/history/:username`,
   `/api/user/profile/:username`, receipt URLs) are frozen — cache keys are
   full URLs, so shape changes would orphan cached entries.
4. **Frozen auth paths (the app hard-bypasses them from caching):**
   `POST /api/login`, `/api/refresh-token`, `/api/register`, `/api/logout`,
   `/api/forgot-password`, `/api/reset-password`. All exist and always answer
   JSON. Reset delivery needs a mail/SMS channel that is not configured yet:
   until then both reset endpoints answer `501`
   `{ success:false, error, code:'PASSWORD_RESET_UNAVAILABLE' }`. When delivery
   is added, these paths MUST NOT move.


## Web Push (PWA/TWA notifications)

`GET /api/push/vapid-public-key` (public) → `{ success:boolean,
enabled:boolean, publicKey:string|null }`. When `enabled:false` the app hides
its notification toggle.

`POST /api/push/subscribe` (auth) — body `{ endpoint, keys:{p256dh,auth} }` or
`{ subscription:{...} }`; upserts by endpoint (browser key rotation is normal)
→ `{ success:true, message:string }`.

`DELETE /api/push/subscribe`, `DELETE /api/push/unsubscribe`,
`POST /api/push/unsubscribe` (auth) — body or `?endpoint=` →
`{ success:true, message:string, removed:number }`. All three paths frozen.

Push payloads are JSON `{ title:string, body:string, url:string, event:string }`,
url is an app route: `/dashboard.html` (money events), `/plans.html` (plan
events), `/announcements.html` (broadcasts). Events: `deposit_approved`,
`withdrawal_paid` (fires on admin "mark as paid", i.e.
`POST /api/admin/complete-withdrawal` — never at mere approval),
`plan_activated`, `plan_upgraded`, `broadcast`. Subscriptions that return
404/410 from the push service are pruned automatically.

**Nigeria quiet hours: 23:00–07:00 Africa/Lagos.** Money-critical events
(deposit approved, withdrawal paid, plan activation/upgrade) push immediately
at any hour. Broadcasts during quiet hours are queued and delivered at 07:00.
Pinned by `tests/push.contract.test.js`.

## Sessions: rotation, revocation, throttling

- Access tokens stay as they are (30d TTL) and rotate via
  `POST /api/refresh-token` (+ accept ≤7 days past expiry) — the app's
  auto-refresh keeps working unchanged.
- Every token carries an `ep` (epoch) claim. `POST /api/user/logout-all`
  (auth) → `{ success:true, message }` and password change / password reset
  bump the epoch, revoking the whole session family: installed apps fail
  refresh (401 TOKEN_INVALID) and route to login.
- Login/register/forgot/reset are limited by BOTH a username+IP limiter
  (30/15min, so office/estate NAT users don't lock each other out) and a
  per-account limiter (8/15min keyed by account only, so IP-rotating
  credential stuffing against one account dies). Successful attempts are not
  counted.

## Bank details masking

`GET` responses and `POST /api/user/sync` never contain a full account number:
it arrives masked as `****8934` (empty string when unset). The full value is
available only via `POST /api/user/reveal-bank` (auth, non-cacheable:
`Cache-Control: no-store`) → `{ success:true, bank:{ bank_name:string,
bank_account_number:string, bank_account_holder:string } }`.
`POST /api/user/update-bank` treats a blank or still-masked `account_number`
as "keep the saved number". `POST /api/request-withdrawal` falls back to the
saved bank details when `bank_details` is omitted or contains the mask.
Admin withdrawal rows keep the full details (admin APIs are never cached).

## Transactional email

Sender module: `mailer.js`. Enabled when `SMTP_*` are set, or
`MAIL_TRANSPORT=json` for render-only dev/tests; otherwise all sends are
skipped safely and forgot/reset-password answer the honest 501 stub
(`code: PASSWORD_RESET_UNAVAILABLE`). Events wired: welcome (register),
password reset code, email verification code, deposit approved, withdrawal
paid, plan activated, plan upgraded.

`POST /api/forgot-password` { username } → always 200
`{ success:true, message:"If that account exists, a reset code is on its way." }`
(anti-enumeration) — issues a 6-digit code (15 min, single use) by email when
the username is an email. `POST /api/reset-password` { username, code,
new_password } → 200 `{ success:true, message }`; resets the password and bumps
the session epoch. Without mail: both 501 JSON.
`POST /api/email/request-verification` (auth) and `POST /api/email/verify`
(auth, `{ code }`) → `{ success:true, message }`; sets `user.email_verified`.

**Every template ends with the app-install footer block:** deep-blue band
`#112A46`, gold button `#d4af37` with dark text `#0b1421`, linking to
`https://accesswealthhq.com/login.html`, copy: "Open on your phone and choose
Install app — works offline." When the Play listing is live, the single
`GET_APP_URL` constant in `mailer.js` swaps to
`https://play.google.com/store/apps/details?id=com.accesswealthhq.app`.

## Maintenance windows

The API itself never returns HTML. During host maintenance, infrastructure
(Railway/proxy) may serve its own status page — the app must treat non-JSON or
empty responses as "server unreachable", exactly like a network failure.

## Health probe (offline banner & auto-resync)

`GET /api/health` (and alias `/health`): **no auth, no rate limiting,
always fresh.** Success is `200` with a tiny JSON body containing
`status: "ok"` (extra diagnostic keys like `database` are additive).
Degraded states answer `503` with `{ success:false, status:'error', ... }`.

- The `status: "ok"` discriminator is frozen — the app drives its offline
  banner from it: `200` + JSON `status:"ok"` ⇒ server up; timeout/5xx/non-JSON
  ⇒ offline or down.
- The response is marked `Cache-Control: no-store`, and **the service worker
  must network-bypass `/api/health`** (add it to the never-cache list) —
  serving a cached 200 while offline would hide an outage.
- Per-call server work is a single `SELECT 1`; measured single-digit ms.
