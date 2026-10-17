#!/usr/bin/env bash
# Builds dist/chrome, dist/firefox and the matching zips.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$ROOT/src
DIST=$ROOT/dist
PUBLIC=$ROOT/public
ICON=$ROOT/assets/icon.svg
SIZES=(16 32 48 128)

for cmd in jq zip rsvg-convert; do
  command -v "$cmd" >/dev/null || { echo "missing dependency: $cmd" >&2; exit 1; }
done

# Render each icon size once, straight from the vector source
ICONS=$(mktemp -d)
trap 'rm -rf "$ICONS"' EXIT
for s in "${SIZES[@]}"; do
  rsvg-convert -w "$s" -h "$s" "$ICON" -o "$ICONS/icon-$s.png"
done

cp "$ICONS"/icon-*.png "$PUBLIC/icons/"

rm -rf "$DIST"
mkdir -p "$DIST"

for target in chrome firefox; do
  vpr "build:$target"
  out=$DIST/$target
  (cd "$out" && zip -qrX "$DIST/web-archiver-$target.zip" .)
  echo "built $target"
done
