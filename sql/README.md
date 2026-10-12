# Database scripts (run in Supabase → SQL Editor, in order)

| File | When |
|---|---|
| 001_schema.sql | Already run at setup. Tables, security rules, review and commission guards. |
| 002_line_items.sql | Run once for multiple services, add-ons, client details and PDF proposals. |
| 003_commission_dates.sql | Run once: separate payout dates for BD and estimator commission. |
| 004_job_actuals.sql | Run once: log actual hours and costs per visit. |
| 005_renewals_changes_revisions.sql | Run once: renewal reminders, change orders, revisions. |
| 006_audit_trail.sql | Run once: leads, price lock after sending, change log, review notes. |
| 007_leads_followups_reports.sql | Run once: lead details, prospects, follow-up cadence, monthly report, HousecallPro link. |
| 008_proposal_photos.sql | Run once: site photos on proposals (private storage bucket). |
| 009_parts_to_order.sql | Run once: Parts to order and lift/equipment rental tracking on approved jobs, buyer, monthly report section, follow-up email wording. Needs 007. |
| 010_recurring_contracts.sql | Run once: recurring contracts (term, contract value, recurring revenue per month, cancelled contracts), commission earned month by month for the first year, monthly report updated to match. Needs 007 and 009. |
| 011_commission_ledger_audit.sql | Run once: commission payout ledger (never edited, only voided), commission rates locked when a job is paid, change log for Settings and the team, archive of deleted proposals. Needs 010. |
| 012_estimator_commission_plan.sql | Run once: estimator rate 2% / 3% / 4% by job margin, 75% of that when a BD rep is on the job. Past paid jobs keep their locked rate. Needs 011. |
| 013_follow_up_status.sql | Run once: proposals marked Follow-up become Sent (follow-ups are tracked automatically). |
| 014_budget_estimates.sql | Run once: Budget status for next-year budget proposals (kept out of pipeline, win rate and follow-ups), budget year and check-in date. |
| 015_lost_to_and_backup.sql | Run once: competitor and their price on lost proposals; weekly backup through Zapier and a Download backup button. Needs 014. |
| 016_hcp_paid.sql | Run once: HousecallPro "paid" events mark the job Paid and fill in Date paid. Needs 014. |

Client data is never stored in this repository.
