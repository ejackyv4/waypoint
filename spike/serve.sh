#!/usr/bin/env bash
# Waypoint SCORM spike — serve the harness and any unpacked packages.
#
#   ./spike/serve.sh [port]          default 8080
#
# Unpack packages into spike/packages/<name>/ (or use unpack.sh) then open
# the harness. Courses MUST be loaded through the harness — opening a course
# URL directly gives "Unable to find an API adapter", because the ADL
# discovery algorithm looks for the adapter in window.parent.

set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8080}"
mkdir -p packages

# Build packages.json so the harness can offer a dropdown instead of
# relying on anyone typing a path correctly.
{
  echo "["
  first=1
  for d in packages/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    man="$d/imsmanifest.xml"
    [ -f "$man" ] || continue
    # first resource marked as a SCO; falls back to the first href present
    href="$(tr '\n' ' ' < "$man" \
            | grep -oiE '<resource[^>]*scormtype="sco"[^>]*>' \
            | head -1 | grep -oiE 'href="[^"]*"' | head -1 \
            | sed 's/[hH][rR][eE][fF]="//;s/"//')"
    [ -n "$href" ] || href="$(grep -oiE 'href="[^"]*"' "$man" | head -1 | sed 's/[hH][rR][eE][fF]="//;s/"//')"
    ver="$(grep -oE '<schemaversion>[^<]*' "$man" | head -1 | sed 's/<schemaversion>//' | tr -d '\r')"
    [ $first -eq 1 ] || echo ","
    first=0
    printf '  {"name":"%s","launch":"/packages/%s/%s","version":"%s"}' \
           "$name" "$name" "$href" "${ver:-?}"
  done
  echo
  echo "]"
} > packages.json

echo
echo "  Waypoint SCORM harness"
echo "  → http://localhost:${PORT}/harness.html"
echo
if [ "$(grep -c '"name"' packages.json || true)" -gt 0 ]; then
  echo "  Packages (pick from the dropdown in the harness):"
  grep -o '"name":"[^"]*"' packages.json | sed 's/"name":"/    · /;s/"//'
else
  echo "  No packages yet:  ./spike/unpack.sh spike/corpus/RuntimeBasicCalls_SCORM12.zip"
fi
echo
echo "  Load courses THROUGH the harness. Opening a course URL directly"
echo "  fails with 'Unable to find an API adapter' — the course looks for"
echo "  the adapter in window.parent, and a top-level window has none."
echo
# Plain http.server lets the browser cache harness.html, so edits appear to
# have no effect — or worse, half an effect. In a spike the file changes every
# few minutes, so serve everything no-store.
exec python3 -c '
import sys, functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()
    def log_message(self, fmt, *a):
        if "404" in (fmt % a): sys.stderr.write("  404  %s\n" % (fmt % a))

port = int(sys.argv[1])
ThreadingHTTPServer(("", port), NoCache).serve_forever()
' "$PORT"
