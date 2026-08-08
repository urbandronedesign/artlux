#!/usr/bin/env bash
#
# Builds the macOS Syphon receive path: Syphon.framework -> the napi crate -> syphon-receiver.node.
# macOS only. Run via `npm run build:syphon`.
#
# WHY THIS SCRIPT EXISTS AT ALL, RATHER THAN A COMMITTED PREBUILT. native/ndi/ndi.node is committed
# because the NDI SDK is licence-gated and CI cannot fetch it. Syphon is BSD-2-clause with no
# dependencies and builds in seconds, so that reason does not transfer and a binary in a public repo
# would just be a thing that rots. Everything here is gitignored.
#
# ⚠ WE PIN A COMMIT, NOT A RELEASE TAG, AND THAT IS NOT LAZINESS.
# The newest Syphon *release* is "Syphon SDK 5" from 2019, and it does NOT contain SyphonClientBase —
# the class this whole plugin is built on (see plans/syphon-plugin.md §4.3: it is what lets us reach
# the IOSurface directly and skip Metal and OpenGL entirely). SyphonClientBase and its
# SyphonSubclassing header only exist on `main`. So a tag is not an option; a moving `main` is not
# either. A SHA it is.
#
# The specific SHA below is also load-bearing: it IS the commit "Explicitly set pixel format type to
# 32BGRA" (2025-10-06). Before it, a server's IOSurface pixel format was not explicitly set, and the
# plugin's "the format is always BGRA, there is no format table" simplification would have been a
# guess rather than a fact. Do not move this pin backwards.
set -euo pipefail

SYPHON_SHA="71351d4b484cd2d1917867f7846a5cdca724552d"
SYPHON_REPO="https://github.com/Syphon/Syphon-Framework"

# Oldest macOS we claim to run on. Syphon's own project inherits Xcode's recommended target, which
# floats with the toolchain — pinning it here keeps a framework built on a new runner loadable by an
# older venue Mac instead of failing at dlopen with a version mismatch nobody reads.
DEPLOYMENT_TARGET="11.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/native/syphon-receiver"
SRC="$CRATE/.syphon-src"          # fetched sources (gitignored)
OUT="$CRATE/Syphon.framework"     # what build.rs links against (gitignored)

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-syphon] macOS only — Syphon does not exist on $(uname -s). Nothing to do." >&2
  echo "[build-syphon] On Windows the equivalent is Spout: npm run build:native" >&2
  exit 0   # NOT an error: `npm run build:syphon` on the Windows dev box should be a no-op, not a failure.
fi

command -v xcodebuild >/dev/null || { echo "[build-syphon] xcodebuild not found — install the Xcode command line tools" >&2; exit 1; }
command -v cargo      >/dev/null || { echo "[build-syphon] cargo not found — install Rust (rustup)" >&2; exit 1; }

# ── 1. Fetch the pinned source ──────────────────────────────────────────────────────────────────
# A tarball rather than a clone: no git history, no submodules, and re-running is a no-op because the
# stamp file records the SHA we already have.
STAMP="$SRC/.artlux-sha"
if [[ ! -f "$STAMP" || "$(cat "$STAMP")" != "$SYPHON_SHA" ]]; then
  echo "[build-syphon] fetching Syphon-Framework @ ${SYPHON_SHA:0:12}"
  rm -rf "$SRC"
  mkdir -p "$SRC"
  curl -fsSL "$SYPHON_REPO/archive/$SYPHON_SHA.tar.gz" | tar -xz -C "$SRC" --strip-components=1
  echo "$SYPHON_SHA" > "$STAMP"
else
  echo "[build-syphon] Syphon-Framework @ ${SYPHON_SHA:0:12} already fetched"
fi

# ── 2. Build a universal Syphon.framework ───────────────────────────────────────────────────────
# ARCHS + ONLY_ACTIVE_ARCH=NO makes it universal even though the runner is one architecture. It costs
# seconds and removes an entire class of "works on my Mac" — an arm64-only framework linked into an
# x86_64 host fails at load with a message that reads like a missing file.
#
# CODE_SIGNING_ALLOWED=NO: the framework gets ad-hoc signed later, as part of the .app, inside-out
# (scripts/mac-adhoc-sign.cjs). Signing it here would only be overwritten, and on a CI runner with no
# keychain it fails outright.
BUILD_DIR="$SRC/.artlux-build"
echo "[build-syphon] xcodebuild Syphon (universal arm64 + x86_64, deployment target $DEPLOYMENT_TARGET)"
xcodebuild \
  -project "$SRC/Syphon.xcodeproj" \
  -scheme Syphon \
  -configuration Release \
  ARCHS="arm64 x86_64" \
  ONLY_ACTIVE_ARCH=NO \
  MACOSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
  CONFIGURATION_BUILD_DIR="$BUILD_DIR" \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO \
  build

[[ -d "$BUILD_DIR/Syphon.framework" ]] || { echo "[build-syphon] xcodebuild produced no Syphon.framework" >&2; exit 1; }
rm -rf "$OUT"
cp -R "$BUILD_DIR/Syphon.framework" "$OUT"
echo "[build-syphon] $(lipo -archs "$OUT/Versions/A/Syphon" 2>/dev/null || echo '?') -> native/syphon-receiver/Syphon.framework"

# ── 3. Build the crate ──────────────────────────────────────────────────────────────────────────
cargo build --release --manifest-path "$CRATE/Cargo.toml"

# ── 4. cdylib -> .node ──────────────────────────────────────────────────────────────────────────
# Deliberately NOT scripts/copy-native.cjs. That script treats output-engine as required and exits 1
# when it is missing, so calling it here would make `npm run build:syphon` fail on a machine that has
# not built the whole engine — which is exactly the machine someone iterating on Syphon is using.
# One `cp` is cheaper than that coupling. (copy-native.cjs carries a note pointing back here.)
DYLIB="$CRATE/target/release/libartlux_syphon_receiver.dylib"
[[ -f "$DYLIB" ]] || { echo "[build-syphon] no $DYLIB — cargo build produced nothing" >&2; exit 1; }
cp "$DYLIB" "$CRATE/syphon-receiver.node"
echo "[build-syphon] -> native/syphon-receiver/syphon-receiver.node"

# ── 5. Assert the link is relocatable ───────────────────────────────────────────────────────────
# The one failure this script can produce that stays invisible until a venue Mac: an absolute path to
# the build machine's checkout baked into the load command. It works forever on this machine and
# fails at dlopen everywhere else, surfacing in JS as "[syphon] native receiver unavailable" — which
# reads exactly like "you forgot to build it". Catch it here instead.
if otool -L "$CRATE/syphon-receiver.node" | grep -q "$CRATE/Syphon.framework"; then
  echo "[build-syphon] FAIL: absolute framework path baked into the addon — the rpath args in build.rs did not apply" >&2
  otool -L "$CRATE/syphon-receiver.node" >&2
  exit 1
fi
otool -L "$CRATE/syphon-receiver.node" | grep -q "@rpath/Syphon.framework" || {
  echo "[build-syphon] FAIL: addon does not reference @rpath/Syphon.framework" >&2
  otool -L "$CRATE/syphon-receiver.node" >&2
  exit 1
}
echo "[build-syphon] OK — @rpath/Syphon.framework"
