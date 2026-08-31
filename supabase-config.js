/* Supabase connection settings.
 *
 * The publishable ("anon") key below is SAFE to ship in the browser and commit
 * to a public repo — it is designed for front-end use. Data is protected by the
 * Row-Level Security policies in backend/schema.sql, not by keeping this secret.
 *
 * Never put the service_role key here — that one bypasses RLS and must stay
 * server-side (e.g. a Supabase Edge Function secret).
 *
 * Used by the cloud sync / login layer (Phase 1). The offline localStorage app
 * works without it.
 */
window.TASKTRACK_SUPABASE = {
  url: "https://tlapegutuiaikhbjhhkg.supabase.co",
  anonKey: "sb_publishable_rVEKBp2pZbIkhjo_we5biA_ud69_tGQ",
};
