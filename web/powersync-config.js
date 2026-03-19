// PowerSync + Supabase configuration
// Replace these placeholder values with your actual credentials.

window.POWERSYNC_CONFIG = {
  // From Supabase Dashboard → Settings → API
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR_ANON_KEY',

  // From PowerSync Dashboard → your instance
  powersyncUrl: 'https://YOUR_INSTANCE.powersync.journeyapps.com',

  // Magic link redirect URL (optional).
  // On Desktop (Electron): set to 'notesapp://auth/callback' to have magic
  // links re-open the app automatically after email confirmation.
  // You must also add 'notesapp://auth/callback' to Supabase's list of
  // allowed redirect URLs (Auth → URL Configuration → Redirect URLs).
  // On iOS: set to your app's deep link URL (e.g. 'com.example.notes://auth').
  // Leave undefined to use Supabase's default redirect (opens in a browser).
  redirectTo: undefined
};
