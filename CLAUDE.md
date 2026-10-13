# PFBS CRM (Proposal Desk): project guide

Start here. This is the CRM for PF Building Services, a commercial window cleaning, pressure washing, solar panel cleaning,
janitorial and gates & doors company in the Bay Area. Owner: Arturo (aperez@pfbuildingservices.com). It is live at
**https://apps.pfbservices.com** and is used every day, so every change must be tested before it is pushed.

## Ground rules (do not break these)
- **This repo is public.** Never commit client data, real proposals, keys other than the anon key, or tokens.
  Test data in `tests/` is made up and must stay that way.
- Only the Supabase **anon** key goes in the page (`config.js`). Never the service_role/secret key.
- The Zapier integration token lives only in Zapier and in the `integration_keys` table, never in the page, email or repo.
- Emails the app drafts (proposals, follow-ups, service reports) have **no signature**: Outlook adds it.
- Never tell clients crew size or hours (internal only: job actuals, estimates).
- Proposal email wording is Arturo's own; do not rewrite it ("Attached is the proposal you requested…").
- Nothing is deleted from money trails: commission payouts are voided, never deleted; settings/team/deleted proposals go to `admin_log`.
- The goal of every change: **type it once**. If a change makes someone enter the same thing twice, flag it.
- Old apps keep working until their replacement in the CRM is tested (merge rule).

## Files
| File | What |
|---|---|
| `index.html` | The whole CRM: one file, vanilla JS, no build step. Tabs: Pipeline, Leads, Sales, Jobs, Commission, Settings. |
| `reports.html` | Service reports (moved from the old Cloudflare app). Same screens; data layer is Supabase. Edit this file directly. |
| `hub.html` | "Apps" launcher page for the team. |
| `auth.html` | Microsoft sign-in return page (SharePoint, once Entra is set up). |
| `config.js` | Supabase URL + anon key (public by design). |
| `sql/NNN_*.sql` | Database updates, run in order in the Supabase SQL Editor. See `sql/README.md`. |
| `SETUP_INTEGRATIONS.md` | Zapier, HousecallPro and SharePoint setup, written for Arturo. |
| `tests/` | Database tests (in-memory Postgres) and browser tests (Playwright) with made-up data. |

Hosting: GitHub Pages from `main` (custom domain via `CNAME`). Pushing to `main` publishes within a minute or two.

## Database (Supabase)
- Main table `proposals` (key `num` = `PFBS-0123`). Status flow: Lead → Estimating → Needs Review → Sent / Budget →
  Approved → Scheduled → Invoiced → Paid; or Declined / Expired / Withdrawn. (Follow-up status is retired.)
- Others: `team_members` (roles: Owner, Admin, Senior Estimator, Estimator, BD Rep), `settings` (one row, `data` jsonb),
  `proposal_activity`, `proposal_history`, `prospects`, `commission_payouts`, `admin_log`, `deleted_proposals`,
  `service_reports`, `private_settings`, `integration_keys`, `invoices`, `invoice_payments`, `clients`, `client_contacts`,
  `properties` (proposals have `client_id` / `property_id`; the text client/property fields stay for display and old data).
- Security is row level security plus `security definer` functions. `is_manager()` = Owner, Admin, Senior Estimator.
- Zapier calls `rpc/<function>` with the anon key + a `token` checked by `zap_check()`. Single-jsonb functions need the
  header `Prefer: params=single-object`.
- **Every update file starts with a guard** that refuses to run if the previous updates are missing, and must be safe to
  run twice (`create or replace`, `if not exists`, `drop policy if exists`). The DB test runs every file twice.
- The page tolerates missing columns (`COLS` / `toRow`), so the page can ship before the SQL is run.

## Business logic worth knowing
- Recurring contract = a counted line whose frequency has more than 1 visit/year. Contract value = annual × term/12.
- Commission accrues monthly for the first 12 months of a recurring contract, stops at `cancelled_on`; rates lock when
  Date paid is set. Estimator plan: 2% / 3% / 4% by margin, 75% of that when a BD rep is on the job.
