# Access Wealth HQ branding audit

**Scope:** backend repository and the frontend hand-off documents currently committed here  
**Date:** 2026-08-10  
**Audience:** product, design, and frontend contributors

## Executive summary

The product is already presented as **Access Wealth HQ** in the payment configuration and support copy, while shorter references use **Access Wealth**. The backend has a few hard-coded brand touchpoints, but it does not contain the frontend UI, logo assets, design tokens, or a single source of truth for the visual system. The most useful next step is to standardize the public name as **Access Wealth HQ**, keep implementation identifiers stable, and apply a small, documented design system in the frontend.

This audit is intentionally limited to what can be verified in this repository. Visual conclusions about the live website should be confirmed against the current production frontend before changing assets or copy.

## Brand touchpoints found in this repository

| Location | Current touchpoint | Audit note |
| --- | --- | --- |
| `.env.example` | `https://accesswealthhq.com` | Treat this as the canonical production domain. |
| `.env.example` | `Luna Entry Services - Access Wealth HQ` | This is the configured manual-payment account name, not necessarily customer-facing brand copy. |
| `server.js` | `AccessWealthHQ` JWT issuer and `AccessWealthUsers` audience | These are security identifiers. Do not rename them during a visual rebrand without a token migration plan. |
| `server.js` | `Access Wealth support agent` welcome message | Uses the shorter name and should be aligned with the approved support voice. |
| `server.js` | `accesswealthhq.com/dashboard` callback URL | Keep payment callbacks on the canonical domain. |
| frontend hand-off docs | `Access Wealth` / `Access Wealth HQ` | Establish one display-name rule for headings, metadata, emails, and support messages. |

## Findings

### 1. Naming is close, but not yet governed

- **Recommended display name:** Access Wealth HQ.
- **Recommended short reference:** Access Wealth, only when space is limited or the context already establishes the full name.
- **Keep unchanged:** API paths, JWT issuer/audience values, database fields, package IDs, and environment-variable names. These are integration contracts rather than brand copy.
- **Avoid:** switching among `Access Wealth`, `Access Wealth HQ`, `AccessWealth`, and the domain as if they were interchangeable product names.

Suggested copy rule:

> First mention: **Access Wealth HQ**. Subsequent mentions: **Access Wealth**. Use `accesswealthhq.com` only for URLs and technical configuration.

### 2. The frontend needs a single visual source of truth

No frontend source or asset library is present in this backend checkout. Before implementation, the frontend should centralize:

- brand colors and semantic states (success, warning, danger, informational);
- typography, spacing, radius, elevation, and focus-ring tokens;
- logo wordmark, icon, favicon, and light/dark variants;
- page titles, Open Graph metadata, and favicon metadata;
- button, form, card, table, modal, toast, and loading-state patterns.

A token-based system is preferable to replacing isolated hex values or one-off component styles. This will make future changes safe and keep the dashboard, auth pages, and admin screens visually consistent.

### 3. Product tone should be confident without promising outcomes

The interface should feel clear, trustworthy, and practical. Use plain language for balances, deposits, withdrawals, packages, claims, and account status. Avoid language that guarantees profit, implies risk-free returns, pressures a user to deposit, or presents an approval/pending state as completed.

Use status-specific language:

- **Pending:** “Awaiting review” or “Processing”; explain what happens next.
- **Approved/successful:** state exactly what was credited or completed.
- **Declined/failed:** explain the next action without blame.
- **Unavailable:** say whether the feature is disabled, unconfigured, or temporarily unavailable.

### 4. Trust details are part of the brand experience

The backend supports security and operational states that the frontend should expose consistently:

- authenticated requests and expired-session recovery;
- clear distinction between wallet balances and task/affiliate earnings;
- manual deposit receipt review;
- withdrawal review states;
- mobile-friendly upload errors and file-size guidance;
- maintenance and feature-toggle states;
- support chat and admin review activity.

A polished visual treatment cannot compensate for ambiguous financial status. Every branded screen should preserve the API’s actual state and avoid hiding errors behind generic “something went wrong” messages.

## Recommended brand foundation

These are implementation recommendations, not claims about an existing approved identity. Confirm them with the product owner before treating them as final brand standards.

- **Positioning:** a clear, dependable home for wealth-building tools and account activity.
- **Personality:** calm, capable, transparent, encouraging, and respectful of the user’s decisions.
- **Visual direction:** a restrained financial-product system with strong contrast, generous whitespace, clear hierarchy, and purposeful accent color for actions and status.
- **Color approach:** define a primary brand color, a supporting accent, neutral surfaces, and accessible semantic colors. Check every text/background pair against WCAG AA; never use color alone to communicate status.
- **Typography approach:** use one highly legible UI family with a clear numeric style for currency and balances. Use tabular numerals where totals are compared in a table.
- **Imagery approach:** prefer simple, authentic product imagery or restrained illustrations. Avoid stock imagery that suggests guaranteed luxury, instant wealth, or unrealistic financial outcomes.

## Frontend audit checklist

Use this checklist against the frontend before and after the rebrand:

- [ ] The full product name and short-name rule are applied consistently.
- [ ] Browser title, favicon, social metadata, login, dashboard, admin, and support surfaces use approved naming.
- [ ] Logo assets have light, dark, compact, and small-size variants with sensible alt text.
- [ ] Design tokens are centralized and semantic rather than scattered component overrides.
- [ ] Primary, secondary, destructive, disabled, hover, focus, loading, and success states are defined.
- [ ] Currency values, dates, and status labels have consistent formatting.
- [ ] Mobile layouts work for auth, deposits, receipt uploads, withdrawals, claims, and tables.
- [ ] Empty, loading, offline, rate-limit, unauthorized, and server-error states are branded but honest.
- [ ] The interface never presents pending money movement as completed.
- [ ] Contrast, keyboard focus, reduced motion, labels, and screen-reader announcements are tested.
- [ ] No API/security identifier was renamed as part of a visual-only change.

## Definition of done for the rebrand

The rebrand is ready for review when the frontend has one token source, one approved naming rule, responsive and accessible versions of the major flows, and a screenshot or browser review covering auth, dashboard, deposit, withdrawal, daily claim, support, and admin states. The backend should continue to expose the same API contracts unless a separate migration is planned and tested.
