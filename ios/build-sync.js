// build-sync.js — Bundles the PowerSync Capacitor SDK into a single script
// that replaces the WASM-based powersync-bundle.min.js for iOS/Android.
//
// Output: www-override/powersync-bundle.min.js
// This file is copied over the web vendor bundle during `npm run build`.

const { buildSync } = require('esbuild');
const path = require('path');

buildSync({
  entryPoints: [path.join(__dirname, 'src', 'powersync-init.ts')],
  bundle: true,
  minify: true,
  format: 'esm',
  outfile: path.join(__dirname, 'www-override', 'vendor', 'powersync-bundle.min.js'),
  platform: 'browser',
  target: ['es2020'],
  // Capacitor plugins use dynamic native bridge calls — mark them as external
  // only if they cause issues. For now, let esbuild resolve everything.
});

console.log('[build-sync] Built www-override/vendor/powersync-bundle.min.js');
