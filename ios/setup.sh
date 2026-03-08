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

# Add the iOS platform (generates the ios/ native project inside this directory)
npx cap add ios

# Sync web files to the native project
npx cap sync ios

echo ""
echo "Setup complete!"
echo "Run 'npm run open' to open the project in Xcode."
echo "Or run 'npm start' to build, sync, and open in one step."
