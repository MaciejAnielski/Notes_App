#!/usr/bin/env node
// Patches @capacitor-community/sqlite BiometricIDAuthentication.swift to add
// the .opticID case introduced in iOS 17 (Vision Pro). Without this, Xcode 15+
// reports "Switch must be exhaustive" because @unknown default alone doesn't
// satisfy the compiler when a known case is missing.

const fs = require('fs');
const path = require('path');

const filePath = path.join(
    __dirname, '..', 'node_modules', '@capacitor-community', 'sqlite',
    'ios', 'Plugin', 'BiometricIDAuthentication.swift'
);

if (!fs.existsSync(filePath)) {
    console.log('BiometricIDAuthentication.swift not found, skipping patch.');
    process.exit(0);
}

let content = fs.readFileSync(filePath, 'utf8');

// Check if already patched
if (content.includes('opticID')) {
    console.log('BiometricIDAuthentication.swift already patched, skipping.');
    process.exit(0);
}

const oldSwitch = `        switch context.biometryType {
        case .none:
            return .none
        case .touchID:
            return .touchID
        case .faceID:
            return .faceID
        @unknown default:`;

const newSwitch = `        switch context.biometryType {
        case .none:
            return .none
        case .touchID:
            return .touchID
        case .faceID:
            return .faceID
        case .opticID:
            return .none
        @unknown default:`;

if (content.includes(oldSwitch)) {
    content = content.replace(oldSwitch, newSwitch);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('✓ Patched BiometricIDAuthentication.swift: added .opticID case.');
} else {
    console.log('BiometricIDAuthentication.swift format changed, manual patch may be needed.');
}
