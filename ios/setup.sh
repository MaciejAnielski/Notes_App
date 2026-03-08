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
# icloud-bridge.js lives in ios/ (not web/) so it must be copied separately.
# It provides window.CapacitorNoteStorage and is loaded by index.html on all
# platforms but is a no-op outside of a native iOS Capacitor environment.
cp icloud-bridge.js www/

# Add the iOS platform (generates the ios/ native project inside this directory)
npx cap add ios

# Sync web files to the native project
npx cap sync ios

echo ""
echo "Setup complete!"
echo "Run 'npm run open' to open the project in Xcode."
echo "Or run 'npm start' to build, sync, and open in one step."
