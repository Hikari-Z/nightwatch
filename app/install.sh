#!/bin/sh
# Build Nightwatch from this checkout and install it.
#
# macOS: to ~/Applications. Three steps the plain `tauri build` doesn't do,
# each learned on 10/6:
#   - re-sign the whole bundle: Tauri's local signature leaves out the
#     resource seal, and macOS can then refuse a normal double-click launch;
#   - quit the running copy first, so the new one actually starts;
#   - re-register the path, or `open` keeps launching whatever app used to
#     live there.
#
# Linux (WSLg included): the binary to ~/.local/bin/nightwatch and a desktop
# entry to ~/.local/share/applications, so it shows in the app launcher.
# Building here means the app finds this checkout's viewer and machinery by
# the path it was built with (nightwatch#2). It needs Rust and WebKitGTK's
# development files first; the check below names the packages if they're
# missing rather than failing halfway through the build.
set -e
cd "$(dirname "$0")"

case "$(uname -s)" in
Darwin)
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
  ;;
Linux)
  missing=""
  command -v cargo >/dev/null 2>&1 || missing="$missing rust (https://rustup.rs)"
  command -v npx >/dev/null 2>&1 || missing="$missing node"
  if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists webkit2gtk-4.1; then
    missing="$missing webkit2gtk"
  fi
  if [ -n "$missing" ]; then
    echo "Nightwatch can't build yet; missing:$missing"
    echo "On Debian or Ubuntu (WSL2 too), the system packages are:"
    echo "  sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential pkg-config"
    exit 1
  fi
  [ -d node_modules ] || npm ci
  # The binary alone: a .deb or AppImage isn't needed for a build made here.
  npx tauri build --no-bundle
  BIN="$HOME/.local/bin/nightwatch"
  pkill -x nightwatch 2>/dev/null || true
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
  install -m 0755 src-tauri/target/release/app "$BIN"
  ICON="$(cd src-tauri/icons && pwd)/128x128.png"
  cat > "$HOME/.local/share/applications/nightwatch.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Nightwatch
Comment=Watch over your agents' nights
Exec=$BIN
Icon=$ICON
Terminal=false
Categories=Utility;
EOF
  nohup "$BIN" >/dev/null 2>&1 &
  echo "installed: $BIN (and Nightwatch in the app launcher)"
  ;;
*)
  echo "install.sh knows macOS and Linux; on $(uname -s), run the browser viewer: node gui/server.mjs"
  exit 1
  ;;
esac
