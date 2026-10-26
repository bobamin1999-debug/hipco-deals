/* HIPCO Deals connection settings.
   The anon/publishable key is safe to publish: the database only answers people who are signed in
   and on the team list (row-level security). Never put the service_role / secret key here. */
window.HIPCO_CONFIG = {
  supabaseUrl: "",   // e.g. https://abcdefgh.supabase.co
  supabaseKey: "",   // anon / publishable key
  bucket: "deal-files"
};
