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
    contentInset: 'always',
    preferredContentMode: 'mobile',
    scrollEnabled: true,
    allowsLinkPreview: false
  }
};

export default config;
