#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/macos/build"
APP="$OUT/Cicada.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
# Only tracked web sources are bundled: no certificates, logs or user media.
while IFS= read -r path; do
  cp "$ROOT/$path" "$APP/Contents/Resources/$path"
done < <(git -C "$ROOT" ls-files web/)
# New uncommitted source modules are explicit, never copy whole working directories.
cp "$ROOT/web/tower-synth.js" "$APP/Contents/Resources/web/tower-synth.js"
cp "$ROOT/macos/Info.plist" "$APP/Contents/Info.plist"
for ARCH in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -O -whole-module-optimization \
    -target "$ARCH-apple-macos13.0" -module-name Cicada \
    -debug-prefix-map "$ROOT"=. \
    -framework Cocoa -framework WebKit -framework AVFoundation -framework Network \
    "$ROOT/macos/AssetServer.swift" "$ROOT/macos/main.swift" -o "$OUT/Cicada-$ARCH"
done
xcrun lipo -create "$OUT/Cicada-arm64" "$OUT/Cicada-x86_64" -output "$APP/Contents/MacOS/Cicada"
codesign --force --sign - --options runtime --entitlements "$ROOT/macos/Cicada.entitlements" "$APP"
codesign --verify --strict "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/Cicada-0.2-mac.zip"
printf 'Built %s\n' "$APP"
