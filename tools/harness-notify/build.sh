#!/usr/bin/env bash
# Build HarnessNotify.app (native notifications with buttons for the harness), install it in
# ~/Applications and start it at login. Needs the Xcode command line tools (xcode-select --install).
#   tools/harness-notify/build.sh            build + install + start
#   tools/harness-notify/build.sh --uninstall
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/HarnessNotify.app"
LABEL="no.harness.notify"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; rm -rf "$APP"; echo "removed"; exit 0
fi
command -v swiftc >/dev/null || { echo "swiftc not found - run: xcode-select --install" >&2; exit 1; }
BUILD="$(mktemp -d)"
mkdir -p "$BUILD/HarnessNotify.app/Contents/MacOS"
swiftc -O -o "$BUILD/HarnessNotify.app/Contents/MacOS/HarnessNotify" "$HERE/HarnessNotify.swift"
cat > "$BUILD/HarnessNotify.app/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleName</key><string>HarnessNotify</string>
  <key>CFBundleDisplayName</key><string>Harness</string>
  <key>CFBundleExecutable</key><string>HarnessNotify</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
P
codesign --force --deep -s - "$BUILD/HarnessNotify.app"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
mkdir -p "$HOME/Applications"; rm -rf "$APP"; mv "$BUILD/HarnessNotify.app" "$APP"
mkdir -p "$(dirname "$PLIST")" "$HOME/.harness/notify"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/HarnessNotify</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.harness/notify/app.log</string>
</dict></plist>
P
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $APP and started it (runs at login)."
echo "Next: allow notifications when macOS asks, then System Settings > Notifications > Harness:"
echo "      set the style to 'Alerts' so the buttons stay until you choose one."
echo "Test: node scripts/notify.mjs test"
