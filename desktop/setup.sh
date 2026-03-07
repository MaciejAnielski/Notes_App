#!/bin/bash
# Setup script for the desktop Electron app
# Creates a symlink to the shared web/ source so Electron can load it

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Create symlink to web/ directory
if [ ! -e "$SCRIPT_DIR/web" ]; then
  ln -s "$SCRIPT_DIR/../web" "$SCRIPT_DIR/web"
  echo "Created symlink: desktop/web -> ../web"
else
  echo "Symlink desktop/web already exists"
fi

# Install npm dependencies
cd "$SCRIPT_DIR"
npm install
echo ""
echo "Setup complete! Run 'npm start' to launch the desktop app."
