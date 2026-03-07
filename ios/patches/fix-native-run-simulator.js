#!/usr/bin/env node
// Patches native-run 2.0.3 simulator.js to handle:
// 1. Xcode 16+ runtime identifier format changes (devices lookup returns undefined)
// 2. Empty array passed to .reduce() with no initial value
// Run automatically via postinstall.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'node_modules', 'native-run', 'dist', 'ios', 'utils', 'simulator.js');

if (!fs.existsSync(filePath)) {
    console.log('native-run simulator.js not found, skipping patch.');
    process.exit(0);
}

let content = fs.readFileSync(filePath, 'utf8');

const brokenCode = `.map((runtime) => (output.devices[runtime.identifier] || output.devices[runtime.name])
            .filter((device) => device.isAvailable)
            .map((device) => ({ ...device, runtime })))
            .reduce((prev, next) => prev.concat(next)) // flatten`;

const fixedCode = `.map((runtime) => {
                const devices = output.devices[runtime.identifier] || output.devices[runtime.name] || [];
                return devices
                    .filter((device) => device.isAvailable)
                    .map((device) => ({ ...device, runtime }));
            })
            .reduce((prev, next) => prev.concat(next), []) // flatten with initial value to handle empty arrays`;

const brokenFilter = `.filter((runtime) => runtime.name.indexOf('watch') === -1 && runtime.name.indexOf('tv') === -1)`;
const fixedFilter = `.filter((runtime) => runtime.name.toLowerCase().indexOf('watch') === -1 &&
                runtime.name.toLowerCase().indexOf('tv') === -1 &&
                runtime.name.toLowerCase().indexOf('visionos') === -1)`;

if (content.includes(brokenCode)) {
    content = content.replace(brokenCode, fixedCode);
    content = content.replace(brokenFilter, fixedFilter);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('✓ Patched native-run simulator.js for Xcode 16+ compatibility.');
} else {
    console.log('native-run simulator.js already patched or format changed, skipping.');
}
