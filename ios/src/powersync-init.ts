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

// ── Fix: Convert Uint8Array to indexed Object before WKWebView bridge ───────
// On iOS, WKWebView's structured clone serializes Uint8Array as a dictionary
// {"0": NSNumber, "1": NSNumber, ...} with internal NSNumber types that
// Swift can't reliably cast to Int. Converting to a plain JS Array doesn't
// help either — Swift receives it as Array<JSValue> which isn't a SQL type.
//
// Solution: explicitly convert to a plain JS Object {"0": n, "1": n, ...}
// with standard JS numbers. This way WKWebView sends [String: Any] with
// clean NSNumber values, and the Swift run() method's dictionary branch
// (patched with NSNumber.uint8Value) handles it correctly.
const _origRun = SQLiteDBConnection.prototype.run;
SQLiteDBConnection.prototype.run = function (
  statement: string,
  values?: any[],
  transaction?: boolean,
  returnMode?: string,
  isSQL92?: boolean
) {
  if (values && values.length > 0) {
    values = values.map((v: any) => {
      if (v instanceof Uint8Array) {
        const obj: Record<string, number> = {};
        for (let i = 0; i < v.length; i++) obj[String(i)] = v[i];
        return obj;
      }
      return v;
    });
  }
  return _origRun.call(this, statement, values, transaction, returnMode, isSQL92);
};

// Expose the same globals that powersync-storage.js expects.
(window as any).PowerSync = { PowerSyncDatabase, column, Schema, Table };
(window as any).SupabaseClient = { createClient };
