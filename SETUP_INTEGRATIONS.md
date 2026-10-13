# Proposal Desk: Zapier and SharePoint setup

Do these after running `sql/007_leads_followups_reports.sql` in Supabase.

## Your integration key (needed for every Zap)

Supabase → SQL Editor → New query → run:

```sql
select token from public.integration_keys;
```

Copy the long code. Treat it like a password: it goes only into Zapier, never into email or the website.
To replace it later (if it leaks), run:
`update public.integration_keys set token = replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');`
then paste the new one into each Zap.

Every Zap below uses **Webhooks by Zapier → POST** with these settings:

| Setting | Value |
|---|---|
| URL | `https://igerptqlkbxmmajixlao.supabase.co/rest/v1/rpc/<function>` |
| Payload type | json |
| Headers | `apikey` = your Supabase anon key (the one in config.js) · `Content-Type` = `application/json` |

Webhooks, multi-step Zaps and Looping need a paid Zapier plan (Professional or higher).

## Zap 1: Monday follow-up drafts

1. **Trigger:** Schedule by Zapier → Every Week → Monday, 7:00 AM.
2. **Action:** Webhooks by Zapier → POST to `.../rpc/zap_followups`. Data: `token` = your key.
3. **Action:** Looping by Zapier → Create Loop From Line Items → map `emails to`, `emails subject`, `emails html`, `emails num`.
4. **Action (inside the loop):** Microsoft Outlook → **Create Draft Email**. To = `to`, Subject = `subject`, Body = `html`, Body format = HTML.

Each run returns the proposals whose follow-up is due (day 3, 10, 21, then every 2 weeks until it expires) and that have a contact email, at most 25.
Each one is logged as a follow-up on the proposal, so it moves to the next step. You review the drafts in Outlook and send.

## Zap 2: Monthly report

1. **Trigger:** Schedule by Zapier → Every Month → day 1, 7:00 AM.
2. **Action:** Webhooks by Zapier → POST to `.../rpc/zap_monthly_report`. Data: `token` = your key. (It reports on last month.)
3. **Action:** Microsoft Outlook → **Send Email**. To = aperez@pfbuildingservices.com, Subject = `subject`, Body = `html`, Body format = HTML.

The same report is in the app: Sales → **Monthly report** (any month, with Print / PDF).

## Zap 5: Weekly backup to SharePoint

Needs database update 015.

1. **Trigger:** Schedule by Zapier → Every Week → Sunday, 11:00 PM.
2. **Action:** Webhooks by Zapier → POST to `.../rpc/zap_backup`. Data: `token` = your key.
3. **Action:** Microsoft OneDrive (or SharePoint) → **Create New Text File** (or the closest "create file from text" action). Folder = a Backups folder, e.g. *Clients › Admin › CRM backups*. File name = `filename`. File content = `content`.

Each Sunday you get one file, e.g. *PFBS Proposal Desk backup 2026-10-18.json*, with every proposal, its history, prospects, the team list, settings, commission payouts and the change log. Keep at least the last 8. If something is ever deleted by mistake, send the file and it can be restored.
Owners and admins can also make one any time: Settings → **Download backup**.

## HousecallPro → Proposal Desk (add steps to your existing Zaps)

In HousecallPro, put the PFBS number in the job description when you create the job, for example `PFBS-0801`.
Use the HCP **Job #** (the number customers see on their confirmation) for `hcp_job` everywhere, the same number you type in the CRM when a job is approved.

- **Job scheduled:** new Zap, trigger Housecall Pro → New Scheduled Job. Action: Webhooks POST to `.../rpc/zap_hcp` with data
  `token` = your key, `event` = `scheduled`, `ref` = the job description, `hcp_job` = Job #.
  The proposal moves to **Scheduled** and gets the HCP job #.
- **Job finished:** don't make a new Zap. Open your existing **"PFBS – Job finished → Service report"** Zap and add one more step at the end:
  Webhooks POST to `.../rpc/zap_hcp` with `token`, `event` = `completed`, `ref` = the job description, `hcp_job` = Job #.
  The proposal moves to **Invoiced** at the same moment the service report is created.

HousecallPro's Zapier connection has no "invoice paid" trigger, so **Paid** is still marked in the Proposal Desk.

## HousecallPro: paid invoices (optional, needs HCP MAX + a paid Zapier plan)

Needs database update 016. Without this, Oscar marks jobs Paid from the Jobs tab → **Waiting on payment** list.

1. **Trigger:** Webhooks by Zapier → **Catch Hook**. Copy the webhook URL Zapier gives you.
2. In HousecallPro: **My Apps → Webhooks** (MAX plan) → add that URL and tick the **job.paid** event (or **invoice.paid**).
3. **Action:** Webhooks by Zapier → POST to `.../rpc/zap_hcp`. Data: `token` = your key, `event` = `paid`, `ref` = the job **description** field from the hook, `hcp_job` = the job **number** field.

The job moves to **Paid**, Date paid is set to today (commission starts), and a note is added to its history.
It matches on the PFBS number in the job description first, so keep putting "PFBS-0806" in every HCP job description.

## Service report app → Proposal Desk

