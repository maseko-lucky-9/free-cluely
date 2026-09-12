#!/usr/bin/env bash
# Sign the packaged mac app with a stable LOCAL identity.
#
# Why this exists rather than letting electron-builder sign:
#   - electron-builder signs with --timestamp, which makes a network round trip
#     to Apple's timestamp server for EVERY nested file (hundreds of locale.pak
#     files). That took over 10 minutes and is pointless for local use.
#   - TCC keys a grant to the code signing "designated requirement", which is
#     derived from the bundle id plus the signing certificate. Keeping BOTH
#     stable is what makes a Screen Recording grant survive a rebuild. Ad-hoc
#     signing (-) changes identity every time and orphans the grant.
#
# This is NOT suitable for distribution: no timestamp, no notarization.
set -euo pipefail

APP="${1:-release/mac-arm64/Meeting Notes Coder.app}"
IDENTITY="${SIGN_IDENTITY:-Wavemark Local Signing}"
ENT="assets/entitlements.mac.plist"
ENT_INHERIT="assets/entitlements.mac.inherit.plist"

[ -d "$APP" ] || { echo "error: app bundle not found: $APP" >&2; exit 1; }
[ -f "$ENT" ] || { echo "error: missing $ENT" >&2; exit 1; }

if ! security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  echo "error: signing identity not found in keychain: $IDENTITY" >&2
  echo "       create a self-signed code signing certificate with that name," >&2
  echo "       or set SIGN_IDENTITY to one from: security find-identity -v -p codesigning" >&2
  exit 1
fi

echo "==> signing helpers (inherit entitlements)"
# Inside-out: helpers and frameworks before the outer bundle. --deep is avoided
# because it applies the wrong entitlements to nested bundles.
find "$APP/Contents/Frameworks" -name "*.app" -maxdepth 1 -print0 2>/dev/null |
  while IFS= read -r -d '' helper; do
    codesign --force --sign "$IDENTITY" --options runtime \
      --entitlements "$ENT_INHERIT" "$helper"
    echo "    signed: $(basename "$helper")"
  done

echo "==> signing frameworks"
find "$APP/Contents/Frameworks" -name "*.framework" -maxdepth 1 -print0 2>/dev/null |
  while IFS= read -r -d '' fw; do
    codesign --force --sign "$IDENTITY" "$fw"
    echo "    signed: $(basename "$fw")"
  done

echo "==> signing app bundle"
codesign --force --sign "$IDENTITY" --options runtime --entitlements "$ENT" "$APP"

echo "==> verifying"
codesign --verify --deep --strict "$APP"
codesign -dv "$APP" 2>&1 | grep -E "^Identifier=|^Authority=" || true

echo
echo "Signed OK. Launch it so macOS attributes screen capture to the APP:"
echo "    open -a \"$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")\""
echo
echo "Launching from a terminal (npm run app:dev, or running the binary directly)"
echo "makes macOS attribute capture to the terminal instead, and this app's own"
echo "Screen Recording entry will not apply."
