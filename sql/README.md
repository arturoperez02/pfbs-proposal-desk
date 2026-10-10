# Database scripts (run in Supabase → SQL Editor, in order)

| File | When |
|---|---|
| 001_schema.sql | Already run at setup. Tables, security rules, review and commission guards. |
| 002_line_items.sql | Run once for multiple services, add-ons, client details and PDF proposals. |
| 003_commission_dates.sql | Run once: separate payout dates for BD and estimator commission. |

Client data is never stored in this repository.
