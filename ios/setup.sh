#!/bin/bash
# Setup script for the iOS Capacitor app
# Copies web files into www/ and initializes the Capacitor iOS project

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Install npm dependencies
npm install

# Copy web files to www/
mkdir -p www
cp -r ../web/* www/
cp icloud-bridge.js www/

# Add the iOS platform (generates the ios/ native project inside this directory)
npx cap add ios

# Sync web files to the native project
npx cap sync ios

echo ""
echo "Setup complete!"
echo ""
echo "IMPORTANT: Before building, configure iCloud in Xcode:"
echo "  1. Open the project: npm run open"
echo "  2. Select the App target → Signing & Capabilities"
echo "  3. Click '+ Capability' → iCloud"
echo "  4. Check 'iCloud Documents'"
echo "  5. Add container: iCloud.com.notesapp.ios"
echo "  6. Add the native plugin files to the Xcode project:"
echo "     - Drag plugins/ICloudStoragePlugin.swift into ios/App/App/"
echo "     - Drag plugins/ICloudStoragePlugin.m into ios/App/App/"
echo ""
echo "Run 'npm run open' to open the project in Xcode."
echo "Or run 'npm start' to build, sync, and open in one step."
