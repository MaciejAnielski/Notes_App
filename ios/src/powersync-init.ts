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

// Expose the same globals that powersync-storage.js expects.
(window as any).PowerSync = { PowerSyncDatabase, column, Schema, Table };
(window as any).SupabaseClient = { createClient };
