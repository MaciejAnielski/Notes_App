#!/usr/bin/env node
// Patches @capacitor-community/sqlite CapacitorSQLite.swift to fix
// "Error in reading buffer" on iOS.
//
// Root cause: The `run()` method's parameter parser converts JS values to
// Swift types for SQLite bind parameters.  When a value arrives as a
// dictionary (JS object → [String: Any]), the code tries to read each
// inner value as Swift `Int`.  However the Capacitor bridge often
// deserializes JSON numbers as `Double`, which fails the `as? Int` cast
// and throws "Error in reading buffer".
//
// Additionally, JavaScript booleans arrive as Swift `Bool`
// (__NSCFBoolean), which doesn't match `as? Int` either.
//
// This patch:
//   1. Adds `Bool` handling before the dictionary branch (converts to 0/1).
//   2. In the buffer branch, also accepts `Double` and `Bool` inner values
//      by converting them to Int before appending as UInt8.

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

if (content.includes('// [PATCHED] buffer-parsing')) {
    console.log('CapacitorSQLite.swift buffer-parsing already patched, skipping.');
    process.exit(0);
}

// ── Patch 1: Add Bool handling before the dictionary branch ──
// Insert `else if let obj = value as? Bool { val.append(obj ? 1 : 0) }`
// right after the NSNull check.
const oldNSNull = `                        } else if value is NSNull {
                            val.append(value)
                        } else if let obj = value as? [String: Any] {`;

const newNSNull = `                        } else if value is NSNull {
                            val.append(value)
                        } else if let obj = value as? Bool { // [PATCHED] buffer-parsing
                            val.append(obj ? 1 : 0)
                        } else if let obj = value as? [String: Any] {`;

// ── Patch 2: In the buffer branch, accept Double and Bool inner values ──
const oldBufferCast = `                                        if let mVal = obj[key] {
                                            if let iVal = mVal as? Int {
                                                valuesArr.append(UInt8(iVal))
                                            } else {
                                                let msg: String = "Error in reading buffer"
                                                throw CapacitorSQLiteError.failed(message: msg)
                                            }`;

const newBufferCast = `                                        if let mVal = obj[key] {
                                            if let iVal = mVal as? Int {
                                                valuesArr.append(UInt8(iVal))
                                            } else if let dVal = mVal as? Double { // [PATCHED] buffer-parsing
                                                valuesArr.append(UInt8(Int(dVal)))
                                            } else if let bVal = mVal as? Bool { // [PATCHED] buffer-parsing
                                                valuesArr.append(bVal ? 1 : 0)
                                            } else {
                                                let msg: String = "Error in reading buffer"
                                                throw CapacitorSQLiteError.failed(message: msg)
                                            }`;

let patched = false;

if (content.includes(oldNSNull)) {
    content = content.replace(oldNSNull, newNSNull);
    patched = true;
} else {
    console.log('  ⚠ Could not find NSNull block to patch (format may have changed).');
}

if (content.includes(oldBufferCast)) {
    content = content.replace(oldBufferCast, newBufferCast);
    patched = true;
} else {
    console.log('  ⚠ Could not find buffer cast block to patch (format may have changed).');
}

if (patched) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('✓ Patched CapacitorSQLite.swift: fixed buffer parameter parsing for iOS.');
} else {
    console.log('CapacitorSQLite.swift format changed, manual patch may be needed.');
}
