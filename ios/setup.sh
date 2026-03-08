#!/bin/bash
# Setup script for the iOS Capacitor app.
# Copies web files into www/ and initializes the Capacitor iOS project.
#
# Native iCloud plugin (CapacitorICloud / capacitor-icloud):
#   The local plugin at plugins/capacitor-icloud is listed in package.json as
#   "capacitor-icloud": "file:plugins/capacitor-icloud".  After `npm install`
#   it appears in node_modules/ and Capacitor CLI automatically discovers it
#   (via the "capacitor" field in its package.json) and adds it to the iOS
#   Podfile as a local CocoaPods pod when you run `cap add ios` / `cap sync`.
#   No manual Xcode project editing is required.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Install npm dependencies (also links the local capacitor-icloud plugin).
npm install

# Copy web files to www/
mkdir -p www
cp -r ../web/* www/
# icloud-bridge.js lives in ios/ (not web/) so it must be copied separately.
# It provides window.CapacitorNoteStorage and is loaded by index.html on all
# platforms but is a no-op outside of a native iOS Capacitor environment.
cp icloud-bridge.js www/

# Add the iOS platform (generates the ios/ native project inside this directory).
# Capacitor CLI discovers capacitor-icloud in node_modules and adds
# CapacitorICloud to the Podfile automatically during this step.
npx cap add ios

# Sync web files and run `pod install` to pull in CapacitorICloud.
npx cap sync ios

echo ""
echo "Setup complete!"
echo "Run 'npm run open' to open the project in Xcode."
echo "Or run 'npm start' to build, sync, and open in one step."
