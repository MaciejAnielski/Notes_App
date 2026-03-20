#!/bin/bash
# Setup script for the iOS Capacitor app.
# Builds the PowerSync Capacitor bundle, copies web files into www/,
# and initializes the Capacitor iOS project.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Remove previous ios app folder.
rm -rf ios

# Install npm dependencies (also links the local capacitor-calendar plugin).
npm install

# Fix any npm issues
npm audit fix

# Build web files + PowerSync Capacitor bundle into www/
# (runs esbuild, copies web/, overlays www-override/ with native SQLite bundle)
npm run build

# Add the iOS platform (generates the ios/ native project inside this directory).
# Use CocoaPods instead of SPM because @powersync/capacitor and
# @capacitor-community/sqlite do not ship Package.swift files yet.
npx cap add ios --packagemanager CocoaPods

# ── Disable User Script Sandboxing (Xcode 15+ default breaks CocoaPods) ──
# CocoaPods embed/copy-frameworks scripts need file-read access that the
# sandbox denies. Set ENABLE_USER_SCRIPT_SANDBOXING = NO for all configs.
PBXPROJ="$SCRIPT_DIR/ios/App/App.xcodeproj/project.pbxproj"
if [ -f "$PBXPROJ" ]; then
  if grep -q "ENABLE_USER_SCRIPT_SANDBOXING" "$PBXPROJ"; then
    sed -i '' 's/ENABLE_USER_SCRIPT_SANDBOXING = YES/ENABLE_USER_SCRIPT_SANDBOXING = NO/g' "$PBXPROJ"
  else
    # Insert the setting into every buildSettings block
    sed -i '' '/buildSettings = {/a\
				ENABLE_USER_SCRIPT_SANDBOXING = NO;
' "$PBXPROJ"
  fi
  echo "Xcode project updated: User Script Sandboxing disabled for CocoaPods"
fi

# Sync web files and native plugins (runs pod install).
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

  # Add calendar permission keys if not present
  if ! grep -q "NSCalendarsUsageDescription" "$INFO_PLIST"; then
    sed -i '' 's|</dict>|<key>NSCalendarsUsageDescription</key>\
	<string>Notes App uses your calendar to sync events with your daily notes.</string>\
	<key>NSCalendarsFullAccessUsageDescription</key>\
	<string>Notes App needs full calendar access to create, read, and update events for bidirectional sync with your daily notes.</string>\
</dict>|' "$INFO_PLIST"
    echo "Info.plist updated: Calendar permission descriptions added"
  else
    echo "Info.plist already has calendar permission keys."
  fi

  # Add notification permission key if not present
  if ! grep -q "NSUserNotificationsUsageDescription" "$INFO_PLIST"; then
    sed -i '' 's|</dict>|<key>NSUserNotificationsUsageDescription</key>\
	<string>Notes App sends reminders for your scheduled tasks and events.</string>\
</dict>|' "$INFO_PLIST"
    echo "Info.plist updated: Notification permission description added"
  else
    echo "Info.plist already has notification permission key."
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
echo "  6. Calendar access is configured automatically via Info.plist"
echo ""
echo "In Apple Developer Portal (developer.apple.com):"
echo "  1. Go to Certificates, Identifiers & Profiles"
echo "  2. Under Identifiers > iCloud Containers, register:"
echo "     iCloud.com.notesapp.ios"
echo "  3. Under Identifiers > App IDs, edit com.notesapp.ios:"
echo "     Enable iCloud and assign the container above"
