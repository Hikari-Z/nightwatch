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
# Linux (WSLg included): the binary to ~/.local/bin/nightwatch, its icon to
# ~/.local/share/icons, and a launcher entry. Building here means the app
# finds this checkout's viewer and machinery by the path it was built with
# (nightwatch#2). It needs Rust, node and WebKitGTK's development files, and
# the tray's appindicator library at run time; the check below names the
# packages if any are missing rather than failing halfway through the build.
# The first launch is logged, and a copy that dies at once is reported.
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
  if ! command -v pkg-config >/dev/null 2>&1; then
    missing="$missing pkg-config"
  else
    pkg-config --exists webkit2gtk-4.1 || missing="$missing webkit2gtk-4.1"
    pkg-config --exists ayatana-appindicator3-0.1 || missing="$missing ayatana-appindicator3"
  fi
  if [ -n "$missing" ]; then
    echo "Nightwatch can't build yet; missing:$missing"
    echo "On Debian or Ubuntu (WSL2 too), the system packages are:"
    echo "  sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential pkg-config"
    exit 1
  fi
  # Install the CLI when node_modules is missing or older than the lockfile.
  [ node_modules -nt package-lock.json ] || npm ci
  # The binary alone: a .deb isn't needed for a build made here. Linux's
  # config names it nightwatch; take whichever name the build left.
  npx tauri build --no-bundle
  BUILT=src-tauri/target/release/nightwatch
  [ -f "$BUILT" ] || BUILT=src-tauri/target/release/app
  BIN="$HOME/.local/bin/nightwatch"
  # Quit the running copy and wait for it, so two trays don't overlap.
  pkill -x nightwatch 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x nightwatch >/dev/null 2>&1 || break; sleep 0.5; done
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/128x128/apps" "$HOME/.local/state/nightwatch"
  install -m 0755 "$BUILT" "$BIN"
  install -m 0644 src-tauri/icons/128x128.png "$HOME/.local/share/icons/hicolor/128x128/apps/nightwatch.png"
  cat > "$HOME/.local/share/applications/nightwatch.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Nightwatch
Comment=Watch over your agents' nights
Exec="$BIN"
Icon=nightwatch
Terminal=false
Categories=Utility;
EOF
  LOG="$HOME/.local/state/nightwatch/launch.log"
  nohup "$BIN" >"$LOG" 2>&1 &
  sleep 3
  if pgrep -x nightwatch >/dev/null 2>&1; then
    echo "installed: $BIN (and Nightwatch in the app launcher)"
  else
    echo "installed $BIN, but it exited at once. Its output ($LOG):"
    tail -20 "$LOG"
    exit 1
  fi
  ;;
*)
  echo "install.sh knows macOS and Linux. On $(uname -s), run the browser viewer instead: node \"$(cd .. && pwd)/gui/server.mjs\""
  exit 1
  ;;
esac
