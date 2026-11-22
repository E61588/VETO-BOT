#!/bin/bash
# Starts the VETO bot on this Mac. Double-click to run; close the window to stop.
# First run installs what it needs inside this folder only (Node, Chromium).
cd "$(dirname "$0")/.." || exit 1
export PATH="$PWD/runtime/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"

pause_exit() { echo; read -r -p "לחץ Enter לסגירה" _; exit "${1:-1}"; }

if [ ! -f .env ]; then
  echo "חסר קובץ .env בתיקייה $(pwd)"; pause_exit 1
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "מתקין Node.js 22 בתוך התיקייה (פעם אחת)..."
  arch=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
  tmp=$(mktemp -d)
  curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || { echo "ההורדה נכשלה. בדוק חיבור לאינטרנט."; pause_exit 1; }
  file=$(awk '{print $2}' "$tmp/SHASUMS256.txt" | grep -E "^node-v[0-9.]+-darwin-$arch\.tar\.gz$" | head -1)
  [ -n "$file" ] || { echo "לא נמצאה גרסת Node למק."; pause_exit 1; }
  curl -fsSL "$NODE_DIST/$file" -o "$tmp/$file" || { echo "ההורדה נכשלה."; pause_exit 1; }
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | shasum -a 256 -c -) >/dev/null || { echo "בדיקת תקינות ההורדה נכשלה."; pause_exit 1; }
  mkdir -p runtime && rm -rf runtime/node && tar -xzf "$tmp/$file" -C runtime && mv "runtime/${file%.tar.gz}" runtime/node
  rm -rf "$tmp"
fi

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "מתקין רכיבים (פעם אחת)..."
  npm ci --omit=dev --no-audit --no-fund || pause_exit 1
  touch node_modules
fi

if [ ! -f runtime/.chromium-ok ]; then
  echo "מתקין דפדפן Chromium עבור הבוט (פעם אחת, כמה דקות)..."
  PLAYWRIGHT_BROWSERS_PATH="$PWD/runtime/browsers" npx playwright install chromium || pause_exit 1
  touch runtime/.chromium-ok
fi
export PLAYWRIGHT_BROWSERS_PATH="$PWD/runtime/browsers"

echo
# caffeinate keeps the Mac awake while the bot runs (closing the lid still sleeps it).
caffeinate -i node worker.js
pause_exit 0
