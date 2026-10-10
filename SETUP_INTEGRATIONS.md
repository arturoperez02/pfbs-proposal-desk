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

The same report is in the app: Scorecards → **Monthly report** (any month, with Print / PDF).

## HousecallPro → Proposal Desk (add steps to your existing Zaps)

In HousecallPro, put the PFBS number in the job description when you create the job, for example `PFBS-0801`.
Use the HCP **Job ID** (the long number) for `hcp_job` everywhere, the same ID your service report Zap already sends.

- **Job scheduled:** new Zap, trigger Housecall Pro → New Scheduled Job. Action: Webhooks POST to `.../rpc/zap_hcp` with data
  `token` = your key, `event` = `scheduled`, `ref` = the job description, `hcp_job` = Job ID.
  The proposal moves to **Scheduled** and gets the HCP job ID.
- **Job finished:** don't make a new Zap. Open your existing **"PFBS – Job finished → Service report"** Zap and add one more step at the end:
  Webhooks POST to `.../rpc/zap_hcp` with `token`, `event` = `completed`, `ref` = the job description, `hcp_job` = Job ID.
  The proposal moves to **Invoiced** at the same moment the service report is created.

HousecallPro's Zapier connection has no "invoice paid" trigger, so **Paid** is still marked in the Proposal Desk.

## Service report app → Proposal Desk

Open your Zap that runs when Oscar approves a report (the one that makes the Outlook draft) and add a step:
Webhooks POST to `.../rpc/zap_report_sent` with `token` = your key, `hcp_job` = the job_id from the report,
`ref` = the job number or notes (anything containing the PFBS number also works), and `report_url` = the report link if the step has one.
The job in the Proposal Desk then shows **"Service report sent"** with the date, and the **No service report** filter on the Pipeline
lists finished jobs whose report hasn't gone out.

## SharePoint auto-save

1. entra.microsoft.com → App registrations → **New registration**: name `PFBS Proposal Desk`, accounts in this organization only.
2. **Authentication → Add a platform → Single-page application**, redirect URI
   `https://apps.pfbuildingservices.com/auth.html`. No secret is needed (this is why it works with your tenant policy).
3. **API permissions → Add → Microsoft Graph → Delegated:** `Files.ReadWrite.All` and `Sites.ReadWrite.All` → **Grant admin consent**.
4. Copy the **Application (client) ID** and **Directory (tenant) ID** into `config.js` (`SP_CLIENT_ID`, `SP_TENANT_ID`).

In a proposal, Files → **Choose SharePoint folder** (it suggests Clients / client / property / service from your existing folders).
After that, every proposal, estimate and change order PDF downloads and also saves into that folder, named like
`WC 10-9-2026 Metro Center Senior - PFBS-0801.pdf`. Other files in the folder (OPOS, photos, contracts) are untouched.
