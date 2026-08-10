# Frontend rebrand prompt — Access Wealth HQ

Copy the prompt below into the frontend repository’s coding agent or share it with the frontend developer. It is written to be implementation-ready without assuming a specific frontend framework.

---

## Prompt

You are rebranding the Access Wealth frontend as **Access Wealth HQ**. Work in the frontend repository only; do not rename backend API routes, database fields, JWT issuer/audience values, package IDs, or environment-variable names. The backend contract must continue to work unchanged.

### Product direction

Make the product feel calm, clear, trustworthy, and practical. It is a financial dashboard, so hierarchy and status clarity matter more than decorative effects. Use plain language and never imply guaranteed returns or show a pending financial action as completed.

Use this naming rule:

- First mention and formal product name: **Access Wealth HQ**.
- Short reference after the product is established: **Access Wealth**.
- Use `accesswealthhq.com` only as a URL.
- Do not display internal identifiers such as `AccessWealthHQ`, JWT claims, database column names, or package IDs.

### First inspect the existing app

Before editing, identify:

1. the current routing and authentication store/context;
2. the centralized API client, if one exists;
3. all shared layout, navigation, button, form, card, table, modal, toast, loading, and error components;
4. all places that set the document title, favicon, social metadata, or app name;
5. auth, dashboard, package, deposit, receipt-upload, withdrawal, daily-claim, referral, support, and admin screens;
6. scattered color, font, radius, shadow, and spacing values that should become tokens.

Prefer extending the existing component system over introducing a second styling system. Preserve existing behavior while making the visual language consistent.

### Create a small semantic design system

Centralize tokens in the project’s existing styling mechanism. Use names such as:

- `--color-brand-primary`
- `--color-brand-accent`
- `--color-surface`
- `--color-surface-muted`
- `--color-text`
- `--color-text-muted`
- `--color-border`
- `--color-success`, `--color-warning`, `--color-danger`, `--color-info`
- `--space-*`, `--radius-*`, `--shadow-*`, and focus-ring tokens

Choose the actual palette only after checking the current logo/assets and product-owner direction. If no approved palette exists, use a restrained, high-contrast financial-product palette with a deep primary, a distinct accent, quiet neutral surfaces, and accessible semantic colors. Document the chosen values in the frontend. Test normal text and controls against WCAG AA, and never communicate status with color alone.

Define reusable variants for:

- primary, secondary, ghost, danger, disabled, and loading buttons;
- text, number, currency, and password inputs with visible labels and errors;
- cards and stat tiles;
- badges for pending, approved, declined, active, completed, and unavailable;
- responsive tables that remain usable on narrow screens;
- dialogs, toasts, skeletons, empty states, and retry states.

Keep motion subtle and respect `prefers-reduced-motion`.

### Apply the identity consistently

Update, where supported by the app:

- login, registration, forgot-password, and session-expired screens;
- app shell, navigation, dashboard greeting, footer, and support copy;
- browser titles, favicon, manifest, Open Graph, and Twitter metadata;
- admin and support screens;
- loading, empty, offline, unauthorized, rate-limit, and server-error states;
- the logo wordmark and compact mark, including light/dark and small-size variants.

Use meaningful alt text for informative logos and empty alt text for decorative marks. Do not embed text in an image when accessible HTML text will work better.

### Preserve and improve the API flows

Keep all existing endpoint paths and request shapes. All authenticated calls must send `Authorization: Bearer <token>` through the centralized client.

- On app load or dashboard mount, silently call `POST /api/user/sync` or `POST /api/refresh-token` and store the complete returned user object.
- On `401` or `403` with `code === "TOKEN_INVALID"`, call `POST /api/refresh-token` once, save the new token, update the user, and retry the original request once. Never retry the refresh request itself. If refresh fails, clear auth and route to `/login`.
- Do not force a logout merely because a stored token is old.
- Gate dashboard/package/earnings access with `planActivated === "true"` or the active package ID, not profile completeness.
- Show profile and bank-detail nudges separately using `profile_complete` and `bank_complete`; these nudges must not block dashboard access or daily claims.
- For daily claims, load `GET /api/active-investment`, display `investment.daily_earning`, disable the claim action when `hasActive` is false, and call `POST /api/claim-daily-task`. On success, update balances from `balances` and show `claimed_amount`. Handle `already_claimed: true` as a friendly “Already claimed today” state.
- For manual deposits, prefer multipart upload to `/api/request-deposit/upload` with the file in the `receipt` field. Preserve the legacy JSON endpoint for existing clients. Show the server’s 5MB and file-type guidance directly and make retry behavior explicit.
- Keep pending/approved/declined states honest for deposits and withdrawals. Explain what the user should do next.

### Currency, content, and trust rules

- Format Nigerian naira consistently using the app’s existing locale strategy; do not hand-build inconsistent currency strings.
- Keep numeric values aligned and easy to scan; use tabular numerals in comparison tables when available.
- Use concise headings and action-oriented labels such as “Upload receipt”, “Awaiting review”, and “Try again”.
- Do not use “guaranteed”, “risk-free”, “instant wealth”, or similar outcome promises.
- Do not hide the reason for an error when the backend provides a safe, useful message.
- Do not expose passwords, tokens, receipt data, or other sensitive values in logs or UI.

### Accessibility and responsive acceptance criteria

- Keyboard users can reach every control and see a strong focus indicator.
- Every form control has a label, validation message, and sensible autocomplete/input mode.
- Status is conveyed by text/icon plus color, not color alone.
- Dialogs manage focus, close accessibly, and announce important updates.
- Screen readers receive success, error, session-expiry, and upload feedback.
- Layouts work at mobile widths for auth, dashboard cards, receipt uploads, withdrawals, claims, support chat, and admin tables.
- Touch targets are comfortable, and no important action depends on hover.
- Respect reduced motion and maintain readable contrast in every theme.

### Deliverables

1. Central semantic theme/design tokens and reusable component variants.
2. Updated branding across the app shell, auth, dashboard, user flows, support, and admin surfaces.
3. Consistent metadata, favicon, and logo handling.
4. Refresh-aware authenticated API behavior with no retry loop.
5. Responsive and accessible loading, empty, error, pending, and success states.
6. A short `BRANDING_IMPLEMENTATION.md` or equivalent note listing the chosen tokens, assets, naming rule, and any assumptions.
7. Tests or a manual QA checklist covering login, token refresh, profile sync, active package, daily claim, manual receipt upload, withdrawal, mobile layout, and keyboard navigation.

Before finishing, run the frontend’s lint, typecheck, and test/build commands. Report any missing asset or backend contract explicitly instead of silently inventing a breaking change.

---

## Suggested review checklist

- [ ] Access Wealth HQ is the formal display name and Access Wealth is used consistently as the short name.
- [ ] The visual system is tokenized and reused across auth, dashboard, user, support, and admin surfaces.
- [ ] Metadata and favicon are updated without exposing internal API identifiers.
- [ ] Token refresh retries one original request and cannot loop.
- [ ] Activated users are not blocked by incomplete profile or bank details.
- [ ] Deposit and withdrawal statuses remain truthful and understandable.
- [ ] Mobile upload, claim, and dashboard flows are usable with keyboard and screen reader support.
- [ ] Lint/typecheck/test/build results are recorded for review.
