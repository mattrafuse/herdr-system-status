#!/usr/bin/env bash
# Watches mods/herdr-system-status in this repo and syncs it to the running
# Herdr app whenever a file changes. The app hot-reloads a mod on save, so a
# repo edit reaches the window in under a second — no manual cp -r.
#
# Start it detached from the repo root:
#   setsid nohup ./watch-mod.sh >> /tmp/herdr-mod-sync.log 2>&1 &
#
# Generated files (gpui-kit.d.ts, jsconfig.json) are excluded: the app writes
# its own into the installed copy and ignores them on reload anyway.
set -eu

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/mods/herdr-system-status"
DST="$HOME/.config/herdr-app/mods/herdr-system-status"

sync_mod() {
  mkdir -p "$DST"
  rsync -a --delete \
    --exclude gpui-kit.d.ts --exclude jsconfig.json \
    "$SRC/" "$DST/"
}

# A fingerprint of just the files that get synced, so regenerating
# gpui-kit.d.ts or jsconfig.json doesn't count as a change.
fingerprint() {
  tar -C "$SRC" --exclude=gpui-kit.d.ts --exclude=jsconfig.json -cf - . | md5sum
}

prev="$(fingerprint)"
sync_mod
echo "watching $SRC -> $DST"
while :; do
  sleep 0.7
  cur="$(fingerprint)" || continue
  if [ "$cur" != "$prev" ]; then
    prev="$cur"
    sync_mod
    echo "$(date +%T) synced"
  fi
done
