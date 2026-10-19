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
| 017_service_reports.sql | Run once: service reports move into the CRM (reports.html). Reports, photos and PDFs stored privately in Supabase; HousecallPro "Job finished" starts a report; approving one marks the job's report sent. The old report app keeps working until you switch the Zap. Needs 016. |
| 018_invoicing.sql | Run once: invoices built from the job (numbered, PDF, emailed), billing (AP) email and PO# on jobs, checks/ACH payments including partial payments, paid in full marks the job Paid. Invoices and payments are voided, never deleted. Needs 017. |
| 019_clients.sql | Run once: clients with contacts and properties, billing/AP email/PO# per client, HousecallPro customer import (Settings → Clients), proposals linked to clients and properties. Needs 018. |
| 020_schedule.sql | Run once: the Schedule (visits with dates, times, techs, work, equipment, notes; recurring jobs with repeat rules), replacing HousecallPro's schedule and TechSched data entry. Crew list in Settings. Needs 019. |
| 021_money.sql | Run once: Accountant role (Money and Clients only), open HousecallPro invoice import (Settings → Invoicing, on switch-over day). Needs 020. |
| 022_jobs_contacts.sql | Run once: a job # on every visit (HCP's # until switch-over, then the CRM's own, set in Settings → Job numbers), weekday-only visits, invoices mark visits Done, a contact per property. Needs 021. |
| 023_job_no_on_approval.sql | Run once: once the CRM numbers jobs, approving a proposal gives the job its job #; its first visit uses it, later recurring visits get their own. Needs 022. |
| 024_on_hold.sql | Run once: put a job on hold (with a reason) and take it off hold; held jobs get their own column on the Home board; "Give it a job #" for approved jobs that have none. Needs 023. |
| 025_warehouse_feed.sql | Run once: KitTracker's "Import from CRM Schedule" reads upcoming scheduled jobs (job #, site, techs, work, equipment, vehicle, scope). Only logins added in Settings → Warehouse can read it, and they see nothing else. Needs 024. |
| 026_warehouse.sql | Run once: the warehouse (KitTracker) moves into the CRM: its tables (wh_ prefix) in this database, used by the Warehouse tab (warehouse.html) with the CRM sign-in. Managers, estimators and the warehouse tablet logins (Settings → Warehouse) can use it; the tablet still sees no proposals, clients or money. Copy the old data in from Settings → Warehouse. Needs 025. |
| 027_techsched_import.sql | Run once: Schedule → Import from TechSched copies TechSched's upcoming jobs into the CRM schedule (linked to their CRM job when the job # or address matches). Run the import again any time to pick up new or changed jobs; TechSched is not changed. Needs 026. |
| 028_hcp_paid_invoices.sql | Run once: the HousecallPro invoice import also brings the paid invoices in as history (amounts from the HCP Jobs export). They are not linked to CRM jobs, so they never change a job's status, date paid or commission, or count as owed. Needs 027. |
| 029_invoice_reminders.sql | Run once: payment reminders. The Money tab (and Home) list the reminders due (before / on / after the due date, set in Settings → Invoicing) and remember which were sent. Needs 028. |
| 030_hcp_invoice_details.sql | Run once: imported HousecallPro invoices show what the job was and where (from HCP's Jobs export); Settings → Invoicing → "Fill in details of imported HCP invoices" fixes ones already imported. Needs 029. |
| 031_proposal_numbers.sql | Run once: new proposals start at PFBS-0803 and go up from there (never reusing a number). Settings → Proposal numbers shows and changes the next one. Needs 030. |
| 032_warehouse_materials.sql | Run once: the warehouse gets each job's materials from the pricing, so "Import from CRM Schedule" puts them in the kit and they print on the kit slip (page 2 of the job packet); also sends the visit's end time and the job's lifts (no costs) so the Warehouse can print the whole job packet. Needs 031. |
| 033_hcp_invoice_link.sql | Run once: open invoices imported from HousecallPro find their CRM job by job # (now and whenever the job # shows up later), so recording the payment in Money marks the job Paid with the payment date and commission starts. Paid HCP history is never linked. Needs 032. |
| 034_contract_received.sql | Run once: approved jobs get a Contract step (signed contract / PO received / approved by email) before Schedule. Needs 033. |

| 035_two_step_signin.sql | Run once: password + 6-digit code. Anyone who turned on the code must use it, and the roles ticked in Settings → Team must too; without the code the database treats them as signed out. Changes nothing until someone turns it on. Locked out? Run `update public.settings set data = data - 'mfaRoles' where id = 1;` here. Needs 034. |
| 036_code_reset_feedback.sql | Run once: Settings → Team → **Reset 6-digit code** for someone who lost or changed phones (owner only, logged), and the **Feedback** button: anyone sends a note from the page they're on; the Owner and Admin read it (Feedback inbox, Home → My to-do) and mark it done. Needs 035. |
Client data is never stored in this repository.
