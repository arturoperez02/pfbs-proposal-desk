# Database scripts (run in Supabase → SQL Editor, in order)

| File | When |
|---|---|
| 001_schema.sql | Already run at setup. Tables, security rules, review and commission guards. |
| 002_line_items.sql | Run once for multiple services, add-ons, client details and PDF proposals. |
| 003_commission_dates.sql | Run once: separate payout dates for BD and estimator commission. |
| 004_job_actuals.sql | Run once: log actual hours and costs per visit. |
| 005_renewals_changes_revisions.sql | Run once: renewal reminders, change orders, revisions. |
| 006_audit_trail.sql | Run once: leads, price lock after sending, change log, review notes. |

Client data is never stored in this repository.
