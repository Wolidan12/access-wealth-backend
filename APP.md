# Access Wealth HQ — Web Application

Access Wealth is now a full application: the Express + SQLite backend **serves
the frontend itself** from [`public/`](public/), so the entire product deploys
as one unit with zero CORS configuration.

## What was built

### Member app (`public/`)
| Screen | What it does |
| --- | --- |
| Landing | Public marketing page with the **live** package catalogue |
| Register / Login | JWT auth, referral code support (`#/register?ref=CODE`) |
| Dashboard | Wallet, task & affiliate balances, active package widget with cycle progress, daily claim with 24h countdown, quick actions, announcements, profile/bank nudges |
| Packages | Live catalogue grouped by tier; activate a package, or upgrade to a higher one paying only the difference (insufficient-balance states handled) |
| Fund wallet | Manual bank transfer details (from `GET /api/payment/manual-info`), **multipart receipt upload** (`POST /api/request-deposit/upload`, field `receipt`), deposit history with honest pending/approved/declined states |
| Withdraw | Wallet selector (wallet/task/affiliate), ₦3,000 minimum, bank details pre-filled from profile, pending-request guard, history |
| Referrals | Personal code + shareable link, referral list, leaderboard (usernames masked) |
| Support | Real-time-ish chat with support (welcome message, 12s polling), plus admin replies |
| Profile | Personal details, bank details, password change, account info, logout |
| Announcements | Broadcast feed from admins |

### Admin panel (`#/admin`, role-gated)
Overview stats · user management (change plan with no-balance-charge warning,
balance adjustments, suspend/reactivate) · deposit review with **receipt
viewer**, approve/decline · withdrawal review (approve → processing, decline
refunds instantly) · site settings switches (maintenance, registrations,
deposits, withdrawals, sponsored posts) · broadcasts · support inbox with
multi-conversation handling. The `support` role gets the inbox only.

### Engineering
- No build step: hand-written ES modules, one stylesheet with semantic design
  tokens (`--color-brand-primary`, `--color-success`, …) per
  `FRONTEND_PROMPT_BRANDING.md`.
- Central API client (`public/js/api.js`): `Authorization: Bearer` on every
  call, single-flight token refresh on `401/403 TOKEN_INVALID`, one retry,
  then clean logout to `#/login`.
- All money formatted with `Intl.NumberFormat('en-NG', { currency: 'NGN' })`.
- Every user-provided string is escaped before rendering.
- PWA-ready: `manifest.webmanifest` + icons + network-only service worker, so
  the app can be installed to a phone home screen.
- Mobile-first: bottom tab bar on phones, sidebar on desktop.

## Running locally

```bash
npm install --ignore-scripts   # sqlite3 falls back to node:sqlite (see sqlite-compat.js)
cp .env.example .env           # then set JWT_SECRET + bootstrap passwords
npm start                      # serves the app + API on http://localhost:3000
```

Local dev credentials (from this workspace's `.env`, change for production):

- **Admin:** `admin@accesswealth.com` / `Admin@2026!`
- **Support:** `support@accesswealth.com` / `Support@2026!`

## Deployment

No change needed for hosts like Railway: `npm start` serves both the app and
API. `FRONTEND_URL` only matters if you later host the frontend on a separate
origin; same-origin serving makes it optional.

## Brand & copy rules applied

Formal name **Access Wealth HQ**, short name **Access Wealth**, domain only in
URLs. No profit-guarantee language, honest pending/approved/declined states,
internal identifiers (JWT claims, package IDs) never shown to users.
