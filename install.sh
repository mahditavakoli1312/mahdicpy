#!/usr/bin/env bash
# mahdicpy installer — downloads the official scrcpy release (with adb) into
# ./vendor, verifies its checksum and links the `mahdicpy` command.
#
#   ./install.sh               install scrcpy 3.3.4 into ./vendor and link
#   ./install.sh --no-link     skip creating /usr/local/bin/mahdicpy
#   SCRCPY_VERSION=3.3.4 ./install.sh
set -euo pipefail

VERSION="${SCRCPY_VERSION:-3.3.4}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor"
LINK=1
[[ "${1:-}" == "--no-link" ]] && LINK=0

c() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
say() { echo "$(c '36' '›') $*"; }
ok() { echo "$(c '32' '✔') $*"; }
die() { echo "$(c '31' '✖') $*" >&2; exit 1; }

# Checksums of the official Genymobile/scrcpy v3.3.4 release (SHA256SUMS.txt).
sum_for() {
  case "$1" in
    scrcpy-macos-x86_64-v3.3.4.tar.gz)  echo cf9b3453a33279b6009dfb256b1a84c374bd4c30a71edd74bacab28d72a5d929 ;;
    scrcpy-macos-aarch64-v3.3.4.tar.gz) echo 8fef43520405dd523c74e1530ac68febcc5a405ea89712c874936675da8513dd ;;
    scrcpy-linux-x86_64-v3.3.4.tar.gz)  echo 0305d98c06178c67e12427bbf340c436d0d58c9e2a39bf9ffbbf8f54d7ef95a5 ;;
    *) echo "" ;;
  esac
}

command -v python3 >/dev/null || die "python3 is required (macOS: xcode-select --install)"

case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64)            PLATFORM=macos-x86_64 ;;
  Darwin-arm64)             PLATFORM=macos-aarch64 ;;
  Linux-x86_64)             PLATFORM=linux-x86_64 ;;
  *) die "no prebuilt scrcpy for $(uname -s) $(uname -m) — install scrcpy with your package manager; mahdicpy will find it on PATH" ;;
esac

ASSET="scrcpy-$PLATFORM-v$VERSION.tar.gz"
URL="https://github.com/Genymobile/scrcpy/releases/download/v$VERSION/$ASSET"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "downloading $(c 1 "$ASSET")"
curl -fL --progress-bar -o "$TMP/$ASSET" "$URL" || die "download failed: $URL"

EXPECTED="$(sum_for "$ASSET")"
if [[ -n "$EXPECTED" ]]; then
  ACTUAL="$(shasum -a 256 "$TMP/$ASSET" 2>/dev/null || sha256sum "$TMP/$ASSET")"
  [[ "${ACTUAL%% *}" == "$EXPECTED" ]] || die "checksum mismatch for $ASSET"
  ok "checksum verified"
else
  say "no pinned checksum for v$VERSION — skipping verification"
fi

rm -rf "$VENDOR"
mkdir -p "$VENDOR"
tar -xzf "$TMP/$ASSET" -C "$TMP"
cp -R "$TMP/scrcpy-$PLATFORM-v$VERSION/." "$VENDOR/"
chmod +x "$HERE/mahdicpy" "$VENDOR/scrcpy" "$VENDOR/adb" 2>/dev/null || true
ok "scrcpy $VERSION installed in vendor/"

if [[ $LINK == 1 ]]; then
  "$HERE/mahdicpy" link || true
fi

echo
ok "all set! try:"
echo "   mahdicpy            # mirror your phone"
echo "   mahdicpy web        # browser panel + developer toolkit"
echo "   mahdicpy doctor     # check your setup"