- Budget proposals (next year's numbers) are kept out of pipeline and win rate, and expire at year end.
- HousecallPro (Essentials plan) is used for job records and invoices only; crews and clients do not use it.
  Its Zapier trigger sends no job number, description or dates, so service reports link to CRM jobs by
  PFBS number, HCP job #, or **street address** (`zap_report_job`), and use the finish day as the service date.
  The CRM stores the HCP **Job #** clients see, not HCP's internal Job ID.
- Clients pay by check or bank ACH (no cards). Invoices (update 018) are built from the job's accepted scope (one visit
  per invoice for recurring lines) plus approved change orders. Numbers continue from HousecallPro (`set_next_invoice_no`).
  Bill to = billing address + **billing (AP) email**; service reports go to the site contact instead. Clients flagged
  "requires a PO#" cannot be invoiced without one. PO# and billing typed on an invoice are saved back to the job.
  Payments (partial allowed) are recorded once and voided, never edited or deleted; paid in full → job Paid with the
  last payment's date (commission starts). Sending an invoice moves the job to Invoiced. Invoice email: no signature.
- During the switch from HCP, jobs invoiced in HousecallPro are still marked Paid from Jobs → "Invoiced in HousecallPro".

## Testing (run before every push)
```
cd tests && npm install && npx playwright install chromium   # first time only
npm test                                                      # database + browser tests
```
`tests/mock.js` stands in for supabase-js in the browser (made-up data; `MOCK_EXTRA`, `MOCK_SR`, `MOCK_RPC`,
`MOCK_EMAIL` let a test add rows, fake RPCs or sign in as another role). Add a test for every bug fixed.

## Roadmap (merging everything into one CRM) — order agreed 10/12/2026
Done: service reports (`reports.html`, 017; switch the HCP "Job finished" Zap to `zap_report_job`), invoicing (018),
clients & properties (019: Clients tab; HCP customer import groups people by company with `coKey`, which ignores c/o,
punctuation, LLC/Inc/Partners/Management; proposals fill from the client record and create client/contact/property on save).
1. ~~Clients & properties~~ (done; possible next: a "merge two clients" button): `clients` (company, billing address, AP email, PO required), contacts, properties (one
   client can have 40+). Import from HousecallPro's customer CSV inside the app (Settings), never into this repo:
   202 customers, people and companies mixed, merge by company; "Billing?" flag marks the billing address;
   tags used: "PO# Required", "Invoice to AP". Proposals pick client + property; contacts/billing fill in.
2. **Schedule** (replaces HCP's schedule AND TechSched data entry): visits per job with dates/times + assigned techs,
   month view, recurring rule (every N weeks/months, day # or "first Tuesday", ends never/after N/on date; edit
   "only this visit" vs "this and future"; rule prefilled from the proposal frequency; generate ~12 months ahead).
   Schedule asked at Approved. Crews never use an app: keep TechSched's weekly crew emails (per tech, EN/ES,
   date/time/address/team, mailto draft; see `pfbs-schedule` buildJobEmailText). One invoice + one report per visit.
3. **Home + accountant dashboard**: open / past due / paid, A/R aging, deposits, export, her own login; import the
   open HCP invoices (65, ~$162k on 10/12). Waiting on her answers (software, what she pulls, what she wants).
4. **Warehouse**: KitTracker (separate Supabase project, repo `pfbs-kittracker`); kit lists from line items.
5. **Leave HCP**: import history from its exports, run both for 1–2 billing cycles, cancel.
HCP facts: Oscar creates each job in HCP and retypes it in TechSched; HCP job statuses are not kept up (738 "Scheduled",
29 "Completed"), so "done" = invoiced and "paid" = payment recorded in the CRM. Invoice numbers continue after HCP's last.

Pending on Arturo's side: Supabase Pro (daily backups), Entra app for SharePoint (send client ID + tenant ID only).
