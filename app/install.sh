#!/bin/sh
# Build Nightwatch and install it to ~/Applications. Three steps the plain
# `tauri build` doesn't do, each learned on 10/6:
#   - re-sign the whole bundle: Tauri's local signature leaves out the
#     resource seal, and macOS can then refuse a normal double-click launch;
#   - quit the running copy first, so the new one actually starts;
#   - re-register the path, or `open` keeps launching whatever app used to
#     live there.
set -e
cd "$(dirname "$0")"
npx tauri build
APP="$HOME/Applications/Nightwatch.app"
pkill -f "Nightwatch.app/Contents/MacOS/app$" || true
rm -rf "$APP"
ditto src-tauri/target/release/bundle/macos/Nightwatch.app "$APP"
codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
open "$APP"
echo "installed: $APP"
