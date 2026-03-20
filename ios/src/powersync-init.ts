// PowerSync Capacitor SDK initializer.
// Bundles @powersync/capacitor (native SQLite on iOS/Android, WA-SQLite on web)
// and @supabase/supabase-js into a single script that exposes the same globals
// as the existing web vendor/powersync-bundle.min.js:
//   window.PowerSync  = { PowerSyncDatabase, column, Schema, Table }
//   window.SupabaseClient = { createClient }
//
// This file is bundled by esbuild into www-override/powersync-bundle.min.js,
// which replaces the WASM-based bundle when running inside Capacitor.

import { PowerSyncDatabase } from '@powersync/capacitor';
import { column, Schema, Table } from '@powersync/web';
import { createClient } from '@supabase/supabase-js';
import { SQLiteDBConnection } from '@capacitor-community/sqlite';

// ── Fix: Convert Uint8Array to plain Array before WKWebView bridge ──────────
// On iOS, WKWebView's structured clone serializes Uint8Array as a dictionary
// {"0": NSNumber, "1": NSNumber, ...} which the Swift plugin can't reliably
// parse back to bytes. By converting to a plain Array<number> before the call,
// the structured clone sends a simple NSArray of NSNumbers that Swift handles
// correctly via its existing [String: Any] → extract sorted values path.
const _origRun = SQLiteDBConnection.prototype.run;
SQLiteDBConnection.prototype.run = function (
  statement: string,
  values?: any[],
  transaction?: boolean,
  returnMode?: string,
  isSQL92?: boolean
) {
  if (values && values.length > 0) {
    values = values.map((v: any) =>
      v instanceof Uint8Array ? Array.from(v) : v
    );
  }
  return _origRun.call(this, statement, values, transaction, returnMode, isSQL92);
};

// Expose the same globals that powersync-storage.js expects.
(window as any).PowerSync = { PowerSyncDatabase, column, Schema, Table };
(window as any).SupabaseClient = { createClient };
