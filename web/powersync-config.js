// PowerSync + Supabase configuration
// Replace these placeholder values with your actual credentials.

window.POWERSYNC_CONFIG = {
  // From Supabase Dashboard → Settings → API
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR_ANON_KEY',

  // From PowerSync Dashboard → your instance
  powersyncUrl: 'https://YOUR_INSTANCE.powersync.journeyapps.com',

  // Magic link redirect URL.
  // Set this so clicking the sign-in email link re-opens the app directly.
  //
  // Desktop (Electron): use 'notesapp://auth/callback'
  //   • Also add 'notesapp://auth/callback' to Supabase →
  //     Auth → URL Configuration → Redirect URLs.
  //
  // iOS (Capacitor): use 'notesapp://auth/callback'
  //   • Register the 'notesapp' URL scheme in Xcode:
  //     Target → Info → URL Types → add item with URL Schemes = "notesapp"
  //   • Also add 'notesapp://auth/callback' to Supabase →
  //     Auth → URL Configuration → Redirect URLs.
  //
  // Leave undefined to fall back to OTP code entry (no deep-link needed).
  redirectTo: undefined
};
