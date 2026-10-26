/* HIPCO Deals connection settings.
   The anon/publishable key is safe to publish: the database only answers people who are signed in
   and on the team list (row-level security). Never put the service_role / secret key here. */
window.HIPCO_CONFIG = {
  supabaseUrl: "https://lkgvghqvtkbqrovfohqe.supabase.co",   // e.g. https://abcdefgh.supabase.co
  supabaseKey: "sb_publishable_8SdHt5bwnaqy-AUJont3wA_JxEEXm2O",   // anon / publishable key
  bucket: "deal-files"
};
