#!/bin/bash
# Build the iPhone home-screen icons from one source image.
#
#   ./scripts/make-icons.sh assets/icon-source.svg      # default artwork
#   ./scripts/make-icons.sh ~/Desktop/her-drawing.png   # her drawing (png/jpg/heic/svg)
#   ./scripts/make-icons.sh drawing.png --pad           # pad to square instead of center-cropping
#   ./scripts/make-icons.sh photo.heic --zoom 90        # keep the middle 90%, trims paper margin
#
# Writes public/icons/icon-{180,192,512}.png
# Uses sips, which ships with macOS. No installs needed.
set -euo pipefail

SRC="assets/icon-source.svg"
PAD=""
ZOOM=100             # percent of the square to keep, centered
OUT_DIR="public/icons"
PAD_COLOR="FDF6FF"   # app background, so padding blends in

while [ $# -gt 0 ]; do
  case "$1" in
    --pad)  PAD="--pad"; shift ;;
    --zoom) ZOOM="$2"; shift 2 ;;
    *)      SRC="$1"; shift ;;
  esac
done

[ -f "$SRC" ] || { echo "No such file: $SRC" >&2; exit 1; }
mkdir -p "$OUT_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. normalize to a big PNG
sips -s format png "$SRC" --out "$TMP/big.png" >/dev/null

W=$(sips -g pixelWidth  "$TMP/big.png" | awk '/pixelWidth/  {print $2}')
H=$(sips -g pixelHeight "$TMP/big.png" | awk '/pixelHeight/ {print $2}')

# 2. make it square: center-crop to the short side, or pad out to the long side
if [ "$PAD" = "--pad" ]; then
  SIDE=$(( W > H ? W : H ))
  sips -p "$SIDE" "$SIDE" --padColor "$PAD_COLOR" "$TMP/big.png" --out "$TMP/square.png" >/dev/null 2>&1
else
  SIDE=$(( W < H ? W : H ))
  sips -c "$SIDE" "$SIDE" "$TMP/big.png" --out "$TMP/square.png" >/dev/null
fi

# 3. optional zoom: crop in on the centre so paper margin doesn't eat the tile
if [ "$ZOOM" != "100" ]; then
  SIDE=$(( SIDE * ZOOM / 100 ))
  sips -c "$SIDE" "$SIDE" "$TMP/square.png" --out "$TMP/square.png" >/dev/null
fi

# 4. iOS composites transparent icons on black, so flatten alpha onto the pad color
if [ "$(sips -g hasAlpha "$TMP/square.png" | awk '/hasAlpha/ {print $2}')" = "yes" ]; then
  sips -p "$SIDE" "$SIDE" --padColor "$PAD_COLOR" -s format jpeg -s formatOptions best \
    "$TMP/square.png" --out "$TMP/flat.jpeg" >/dev/null 2>&1
  sips -s format png "$TMP/flat.jpeg" --out "$TMP/square.png" >/dev/null
fi

# 5. emit the sizes iOS and the web manifest ask for
for SIZE in 180 192 512; do
  sips -z "$SIZE" "$SIZE" "$TMP/square.png" --out "$OUT_DIR/icon-$SIZE.png" >/dev/null
  echo "wrote $OUT_DIR/icon-$SIZE.png"
done
