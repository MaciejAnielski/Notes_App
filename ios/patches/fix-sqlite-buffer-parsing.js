#!/usr/bin/env node
// Patches @capacitor-community/sqlite CapacitorSQLite.swift to fix
// "Error in reading buffer" on iOS during PowerSync sync.
//
// Root cause: The `run()` method's parameter parser converts JS values to
// Swift types for SQLite bind parameters. When PowerSync passes binary data
// (Uint8Array) through the Capacitor bridge on iOS, WKWebView's structured
// clone serializes it as a dictionary {"0": v, "1": v, ...} with NSNumber
// values. The original code only checks `as? Int` for inner values, but
// NSNumber from WKWebView may not cleanly cast to Swift Int depending on
// its internal Objective-C representation.
//
// Additionally, the Uint8Array may arrive as native Data (NSData) in some
// iOS versions, which the original code doesn't handle at all.
//
// This patch (v2):
//   1. Adds Bool handling before the dictionary branch
//   2. Adds Data/NSData handling for direct binary data
//   3. Uses NSNumber as universal numeric handler inside the buffer branch
//   4. Adds diagnostic type info to error messages

const fs = require('fs');
const path = require('path');

const filePath = path.join(
    __dirname, '..', 'node_modules', '@capacitor-community', 'sqlite',
    'ios', 'Plugin', 'CapacitorSQLite.swift'
);

if (!fs.existsSync(filePath)) {
    console.log('CapacitorSQLite.swift not found, skipping buffer-parsing patch.');
    process.exit(0);
}

let content = fs.readFileSync(filePath, 'utf8');

if (content.includes('// [PATCHED] buffer-parsing v2')) {
    console.log('CapacitorSQLite.swift buffer-parsing v2 already applied, skipping.');
    process.exit(0);
}

let applied = 0;

// ── Patch 1: Add Bool + Data handlers after NSNull, before dictionary ──
const nsNullToDict = `} else if value is NSNull {
                            val.append(value)
                        } else if let obj = value as? [String: Any] {`;

const nsNullToDictPatched = `} else if value is NSNull { // [PATCHED] buffer-parsing v2
                            val.append(value)
                        } else if let obj = value as? Bool {
                            val.append(obj ? 1 : 0)
                        } else if let data = value as? Data {
                            // Uint8Array may arrive as native Data via WKWebView structured clone
                            val.append([UInt8](data))
                        } else if let obj = value as? [String: Any] {`;

if (content.includes(nsNullToDict)) {
    content = content.replace(nsNullToDict, nsNullToDictPatched);
    applied++;
}

// ── Patch 2: Replace inner value casting with NSNumber-based conversion ──
// Match the original unpatched inner block
const originalInner = `if let iVal = mVal as? Int {
                                                valuesArr.append(UInt8(iVal))
                                            } else {
                                                let msg: String = "Error in reading buffer"
                                                throw CapacitorSQLiteError.failed(message: msg)
                                            }`;

const patchedInner = `if let num = mVal as? NSNumber { // [PATCHED] buffer-parsing v2
                                                valuesArr.append(num.uint8Value)
                                            } else if let iVal = mVal as? Int {
                                                valuesArr.append(UInt8(iVal))
                                            } else {
                                                let msg = "Error in reading buffer: type \\(type(of: mVal)) for key '\\(key)'"
                                                throw CapacitorSQLiteError.failed(message: msg)
                                            }`;

if (content.includes(originalInner)) {
    content = content.replace(originalInner, patchedInner);
    applied++;
}

// ── Patch 3: Improve nil error message ──
const originalNilErr = `let msg: String = "Error in reading buffer"
                                            throw CapacitorSQLiteError.failed(message: msg)
                                        }
                                    }
                                    val.append(valuesArr)`;

const patchedNilErr = `let msg = "Error in reading buffer: nil for key '\\(key)'"
                                            throw CapacitorSQLiteError.failed(message: msg)
                                        }
                                    }
                                    val.append(valuesArr)`;

if (content.includes(originalNilErr)) {
    content = content.replace(originalNilErr, patchedNilErr);
    applied++;
}

// ── Patch 4: Improve "Not a SQL type" error ──
if (content.includes('"Not a SQL type"') && !content.includes('type(of: value)')) {
    content = content.replace(
        'let msg: String = "Not a SQL type"',
        'let msg = "Not a SQL type: \\(type(of: value))"'
    );
    applied++;
}

if (applied > 0) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ Patched CapacitorSQLite.swift (v2): ${applied} changes for comprehensive buffer handling.`);
} else {
    console.log('CapacitorSQLite.swift: no patches needed or format has changed.');
}
