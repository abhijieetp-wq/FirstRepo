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
# The portal has two faces — what Apps Script serves, and the Node server's new design over
# the same markup and behaviour — so the behaviour test runs against both, and the shell test
# checks what only the new one has.
node tests/build-preview.js tests/fixtures/base.html "$tmp/base.html" >/dev/null
node tests/build-preview.js tests/fixtures/base.html "$tmp/base-web.html" --ui=web >/dev/null
node tests/build-preview.js tests/fixtures/showcase.html "$tmp/show.html" --ui=web \
  --title="ELGi Sales ERP" >/dev/null
node tests/build-preview.js tests/fixtures/showcase.html "$tmp/show-classic.html" \
  --title="ELGi Sales ERP" >/dev/null
run_ui() {
  printf '%-34s' "$1"; shift
  if out=$(node "$@" 2>&1); then echo "${out##*$'\n'}"; else echo "FAILED"; echo "$out" | tail -20; fail=1; fi
}
run_ui "portal-ui-test.js (classic)" tests/portal-ui-test.js "$tmp/base.html"
run_ui "portal-ui-test.js (new design)" tests/portal-ui-test.js "$tmp/base-web.html"
run_ui "shell-ui-test.js" tests/shell-ui-test.js "$tmp/show.html" "$tmp/show-classic.html"
run_ui "refinements-ui-test.js (classic)" tests/refinements-ui-test.js "$tmp/base.html"
run_ui "refinements-ui-test.js (new design)" tests/refinements-ui-test.js "$tmp/base-web.html"
run_ui "catalog-ui-test.js (classic)" tests/catalog-ui-test.js "$tmp/base.html"
run_ui "catalog-ui-test.js (new design)" tests/catalog-ui-test.js "$tmp/base-web.html"

echo
[ $fail -eq 0 ] && echo "all suites passed" || echo "SOME SUITES FAILED"
exit $fail
