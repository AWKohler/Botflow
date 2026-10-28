#!/bin/zsh
# One-time setup of the live canary on an always-on Mac, as the user that is
# logged in at the console (the login keychain must be unlocked for runs).
#
#   ./install.sh /path/to/node22/bin/node
#
# Creates ~/botflow-canary/{repo,state}, a sparse checkout of scripts/canary
# from the public repo, and two LaunchAgents in the GUI session:
#   io.botflow.canary.daily   every day 06:00 local
#   io.botflow.canary.weekly  Sundays   07:30 local
# Re-running is safe (idempotent). Uninstall: ./install.sh --uninstall
set -eu
ROOT="${CANARY_HOME:-$HOME/botflow-canary}"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
LABELS=(io.botflow.canary.daily io.botflow.canary.weekly)

if [ "${1:-}" = "--uninstall" ]; then
  for l in $LABELS; do
    launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
    rm -f "$AGENTS/$l.plist"
  done
  echo "LaunchAgents removed. State and checkout kept in $ROOT."
  exit 0
fi

NODE="${1:?usage: install.sh /path/to/node (>= 22.12)}"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<12)) process.exit(1)' \
  || { echo "node >= 22.12 required"; exit 1; }

mkdir -p "$ROOT/state/logs" "$AGENTS"
chmod 700 "$ROOT/state"
echo "$NODE" > "$ROOT/node-path"

if [ ! -d "$ROOT/repo/.git" ]; then
  git clone -q --depth 1 --filter=blob:none --sparse https://github.com/AWKohler/Botflow.git "$ROOT/repo"
  git -C "$ROOT/repo" sparse-checkout set scripts/canary
fi
git -C "$ROOT/repo" pull -q --ff-only origin main

write_agent() { # label suite calendar-xml
  cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>$ROOT/repo/scripts/canary/run.sh</string><string>$2</string>
  </array>
  <key>StartCalendarInterval</key>$3
  <key>StandardOutPath</key><string>$ROOT/state/logs/$2.log</string>
  <key>StandardErrorPath</key><string>$ROOT/state/logs/$2.log</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
EOF
  launchctl bootout "gui/$UID_NUM/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$1.plist"
}

write_agent io.botflow.canary.daily daily '<dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>'
write_agent io.botflow.canary.weekly weekly '<dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>'

echo "Installed. Run now with: launchctl kickstart gui/$UID_NUM/io.botflow.canary.daily"
echo "Results: $ROOT/state/last-daily.json  Logs: $ROOT/state/logs/"
