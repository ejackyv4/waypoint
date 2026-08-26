#!/usr/bin/env bash
# Unpack SCORM zips into spike/packages/ ready for the harness.
#
#   ./spike/unpack.sh spike/corpus/RuntimeBasicCalls_SCORM12.zip
#   ./spike/unpack.sh spike/corpus/*.zip
#   ./spike/unpack.sh spike/corpus            # whole directory

set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -gt 0 ] || { echo "usage: ./spike/unpack.sh <zip|dir> [...]"; exit 1; }

zips=()
for a in "$@"; do
  if [ -d "$a" ]; then for z in "$a"/*.zip; do [ -f "$z" ] && zips+=("$z"); done
  else zips+=("$a"); fi
done

for z in "${zips[@]}"; do
  name="$(basename "$z" .zip)"
  dest="spike/packages/$name"
  rm -rf "$dest"; mkdir -p "$dest"
  unzip -qq -o "$z" -d "$dest"
  printf '  unpacked  %s\n' "$name"
done
echo
echo "Now run ./spike/serve.sh and pick from the dropdown."
