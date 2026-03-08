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

# ── iCloud entitlements ──
# After Capacitor generates the native project, inject the iCloud Documents
# entitlement so the app can access its iCloud container.
ENTITLEMENTS_FILE="$SCRIPT_DIR/App/App/App.entitlements"
if [ -f "$ENTITLEMENTS_FILE" ]; then
  # Check if iCloud entitlement already exists
  if ! grep -q "com.apple.developer.icloud-container-identifiers" "$ENTITLEMENTS_FILE"; then
    # Write the entitlements file with iCloud Documents enabled
    cat > "$ENTITLEMENTS_FILE" << 'ENTITLEMENTS_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.developer.icloud-container-identifiers</key>
	<array>
		<string>iCloud.com.notesapp.ios</string>
	</array>
	<key>com.apple.developer.icloud-services</key>
	<array>
		<string>CloudDocuments</string>
	</array>
	<key>com.apple.developer.ubiquity-container-identifiers</key>
	<array>
		<string>iCloud.com.notesapp.ios</string>
	</array>
</dict>
</plist>
ENTITLEMENTS_EOF
    echo "iCloud entitlements added to App.entitlements"
  else
    echo "iCloud entitlements already configured."
  fi
else
  echo "WARNING: App.entitlements not found at $ENTITLEMENTS_FILE"
  echo "You may need to add iCloud entitlements manually in Xcode."
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