Open your Zap that runs when Oscar approves a report (the one that makes the Outlook draft) and add a step:
Webhooks POST to `.../rpc/zap_report_sent` with `token` = your key, `hcp_job` = the job_id from the report,
`ref` = the job number or notes (anything containing the PFBS number also works), and `report_url` = the report link if the step has one.
The job in the Proposal Desk then shows **"Service report sent"** with the date, and the **No service report** filter on the Pipeline
lists finished jobs whose report hasn't gone out.

## Service reports inside the CRM (update 017)

The service report screens now live at **apps.pfbservices.com/reports.html**, using the CRM login (Owner, Admin and Senior Estimator).
The old Cloudflare app keeps working until step 3, so nothing breaks while you try it.

1. Run `sql/017_service_reports.sql` in Supabase.
2. Try one: open a scheduled job → Job tab → **Write service report**. The client, contact email, address and scope come from the job.
   Add a photo and tap **Approve & email**: the PDF downloads and an Outlook email opens with the client, subject and message filled in.
   Attach the PDF and send (Outlook adds your signature). The job shows "Sent to the client". **Email again** on a sent report repeats this.
3. Switch over: open the **"PFBS – Job finished → Service report"** Zap. In the step that posts to the old Cloudflare link, change:
   - URL → `https://igerptqlkbxmmajixlao.supabase.co/rest/v1/rpc/zap_report_job`
   - Payload type → json
   - Headers → `apikey` = your anon key · `Content-Type` = `application/json` · `Prefer` = `params=single-object`
   - Data → keep every field it sends today, and add `token` = your integration key, `job_number` = Job # (the one customers see), `job_id` = Job ID, `client`, `email`, `line_items`, `notes` = job description, `start`, `end`.

   The reply still has `review_url` (now a CRM link), so any later step that uses it keeps working.
   If the Zap has a step that emails Oscar "a report is ready", delete it: new reports show in the CRM (Jobs → **Service reports to send**, and the count on the **Reports** button).
   The report links itself to the PFBS job by the PFBS number in the HCP job description, or by the HCP job # (or job ID).
4. After a week with no problems: clear "Old service report app link" in Settings. Turn off the "report approved → Outlook draft" Zap; the CRM opens the email itself now. Keep the Cloudflare app for a while as a read-only archive of old reports.

## Invoicing in the CRM (update 018)

1. Run `sql/018_invoicing.sql` in Supabase.
2. Settings → **Invoicing**: check the message, terms, address, phone, email, website and license #.
3. On the day you stop invoicing in HousecallPro: Settings → Invoicing → **Next invoice #** = your last HCP invoice # + 1 → **Set**.
4. For clients whose AP needs a PO#, open one of their jobs → Proposal tab → "Client requires a PO# on invoices" = Yes,
   and fill in "Billing (AP) email". New proposals for that client copy both automatically.
5. To invoice: Jobs → **Invoice** on a scheduled job (or the job's Job tab → Create invoice) → check the lines → **Save & email**.
   The PDF downloads and Outlook opens to the AP email; attach and send. Payments: Jobs → Open invoices → **Record payment**.

## Clients (update 019)

1. Run `sql/019_clients.sql` in Supabase.
2. In HousecallPro: Customers → Export (the CSV file).
3. In the CRM: Settings → **Clients** → **Import HousecallPro customers…** → pick the file → check the preview → **Import**.
   People at the same company become contacts under one client (spelling variants like "c/o Lincoln Property Company"
   are merged and kept as "also known as"); addresses become properties; the billing office becomes the billing address.
   Existing proposals are linked to their client automatically. Safe to run again later: nothing is duplicated or overwritten.
4. Open the **Clients** tab and spot-check your biggest clients: fix names, set the AP email and "Requires a PO#".

## Schedule (update 020)

1. Run `sql/020_schedule.sql` in Supabase.
2. Settings → **Crew**: one tech per line, `Name | email | es` (or `en`): the language of their schedule email.
   Also check Work types, Equipment and Vehicles.
3. Approved jobs show a **Schedule** button on the Jobs tab (also: the job → Job tab → Schedule). Recurring jobs start
   with a repeat rule from the proposal (Quarterly = every 3 months; change it to "first Tuesday" or "day 15").
   Visits are created about 12 months ahead and keep rolling forward. Changing a recurring visit asks
   "Only this visit" or "This and all future visits", like HousecallPro.
4. Every week: Schedule → **Crew emails** → pick the week → **Draft** for each tech (English or Spanish) → Outlook.
5. Keep TechSched and HCP's schedule running side by side for a week or two, then stop entering jobs there.

## SharePoint auto-save

1. entra.microsoft.com → App registrations → **New registration**: name `PFBS Proposal Desk`, accounts in this organization only.
2. **Authentication → Add a platform → Single-page application**, redirect URI
   `https://apps.pfbservices.com/auth.html`. No secret is needed (this is why it works with your tenant policy).
3. **API permissions → Add → Microsoft Graph → Delegated:** `Files.ReadWrite.All` and `Sites.ReadWrite.All` → **Grant admin consent**.
4. Copy the **Application (client) ID** and **Directory (tenant) ID** into `config.js` (`SP_CLIENT_ID`, `SP_TENANT_ID`).

In a proposal, Files → **Choose SharePoint folder** (it suggests Clients / client / property / service from your existing folders).
After that, every proposal, estimate and change order PDF downloads and also saves into that folder, named like
`WC 10-9-2026 Metro Center Senior - PFBS-0801.pdf`. Other files in the folder (OPOS, photos, contracts) are untouched.
