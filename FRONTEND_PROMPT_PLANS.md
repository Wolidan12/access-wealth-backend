# Frontend Task: Updated Investment Plan Earnings (new higher ROI)

The backend's investment plan earning structure has been updated. The frontend
must reflect the new numbers everywhere packages are shown. **Do not hardcode
earnings** — always render from the live API so future rate changes don't
require another frontend deploy.

## Endpoint
`GET /api/packages` → `{ success: true, packages: [...] }`

Each package object:
```json
{
  "id": "starter_basic",
  "name": "Starter Basic",
  "tier": "Starter",
  "capital": 500,
  "daily_rate": 0.03,
  "cycle_days": 10,
  "daily_earning": 15,
  "total_payout": 650,
  "referral_bonus": 250
}
```

Auth header: `Authorization: Bearer <token>` (the endpoint also works public,
but send it when the user is logged in).

## New earning structure (use for verification, not hardcoding)

| Tier | Daily ROI | Cycle | Total ROI |
|---|---|---|---|
| Starter | 3% | 10 days | 30% |
| Growth | 4% | 15 days | 60% |
| Wealth | 5% | 21 days | 105% |
| Elite | 6% | 30 days | 180% |

| id | name | capital | daily_earning | total_payout |
|---|---|---|---|---|
| starter_basic | Starter Basic | ₦500 | ₦15 | ₦650 |
| starter_bronze | Starter Bronze | ₦1,500 | ₦45 | ₦1,950 |
| starter_silver | Starter Silver | ₦3,000 | ₦90 | ₦3,900 |
| starter_gold | Starter Gold | ₦4,500 | ₦135 | ₦5,850 |
| growth_plus | Growth Plus | ₦10,000 | ₦400 | ₦16,000 |
| growth_pro | Growth Pro | ₦25,000 | ₦1,000 | ₦40,000 |
| growth_max | Growth Max | ₦50,000 | ₦2,000 | ₦80,000 |
| wealth_standard | Wealth Standard | ₦100,000 | ₦5,000 | ₦205,000 |
| wealth_premium | Wealth Premium | ₦250,000 | ₦12,500 | ₦512,500 |
| elite_vanguard | Elite Vanguard | ₦500,000 | ₦30,000 | ₦1,400,000 |
| elite_apex | Elite Apex | ₦1,000,000 | ₦60,000 | ₦2,800,000 |

Referral bonus remains 50% of package capital (`referral_bonus` field).

## What to change in the frontend

1. **Remove any hardcoded plan values.** Search the codebase for old numbers
   (e.g. `5`, `15`, `30`, `45`, `120`, `300`, `600`, `1400`, `3500`, `7500`,
   `15000` daily earnings; old rates `1%`, `1.2%`, `1.4%`, `1.5%`; old payouts
   `550`, `1650`, `3300`, `4950`, `11800`, `29500`, `59000`, `129400`,
   `323500`, `725000`, `1450000`) and replace them with values from
   `GET /api/packages`.
2. **Plans / Packages page** — fetch packages once on load, group/color by
   `tier` (Starter, Growth, Wealth, Elite), and render each card with:
   - Name + tier badge
   - Capital (₦)
   - Daily earning (₦) — from `daily_earning`
   - Daily ROI % — format `daily_rate * 100` (e.g. `3%`)
   - Cycle length — `cycle_days` days
   - Total payout (₦) — from `total_payout`
   - Total ROI % — compute `((total_payout - capital) / capital) * 100`, e.g. 30%
   - Referral bonus (₦) — from `referral_bonus`
   - Activate / Upgrade CTA wired to the existing activation and the new
     `POST /api/upgrade-package` flow (see below).
3. **Dashboard active-plan widget** — show the active plan's daily earning and
   projected total using `GET /api/active-investment`. If that returns the
   investment row, display its `daily_earning`, `days_credited`, cycle progress
   (`days_credited / cycle_days`), and `total_payout`. Active investments keep
   the rate they were activated with, so always use the row's values, not the
   current package catalog.
4. **Upgrade modal** (paired with the previous task) — list packages whose
   `capital > investment.capital`; upgrade cost = `capital - investment.capital`;
   new daily earning and new total payout come straight from the target package.
5. **Marketing/landing sections** that quote returns (hero stats, "how it
   works", FAQ, calculator) must pull from the API too. If a ROI calculator
   exists, compute: `daily = capital * daily_rate`, `total = capital + daily *
   cycle_days`.
6. **Formatting:** currency is Naira (₦) with thousand separators; percentages
   as whole numbers where possible (3%, 4%, 5%, 6%).

## Important behavior notes
- Existing users with an **active** investment keep their OLD daily rate and
  earnings (the backend snapshots them on `user_investments`). The dashboard
  must show the active row's values, not catalog values. New activations and
  upgrades use the new higher rates.
- After deploy, admins can also hit `POST /api/admin/packages/reseed` to force
  the catalog update if needed (normally automatic on server start).

## Acceptance criteria
- [ ] No hardcoded earning/ROI/payout numbers remain; all plan UI is driven by
      `GET /api/packages`.
- [ ] Plans page shows the new 3%/4%/5%/6% daily rates and the new daily/payout
      figures matching the table above.
- [ ] Dashboard shows the active investment's snapshotted earnings correctly for
      users who activated before the change.
- [ ] Activate, Upgrade, and ROI calculator all use the API values and stay
      consistent.
- [ ] Currency and percentage formatting is correct and mobile-friendly.

## Suggested prompt to give the frontend AI/developer

> "Update the investment plans UI to the new higher ROI structure. Remove all
> hardcoded plan numbers and render everything from `GET /api/packages` (fields:
> capital, daily_rate, cycle_days, daily_earning, total_payout,
> referral_bonus). New tiers: Starter 3%/10d, Growth 4%/15d, Wealth 5%/21d,
> Elite 6%/30d. On the dashboard, show active-investment earnings from
> `GET /api/active-investment` (existing active plans keep their old rate). Make
> the plans page, upgrade modal, calculator, and any marketing sections reflect
> the new values, with proper Naira/percentage formatting and mobile layout."
