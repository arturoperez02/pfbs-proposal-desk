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
| `index.html` | The whole CRM: one file, vanilla JS, no build step. Tabs (+ a Warehouse link to `warehouse.html`): Home (managers' landing page: KPIs, jobs board Unscheduled / Scheduled / To invoice / Invoice sent / On hold, this week, recent activity), Pipeline, Leads, Sales, Jobs, Schedule, Money, Commission, Clients, Settings. A won job's drawer opens with "Job #… · Job for <client>" and HCP-style steps Schedule → Finish → Invoice → Pay (no OMW/Start, Arturo 10/16), each a button (`jobFlowHTML`, `jobStep`, `jobState`); Finish marks the visits Done (a finished one-time job then needs a service report: `needsReport`/`jobFinished` — Jobs → Service reports to send, Home count and the drawer's Service report button, not only after invoicing; same for Jobs → Log actual hours, whose Start / Finish dates fill from the Done visits); HCP-style **UNDO** above Schedule / Finish (`jobUndoable`/`jobUndo`, managers): Undo schedule deletes the job's Scheduled visits that are not on an invoice, stops its repeat series (active=false) and puts the job back to Approved if no visits are left; Undo finish puts Done visits without an invoice back to Scheduled (recurring: the last one only) and, for Owner/Admin on a job not yet invoiced, asks whether to delete its unsent (pending) service report drafts so they stop asking to be sent (Cancel keeps them); invoices and payments are never undone here (void them instead); sending the invoice on a one-time job marks all its scheduled visits Done (recurring: visits up to the service date, by the 022 trigger). |
| (top bar) | Search everything (`gSearch`: jobs/estimates, customers, invoices, visits; "/" focuses it) and an HCP-style **+ New** menu (`newThing`: Job / Recurring Job open the HCP-style **New job** page (`newJobPage`: customer search or new, site, schedule from/to/anytime/weekdays/repeats, team with busy marks, job type, private notes, service + material lines with qty × price and tax on materials) → Save job = proposal saved Approved (job # by trigger) + visit or repeat series; Proposal; Event; Client; Lead; the UI says Client everywhere, matching the Clients tab). Arturo's word is **proposal**, not estimate; the per-line cost builder is called **Pricing** (Price it / Pricing PDF). Margin on every sheet (solar included): profit = price − all job costs; margin % = profit ÷ (price − pass-through), pass-through = lifts/subs + materials + tax at cost (the client's money; only its markup is profit) (`marginAt`, `priceForMargin`, `marginPct` for the proposal floor check). Commission tiers still use `gpPct` = gp ÷ amount (Arturo, 10/13: keep commission as is). Proposals have a drop-down of the client's addresses (`propPickHTML`/`pickProperty`: fills property, site address and the property's contact). **Price book** (`priceBook()`): ONE list — services in `S.priceBook` (Settings → Price book: name | price | unit | description), materials = estimating Material presets at cost × (1 + material markup); used by New job (datalist + picker, new services saved to the book), proposal lines and invoice lines (price fills when empty). Job type is taken from the lines if not picked. |
| (Clients tab) | Customer page like HCP's (`renderClient`, `CLTAB`): header with + Job / + Proposal / + Lead / + Recurring job set to this customer (`newJobPage(rec, {client})`), tabs Profile (summary: created, lifetime value = paid on its invoices, outstanding; contact info; billing; addresses + Google map embed; contacts) · Leads · Proposals · Jobs · Invoices (`clInvoices`: by proposal or bill-to name/aliases, so HCP history shows) · Notes. `saveClient` only changes the fields on the open tab. |
| `warehouse.html` | Warehouse (was KitTracker, moved in by update 026): same screens, CRM database (`wh_` tables) and CRM sign-in; tablet logins in `warehouse_logins`; "Import from CRM Schedule" fills a kit from a visit and saves `visit_id`. Edit this file directly; the old `pfbs-kittracker` repo stays up until the switch. |
| `reports.html` | Service reports (moved from the old Cloudflare app). Same screens; data layer is Supabase. Edit this file directly. |
| `jobsheet.js` | The job packet (page 1 job sheet, page 2 kit slip), shared by `index.html` and `warehouse.html` so it's built once: `JP.open(data, lang, tr)`, `JS_T` texts EN/ES, `ES_TERMS` (Spanish terms, also used by the CRM's `toEs`), its own print CSS. Never prices. |
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
- Others: `team_members` (roles: Owner, Admin, Senior Estimator, Estimator, BD Rep, Accountant (021: Money + Clients only;
  `can_money()` = managers + Accountant for invoices/payments)), `settings` (one row, `data` jsonb),
  `proposal_activity`, `proposal_history`, `prospects`, `commission_payouts`, `admin_log`, `deleted_proposals`,
  `service_reports`, `private_settings`, `integration_keys`, `invoices`, `invoice_payments`, `clients`, `client_contacts`,
  `properties`, `visits`, `visit_series` (proposals have `client_id` / `property_id`; the text client/property fields stay for display and old data).
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
  Opening a sent / paid / void invoice shows the invoice itself like HCP (`invView`: Print · Download · Pay · Send · Edit, Job # link to the job, the document `invDocHTML`, Activity `invHistory`); drafts and Edit use the form (`invEdit(p,v,{edit:true})`).
  Invoice email body is only Arturo's wording: "Hi <first>, Attached is invoice #N for <place>, due net 30. Please let me know if you have any questions." (no details block, no closing line).
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
1. ~~Clients & properties~~ (done; 022: each property has its own contact (`properties.contact_id`), filled on proposals; possible next: a "merge two clients" button): `clients` (company, billing address, AP email, PO required), contacts, properties (one
   client can have 40+). Import from HousecallPro's customer CSV inside the app (Settings), never into this repo:
   202 customers, people and companies mixed, merge by company; "Billing?" flag marks the billing address;
   tags used: "PO# Required", "Invoice to AP". Proposals pick client + property; contacts/billing fill in.
2. ~~Schedule~~ (done, updates 020 + 022: job # per visit (`visits.job_no`; HCP job # until `set_next_job_no` turns on CRM
   numbering; 023: the job # is given at approval (`proposals.hcp_job` = the job #), first visit uses it, later recurring
   visits get their own; UI calls it "Job #"), weekday-only visits, HCP-style repeat menu (daily / every weekday / weekly / monthly nth / yearly / custom),
   scope of work on the visit and in crew emails, sent invoice → visits Done; Schedule tab month view, visit editor, repeat rules, weekly crew emails EN/ES,
   drawer Job tab → Schedule; 027: Schedule → "Import from TechSched" reads TechSched's Firestore (read-only) and copies upcoming jobs
   into visits (`ext_id` = techsched:<id>, linked by job # ≤6 digits or street address, re-run updates; rental pickup goes in office notes);
   the import also merges TechSched's team (settings/main: techs, emails, capabilities, vehicles, equipment) into Settings and can bring past jobs as Done;
   crew = [name, email, lang, capabilities[], other names[], inactive] edited in Settings → Crew as a table (capabilities in a dropdown of checkboxes per tech, search + capability + active filters for 20–50 techs, `crewCardHTML`/`readCrewCard`/`crewFilter`; visit editor and New job have a Find-a-tech box too); every tech name on a visit goes through `crewName` (other names, unique first name) at load (`normVis`) and saving the crew writes the one name back onto visits (`fixTechNames`); `allTechs()` = active crew + names on recent visits; `skillOptions`; vehicles = Warehouse vehicles + Settings (`vehList`); Settings has section jump links and a sticky Save bar; visit editor opens HCP-style full screen (`schedpop`, Arturo 10/16): ✕ "Schedule a time for Job #…" + Save on top, form on the left, live month calendar on the right (`popCalHTML`: this job in gold, other visits, filter by employee, faded = jobs without the picked techs, click a day to move the date; techs are one compact row each: name · busy · skills truncated, full list on hover, picked = gold, list scrolls); visit editor: "who can" filter, busy marks (`techConflicts`), equipment→capability gap note (from `equipFromJob`); equipment is NOT picked by hand (Arturo 10/16): the editor shows the pricing's equipment lines by their exact names (`pricingEquip`/`equipBox`, qty > 0) and saves them + the lifts onto `visits.equipment` (`jobEquip`) for the Warehouse; crew emails have no Equipment line (the warehouse packs it, the supervisor drops it off; the lift Rental line stays);
   double booking: warning on save + orange chips (`dblBooked`, night shifts past midnight count);
   visits no longer show Work (scope of work instead; `work` kept for old rows / warehouse); still to do: equipment rental pickup dates as fields).
   Original spec — Schedule (replaces HCP's schedule AND TechSched data entry): visits per job with dates/times + assigned techs,
   month view, recurring rule (every N weeks/months, day # or "first Tuesday", ends never/after N/on date; edit
   "only this visit" vs "this and future"; rule prefilled from the proposal frequency; generate ~12 months ahead).
   Schedule asked at Approved. Crews never use an app: keep TechSched's weekly crew emails (per tech, EN/ES,
   date/time/address/team, mailto draft; see `pfbs-schedule` buildJobEmailText). One invoice + one report per visit.
   024: jobs can be put **on hold** with a reason (`on_hold_since`, `on_hold_reason`); they keep status, job # and schedule.
3. ~~Money / accountant dashboard~~ (done, 021: Money tab with owed / past due / collected / not deposited, aging by
   client, payments by month with deposit dates, CSV exports, open-HCP-invoice import). Still open: her answers (software
   → tailor the CSV columns); Home tab done 10/12. Original spec — **Home + accountant dashboard**: open / past due / paid, A/R aging, deposits, export, her own login; import the
   open HCP invoices (65, ~$162k on 10/12). Waiting on her answers (software, what she pulls, what she wants).
4. **Warehouse**: KitTracker (separate Supabase project, repo `pfbs-kittracker`); kit lists from line items.
   Done 10/12 (025 + 026): Warehouse tab = `warehouse.html` on the CRM database; `can_warehouse()` = Owner/Admin/Senior
   Estimator/Estimator or a `warehouse_logins` email (tablet; not a team member, so every other table stays closed).
   The job drawer shows the kit status (`kitLine`, matched by visit_id or job #). One-time copy of the old KitTracker data:
   Settings → Warehouse → "Copy data from the old KitTracker". TechSched import stays until Oscar schedules only in the CRM.
5. **Leave HCP**: import history from its exports, run both for 1–2 billing cycles, cancel.
HCP facts: Oscar creates each job in HCP and retypes it in TechSched; HCP job statuses are not kept up (738 "Scheduled",
29 "Completed"), so "done" = invoiced and "paid" = payment recorded in the CRM. Invoice numbers continue after HCP's last.

Proposal numbers: `proposal_seq` (031 sets the next to PFBS-0803 or after the highest used; Settings → Proposal numbers, `set_next_proposal_no`). Opening a proposal fills blanks from the client record (`fillClientBlanks`: billing address, AP email, PO#, contact); Date sent has a Today button and moves to today when it goes Sent; Save changes stays in the drawer at the same scroll; Download PDF / Pricing PDF / change order / invoice preview open `pdfPreview` first (the email flow still downloads straight away); PDFs use the sharp `reports-logo.jpg`; site photos print on their own page 2 (after the services strip, before the terms). Approving (status or "convert to job") asks which add-ons the client accepted (`confirmAddons`); going to Needs Review / Sent with unpriced counted lines asks first. Lifts in the pricing become "To reserve" rentals on the job at approval (`buildParts`) and show on the schedule chip (LIFT, orange until handled), in the visit editor (`rentBox`), on Home ("Lifts / rentals to handle") and in crew emails (`t.rental`). A won job with no rentals saved still counts the pricing's rentals (`jobRentals` → `pricingRentals`), so Home / LIFT / alerts work, and opening it (managers) saves them on the job as To reserve with an activity note (`syncPricingRentals`) — covers jobs approved before the lift was in Subcontractors / rentals (Arturo 10/16, PFBS-0801). Jobs → Parts & rentals: clicking a rental row opens a pop-up (`rentQuick`, next status preselected via `RENT_NEXT`, `rentStamp` shared with the job tab) that saves straight onto the job without opening it; rental status is HCP-style icon steps, never a dropdown (Arturo 10/16): `rentFlowHTML` Reserved 📅 → Delivered 🚚 → Off-rent 📞 → Picked up ✓ → Final bill $ (click a step to move there, click the current one to go back one; pop-up sets a hidden `status` input, the job tab drives a hidden status select via `rentPick`); the list shows mini icons (`rentMini`); the job cell link opens the job. Jobs tab no longer lists open invoices (one line → Money); the "Invoiced in HousecallPro" card only shows when it has jobs. Every table sorts by clicking a column heading (`SORTS`, `applySort`: numbers/dates biggest/newest first, click again to flip; kept across re-renders by a MutationObserver). Payment reminders: the plan (`remPlanHTML`) shows when sending an invoice and in each reminder; "Skip: client confirmed" records a skipped step through the due date (no schema change). My to-do (groups show as count chips, click to open; per-item Snooze 1 week / Not mine stored per browser in localStorage `pfbs.todoHide`; Settings → CRM start date `S.crmStart` leaves out older items; Home also has the Monday snapshot `snapHTML`: last week vs the week before) (`todoGroups`/`renderTodo`, slots `#todo-home` / `#todo-sales` for Estimator/BD / `#todo-money` for Accountant): only the signed-in person's items by role. Clients → Data check (`dataIssues`: no email, no AP email, no billing address, stuck-together addresses `stuckAddr`, no site contact, possible duplicates by `coKey`). Sales (team view) → Profit by client / by service (`profitRows`/`renderProfit`; planned from p.gp, actual from `jobCompare`; margin excludes pass-through); the older By service card is now win rate only. Home → Contracts up for renewal, next 90 days (`renewList`/`renewHTML`, Start renewal = `requote` with `incPct()`). Arturo does NOT want client-facing link/portal approval suggested (10/14). Drawer header ⋯ menu (managers, `dMore`/`dMenu`): **Copy to new job** (Approved, same estimator, lines + accepted add-ons, lifts as To reserve, job # by trigger, Schedule is the next step) and **Copy to new proposal** (Estimating, not sent, add-ons not accepted) via `copyProposal`; copies client/site/contacts/billing/lines/notes only, never dates, job #, visits, invoices, payments, commission or photos; activity says "Copied from PFBS-…" (Arturo 10/16, like HCP). **Job packet** (Arturo 10/17–18; crews aren't tech-savvy, so it's printed; NO repetition between pages): button "🖨 Job packet" in the job drawer (next or last visit) and the visit editor (`jobSheet(v)` async, `jobSheetHTML(v,lang,kit)`, `JS_T`, EN/ES toggle, defaults to Spanish when a tech on it is Spanish or nobody is assigned). Page 1 job sheet: job #, client, site, date/time, crew, vehicle (no site contact: that stays with the PM, Arturo 10/18), scope (toEs), one Kit line ("N items — see the kit slip (page 2)" or "not packed yet"), lift rental details, crew notes, photos-to-take checklist, "Back from the job" box filled by pen (finish date, days, techs, hours, off-rent #, photos, problems, client + supervisor + warehouse signatures). Page 2 = the warehouse kit slip for that visit (`kitFor`: wh_jobs by visit_id or job #, wh_job_items not removed): item | qty | Out | Back boxes, additional material lines, tech + supervisor signatures — no job info repeated. Materials are NOT listed on page 1: update 032 sends the pricing materials to the warehouse (`pfbs_materials`, `warehouse_jobs.materials`) and warehouse.html adds them to the kit (`coJobMaterials`, kept when the template changes). Never prices. Print CSS hides everything else. The page itself lives in `jobsheet.js` (CRM builds the data with `packetData`); **the Warehouse prints it** (Arturo 10/18: they pack last): after packing, "🖨 Job packet EN/ES" and the dashboard reprint use `printJobPacket(job)` for kits linked to a CRM visit (`crmVisitFor` via `warehouse_jobs`, which also sends end_time and the job's lifts without costs: `pfbs_rentals`); kits not from the CRM still print the old slip. **Autosave** (Arturo 10/17): an open, existing proposal/job saves itself ~1.2 s after the last keystroke (`autoSave`, 1 s poll, compares `rowSig(draft)` vs `rowSig(orig)`; skips new records, people who can't edit, a Lost status without a reason, and while Save is running); closing the drawer flushes it; fields the server fills (job # at approval) are merged back into the form; the footer shows "All changes saved · time", Cancel is gone for existing records and the button reads "Save now". A refresh keeps the tab, the open client + its tab and the open proposal (sessionStorage `pfbs.tab` / `pfbs.client` / `pfbs.cltab` / `pfbs.open`).

Pending on Arturo's side: Supabase Pro (daily backups), Entra app for SharePoint (send client ID + tenant ID only).
