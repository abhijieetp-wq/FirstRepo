#!/usr/bin/env bash
# Every test, one command. Exits non-zero if any fail.
set -u
cd "$(dirname "$0")/.."
fail=0
tmp="${TMPDIR:-/tmp}/erp-preview"
mkdir -p "$tmp"

echo "── server ──────────────────────────────────────────"
for f in tests/*-test.js; do
  case "$f" in *-ui-test.js) continue;; esac
  printf '%-34s' "$(basename "$f")"
  if out=$(node "$f" 2>&1); then echo "${out##*$'\n'}"; else echo "FAILED"; echo "$out" | tail -20; fail=1; fi
done

echo
echo "── browser ─────────────────────────────────────────"
if [ ! -d node_modules/playwright ]; then
  echo "playwright missing — PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright"
  exit 1
fi
node tests/build-preview.js tests/fixtures/base.html "$tmp/base.html" >/dev/null
for f in tests/*-ui-test.js; do
  printf '%-34s' "$(basename "$f")"
  if out=$(node "$f" "$tmp/base.html" 2>&1); then echo "${out##*$'\n'}"; else echo "FAILED"; echo "$out" | tail -20; fail=1; fi
done

echo
[ $fail -eq 0 ] && echo "all suites passed" || echo "SOME SUITES FAILED"
exit $fail
