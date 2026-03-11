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

# Remove previous ios app folder.

rm -rf ios

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

# ── Info.plist: make iCloud container visible in Files app ──
# UIFileSharingEnabled and LSSupportsOpeningDocumentsInPlace cause the app's
# iCloud container to appear in the iOS Files app under "Notes App" and in
# Finder on macOS under iCloud Drive.
INFO_PLIST="$SCRIPT_DIR/ios/App/App/Info.plist"
if [ -f "$INFO_PLIST" ]; then
  if ! grep -q "UIFileSharingEnabled" "$INFO_PLIST"; then
    # Insert keys before the closing </dict>
    sed -i '' 's|</dict>|<key>UIFileSharingEnabled</key>\
	<true/>\
	<key>LSSupportsOpeningDocumentsInPlace</key>\
	<true/>\
	<key>NSUbiquitousContainers</key>\
	<dict>\
		<key>iCloud.com.notesapp.ios</key>\
		<dict>\
			<key>NSUbiquitousContainerIsDocumentScopePublic</key>\
			<true/>\
			<key>NSUbiquitousContainerSupportedFolderLevels</key>\
			<string>Any</string>\
			<key>NSUbiquitousContainerName</key>\
			<string>Notes App</string>\
		</dict>\
	</dict>\
</dict>|' "$INFO_PLIST"
    echo "Info.plist updated: iCloud container visible in Files app"
  else
    echo "Info.plist already has file sharing keys."
  fi
else
  echo "WARNING: Info.plist not found. Add these keys manually in Xcode:"
  echo "  UIFileSharingEnabled = YES"
  echo "  LSSupportsOpeningDocumentsInPlace = YES"
  echo "  NSUbiquitousContainers with iCloud.com.notesapp.ios"
fi

echo ""
echo "Setup complete!"
echo ""
echo "Run 'npm run open' to open the project in Xcode."
echo "Or run 'npm start' to build, sync, and open in one step."
echo ""
echo "IMPORTANT: Before building, complete these steps in Xcode:"
echo "  1. Select the 'App' target > Signing & Capabilities"
echo "  2. Set your Team (Apple Developer account)"
echo "  3. If iCloud capability is not visible, click '+ Capability' > iCloud"
echo "  4. Under iCloud, ensure 'iCloud Documents' is checked"
echo "  5. Ensure container 'iCloud.com.notesapp.ios' is selected"
echo ""
echo "In Apple Developer Portal (developer.apple.com):"
echo "  1. Go to Certificates, Identifiers & Profiles"
echo "  2. Under Identifiers > iCloud Containers, register:"
echo "     iCloud.com.notesapp.ios"
echo "  3. Under Identifiers > App IDs, edit com.notesapp.ios:"
echo "     Enable iCloud and assign the container above"
