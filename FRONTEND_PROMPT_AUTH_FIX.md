# Frontend Task: Fix "Invalid/expired token" on daily claims & "incomplete account" for activated users

The backend has been fixed. Update the frontend to take advantage of it so old
users can claim daily earnings and activated users no longer see the
"incomplete account" prompt.

All requests send `Authorization: Bearer <token>`.

---

## 1. Silent token refresh (stops "Invalid or expired token")

### New endpoint
`POST /api/refresh-token`
- Headers: `Authorization: Bearer <currentToken>` (no body required).
- Returns a fresh 30-day token + the full user object, even if the supplied
  token expired up to 7 days ago:

```json
{
  "success": true,
  "token": "NEW_JWT",
  "user": { "id": 1, "username": "...", "role": "user", "balance": 0, "...": "..." }
}
```

If the token is missing/invalid/too old it returns:
- `401` `{ "error": "...", "code": "TOKEN_MISSING" }`
- `403` `{ "error": "Session expired. Please log in again.", "code": "TOKEN_INVALID" }`

### What to implement
1. Centralize your API calls (e.g. an axios/fetch wrapper) so every request:
   - Reads the token from storage and attaches the `Authorization` header.
   - On `403` with `code === "TOKEN_INVALID"` (or a `401`), calls
     `POST /api/refresh-token` **once**, stores the new token, and retries the
     original request.
   - If refresh fails, clears stored auth and redirects to `/login`. Prevent an
     infinite loop by not retrying the refresh itself.
2. On app load / dashboard mount, call `POST /api/user/sync` (or
   `/api/refresh-token`) to silently renew the session and refresh the user
   object. Do NOT force a logout just because the stored token is a few days old.
3. The daily "Claim" button should call the refresh wrapper first if needed, so
   users can claim without re-logging in.

**Pseudocode (axios):**
```js
api.interceptors.response.use(
  res => res,
  async err => {
    const original = err.config;
    if ([401,403].includes(err.response?.status) && !original._retried
        && err.response?.data?.code !== 'TOKEN_MISSING') {
      original._retried = true;
      const { data } = await api.post('/api/refresh-token');
      localStorage.setItem('token', data.token);
      setUser(data.user);
      original.headers.Authorization = `Bearer ${data.token}`;
      return api(original);
    }
    if (err.response?.data?.code === 'TOKEN_INVALID') {
      logout(); router.push('/login');
    }
    return Promise.reject(err);
  }
);
```

---

## 2. Use the full user object (stops false "incomplete account")

The login/register/sync/refresh responses now return a **complete, normalized**
`user` object. It always includes:

```jsonc
{
  "id": 1,
  "username": "user@example.com",
  "role": "user",
  "status": "active",
  "planActivated": "true",        // "true" | "false" (string)
  "activePackage": "Growth Plus",
  "activePackageId": "growth_plus",
  "my_referral_id": "AW1234ABCD",
  "referred_by": null,
  "full_name": "Jane Doe",        // "" when not set
  "phone": "080...",             // "" when not set
  "bank_name": "",
  "bank_account_number": "",
  "bank_account_holder": "",
  "balance": 0,
  "wallet_balance": 0,
  "taskEarnings": 0,
  "daily_earnings": 0,
  "affiliate_balance": 0,
  // Convenience flags (use these instead of re-deriving completeness):
  "profile_complete": true,      // full_name AND phone present
  "bank_complete": false,        // all 3 bank fields present
  "account_complete": true       // profile_complete && bank_complete
}
```

### What to implement
- Replace any incomplete/partial user shape in your auth store/context with the
  fields above. Treat missing strings as `""` and numbers as `0` (the backend
  already normalizes this, but keep fallbacks on the client).
- **Activated users must not see "complete your account".** A user is activated
  when `planActivated === "true"` (or when `activePackageId` is set). If the
  dashboard was gating on `full_name`/bank fields, that was the bug: an activated
  user could still be flagged "incomplete".
- Decide the gating clearly:
  - **Plan/earnings/dashboard access** → based on `planActivated === "true"`.
  - **"Complete your KYC/profile" nudge** → based on `!profile_complete` (and
    separately a "Add bank details" nudge based on `!bank_complete`). These are
    informational, NOT blockers for claiming earnings or viewing the dashboard.
- After login/register/refresh, store the whole `user` object; after profile or
  bank updates, re-fetch `POST /api/user/sync` to refresh it.

---

## 3. Daily claim updates

### Endpoint (updated)
`POST /api/claim-daily-task`
- The backend now determines the amount from the user's **active investment's**
  `daily_earning`, so you can omit `amount` (sending it is still accepted but the
  server's value wins for active plans).
- Returns:

```json
{
  "success": true,
  "message": "Successfully claimed ₦400!",
  "claimed_amount": 400,
  "newBalance": 1200,
  "balances": {
    "balance": 0, "wallet_balance": 0,
    "taskEarnings": 1200, "daily_earnings": 0, "affiliate_balance": 0
  }
}
```

- If already claimed today: `400` with
  `{ "error": "...", "already_claimed": true, "claimed_amount": 400 }`. Handle
  this gracefully (show "Already claimed today") rather than a generic error.

### What to implement
- Show the claimable amount from the active investment: fetch
  `GET /api/active-investment` and display `investment.daily_earning`; disable
  the button when `hasActive` is false.
- On claim success, update the wallet balances from `balances` and show the
  success message with `claimed_amount`.
- Run the claim button through the same refresh-aware API wrapper from step 1.

---

## Acceptance criteria
- [ ] A user whose token is 1–3 weeks old can open the app and claim daily
      earnings without being forced to log in (silent refresh works).
- [ ] Expired/invalid tokens trigger one refresh + retry; a truly dead session
      redirects to login (no infinite loop).
- [ ] The auth store holds the full user object; no fields are `undefined`.
- [ ] Activated users (`planActivated === "true"`) never see an "incomplete
      account" blocker on the dashboard.
- [ ] Profile/bank "complete your details" nudges are shown separately using
      `profile_complete`/`bank_complete` and don't block claiming.
- [ ] Daily claim shows the correct amount, handles "already claimed" cleanly,
      and updates balances from the response.
- [ ] Mobile and desktop both work; loading/error states handled.

## Suggested prompt to give the frontend AI/developer

> "Fix two user-reported bugs in the Access Wealth frontend. (1) Users get
> 'Invalid or expired token' when claiming daily earnings: add a central
> refresh-aware API client that calls POST /api/refresh-token on 401/403, stores
> the new token, retries once, and only redirects to login if refresh fails;
> silently sync on app load via POST /api/user/sync. Tokens now last 30 days.
> (2) Activated users see 'incomplete account': consume the full normalized
> user object returned by login/register/sync/refresh (includes profile_complete,
> bank_complete, account_complete flags). Gate dashboard/earnings on
> planActivated === 'true', and show profile/bank nudges as non-blocking.
> Also update the daily claim to POST /api/claim-daily-task (server determines
> the amount from the active investment; handle already_claimed), and show the
> claimable amount from GET /api/active-investment."
