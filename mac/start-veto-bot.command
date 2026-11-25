#!/bin/bash
# Starts the VETO bot on this Mac. Double-click to run; close the window to stop.
# First run installs what it needs inside this folder only (Node, Chromium).
cd "$(dirname "$0")" || exit 1; [ -f package.json ] || cd ..
export PATH="$PWD/runtime/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"

pause_exit() { echo; read -r -p "לחץ Enter לסגירה" _; exit "${1:-1}"; }

if [ ! -f .env ]; then
  echo "הגדרה ראשונה: הדבק כאן את מפתח הבוט (BOT_API_KEY, 40 תווים) ולחץ Enter."
  echo "המפתח לא יוצג על המסך ונשמר רק במחשב הזה."
  for attempt in 1 2 3; do
    read -r -s key; echo
    # Keep only key characters: copying from a chat can add invisible
    # direction marks, spaces or quotes around the key.
    key=$(printf '%s' "$key" | LC_ALL=C tr -cd 'A-Za-z0-9_-')
    if [ ${#key} -eq 40 ]; then break; fi
    echo "המפתח לא תקין (התקבלו ${#key} תווים מתוך 40). הדבק שוב ולחץ Enter:"
    key=""
  done
  [ -n "$key" ] || pause_exit 1
  ( umask 077; printf 'BRIDGE_URL=https://veto-app.base44.app/functions/botBridge\nBOT_V2_API_KEY=%s\nWORKER_NAME=%s\nALLOW_LIVE_SUBMIT=false\n' "$key" "$(scutil --get ComputerName 2>/dev/null | tr -cd '[:alnum:]-' | cut -c1-40 || echo mac)" > .env )
  unset key
  echo "נשמר."
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

if [ -d "/Applications/Google Chrome.app" ]; then
  # Use the Chrome already installed on this Mac: no browser download needed.
  export BROWSER_CHANNEL=chrome
elif [ ! -f runtime/.chromium-ok ]; then
  echo "מתקין דפדפן Chromium עבור הבוט (פעם אחת, כמה דקות)..."
  PLAYWRIGHT_BROWSERS_PATH="$PWD/runtime/browsers" npx playwright install chromium || pause_exit 1
  touch runtime/.chromium-ok
fi
export PLAYWRIGHT_BROWSERS_PATH="$PWD/runtime/browsers"

# The team computer: the bot's Chrome window is visible and comes to the front
# when "I'm not a robot" needs ticking. BOT_HEADFUL=0 in .env turns it off.
grep -q '^BOT_HEADFUL=' .env || echo 'BOT_HEADFUL=1' >> .env

echo
# caffeinate keeps the Mac awake while the bot runs (closing the lid still sleeps it).
caffeinate -i node worker.js
pause_exit 0
