#!/usr/bin/env bash
# Builds dist/chrome, dist/firefox and the matching zips.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$ROOT/src
DIST=$ROOT/dist
ICON=$ROOT/assets/icon.svg
SIZES=(16 32 48 128)

for cmd in jq zip rsvg-convert; do
  command -v "$cmd" >/dev/null || { echo "missing dependency: $cmd" >&2; exit 1; }
done

# Render each icon size once, straight from the vector source
ICONS=$(mktemp -d)
trap 'rm -rf "$ICONS"' EXIT
for s in "${SIZES[@]}"; do
  rsvg-convert -w "$s" -h "$s" "$ICON" -o "$ICONS/icon$s.png"
done

rm -rf "$DIST"
mkdir -p "$DIST"

for target in chrome firefox; do
  out=$DIST/$target
  cp -r "$SRC" "$out"
  jq . "$ROOT/manifests/$target.json" > "$out/manifest.json"   # validates + pretty-prints
  mkdir -p "$out/icons"
  cp "$ICONS"/icon*.png "$out/icons/"
  (cd "$out" && zip -qrX "$DIST/url-archiver-$target.zip" .)
  echo "built $target"
done
