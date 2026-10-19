// PFBS Proposal Desk — Supabase connection (public anon key; the database's security rules protect the data).
window.PFBS_CONFIG = {
  SUPABASE_URL: 'https://igerptqlkbxmmajixlao.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlnZXJwdHFsa2J4bW1haml4bGFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1NzkzNTgsImV4cCI6MjEwNzE1NTM1OH0.v9KLRc9DUbxt9NVeOiODegs91fHi89I89nEq7rLtzYE',

  // SharePoint auto-save (optional). From Microsoft Entra → App registrations → PFBS Proposal Desk → Overview.
  // These are IDs, not secrets. Leave blank to turn SharePoint saving off.
  SP_CLIENT_ID: 'ecfd1c5f-60c4-4bc9-be82-5f5b5073f705',   // Application (client) ID
  SP_TENANT_ID: 'ab8d6915-bd2b-4bfb-8203-c06f6ad57b2f',   // Directory (tenant) ID
  SP_SITE: 'pfwindowcleaning.sharepoint.com:/sites/team',
  SP_LIBRARY: 'Clients'
};
