import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.notesapp.ios',
  appName: 'Notes App',
  webDir: 'www',
  server: {
    // Allow loading from local files (CDN scripts)
    allowNavigation: ['cdn.jsdelivr.net']
  },
  ios: {
    // Let the webview extend edge-to-edge (under notch and home indicator).
    // Safe area insets are handled in CSS via env(safe-area-inset-*).
    contentInset: 'never',
    preferredContentMode: 'mobile',
    scrollEnabled: true,
    allowsLinkPreview: false
  }
};

export default config;
