// PFBS Proposal Desk — Supabase connection (public anon key; the database's security rules protect the data).
window.PFBS_CONFIG = {
  SUPABASE_URL: 'https://igerptqlkbxmmajixlao.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlnZXJwdHFsa2J4bW1haml4bGFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1NzkzNTgsImV4cCI6MjEwNzE1NTM1OH0.v9KLRc9DUbxt9NVeOiODegs91fHi89I89nEq7rLtzYE',

  // SharePoint auto-save (optional). From Microsoft Entra → App registrations → PFBS Proposal Desk → Overview.
  // These are IDs, not secrets. Leave blank to turn SharePoint saving off.
  SP_CLIENT_ID: '',   // Application (client) ID
  SP_TENANT_ID: '',   // Directory (tenant) ID
  SP_SITE: 'pfwindowcleaning.sharepoint.com:/sites/team',
  SP_LIBRARY: 'Clients'
};
