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
# ERP 2.0's look is a third face over the same markup and behaviour: every screen suite runs
# against it too, and v2-ui-test.js checks what only 2.0 adds.
node tests/build-preview.js tests/fixtures/base.html "$tmp/base-v2.html" --ui=v2 >/dev/null
node tests/build-preview.js tests/fixtures/showcase.html "$tmp/show-v2.html" --ui=v2 \
  --title="ELGi Sales ERP" >/dev/null
run_ui() {
  printf '%-34s' "$1"; shift
  if out=$(node "$@" 2>&1); then echo "${out##*$'\n'}"; else echo "FAILED"; echo "$out" | tail -20; fail=1; fi
}
run_ui "portal-ui-test.js (classic)" tests/portal-ui-test.js "$tmp/base.html"
run_ui "portal-ui-test.js (new design)" tests/portal-ui-test.js "$tmp/base-web.html"
run_ui "portal-ui-test.js (2.0)" tests/portal-ui-test.js "$tmp/base-v2.html"
run_ui "shell-ui-test.js" tests/shell-ui-test.js "$tmp/show.html" "$tmp/show-classic.html"
run_ui "v2-ui-test.js" tests/v2-ui-test.js "$tmp/show-v2.html"
run_ui "refinements-ui-test.js (classic)" tests/refinements-ui-test.js "$tmp/base.html"
run_ui "refinements-ui-test.js (new design)" tests/refinements-ui-test.js "$tmp/base-web.html"
run_ui "refinements-ui-test.js (2.0)" tests/refinements-ui-test.js "$tmp/base-v2.html"
run_ui "catalog-ui-test.js (classic)" tests/catalog-ui-test.js "$tmp/base.html"
run_ui "catalog-ui-test.js (new design)" tests/catalog-ui-test.js "$tmp/base-web.html"
run_ui "catalog-ui-test.js (2.0)" tests/catalog-ui-test.js "$tmp/base-v2.html"
run_ui "engineer-leads-ui-test.js (classic)" tests/engineer-leads-ui-test.js "$tmp/base.html"
run_ui "engineer-leads-ui-test.js (new design)" tests/engineer-leads-ui-test.js "$tmp/base-web.html"
run_ui "engineer-leads-ui-test.js (2.0)" tests/engineer-leads-ui-test.js "$tmp/base-v2.html"
run_ui "quote-text-ui-test.js (classic)" tests/quote-text-ui-test.js "$tmp/base.html"
run_ui "quote-text-ui-test.js (new design)" tests/quote-text-ui-test.js "$tmp/base-web.html"
run_ui "quote-text-ui-test.js (2.0)" tests/quote-text-ui-test.js "$tmp/base-v2.html"
run_ui "quote-status-ui-test.js (classic)" tests/quote-status-ui-test.js "$tmp/base.html"
run_ui "quote-status-ui-test.js (new design)" tests/quote-status-ui-test.js "$tmp/base-web.html"
run_ui "quote-status-ui-test.js (2.0)" tests/quote-status-ui-test.js "$tmp/base-v2.html"
run_ui "service-due-ui-test.js (classic)" tests/service-due-ui-test.js "$tmp/base.html"
run_ui "service-due-ui-test.js (new design)" tests/service-due-ui-test.js "$tmp/base-web.html"
run_ui "service-due-ui-test.js (2.0)" tests/service-due-ui-test.js "$tmp/base-v2.html"
# The SDR rows worked in place are 2.0's alone: the other faces must keep ERP 1's row.
run_ui "sdr-rows-ui-test.js (classic)" tests/sdr-rows-ui-test.js "$tmp/base.html"
run_ui "sdr-rows-ui-test.js (new design)" tests/sdr-rows-ui-test.js "$tmp/base-web.html"
run_ui "sdr-rows-ui-test.js (2.0)" tests/sdr-rows-ui-test.js "$tmp/base-v2.html"
# The enquiry board is 2.0's too: the other faces keep the Spare and Compressor lists.
run_ui "enquiry-board-ui-test.js (classic)" tests/enquiry-board-ui-test.js "$tmp/base.html"
run_ui "enquiry-board-ui-test.js (new design)" tests/enquiry-board-ui-test.js "$tmp/base-web.html"
run_ui "enquiry-board-ui-test.js (2.0)" tests/enquiry-board-ui-test.js "$tmp/base-v2.html"
# So is the dashboard per person; the showcase adds Management's view of the team.
run_ui "person-dashboard-ui-test.js (classic)" tests/person-dashboard-ui-test.js "$tmp/base.html"
run_ui "person-dashboard-ui-test.js (new design)" tests/person-dashboard-ui-test.js "$tmp/base-web.html"
run_ui "person-dashboard-ui-test.js (2.0)" tests/person-dashboard-ui-test.js "$tmp/base-v2.html" "$tmp/show-v2.html"
# And the service desk's statuses; the other faces keep ERP 1's job window.
run_ui "service-desk-ui-test.js (classic)" tests/service-desk-ui-test.js "$tmp/base.html"
run_ui "service-desk-ui-test.js (new design)" tests/service-desk-ui-test.js "$tmp/base-web.html"
run_ui "service-desk-ui-test.js (2.0)" tests/service-desk-ui-test.js "$tmp/base-v2.html"
# AMC is a 2.0 screen; the other faces must not offer it at all.
run_ui "amc-ui-test.js (classic)" tests/amc-ui-test.js "$tmp/base.html"
run_ui "amc-ui-test.js (new design)" tests/amc-ui-test.js "$tmp/base-web.html"
run_ui "amc-ui-test.js (2.0)" tests/amc-ui-test.js "$tmp/base-v2.html"
# So is the next-day plan.
run_ui "next-day-plan-ui-test.js (classic)" tests/next-day-plan-ui-test.js "$tmp/base.html"
run_ui "next-day-plan-ui-test.js (new design)" tests/next-day-plan-ui-test.js "$tmp/base-web.html"
run_ui "next-day-plan-ui-test.js (2.0)" tests/next-day-plan-ui-test.js "$tmp/base-v2.html"
# And tasks with the scorecard.
run_ui "tasks-ui-test.js (classic)" tests/tasks-ui-test.js "$tmp/base.html"
run_ui "tasks-ui-test.js (new design)" tests/tasks-ui-test.js "$tmp/base-web.html"
run_ui "tasks-ui-test.js (2.0)" tests/tasks-ui-test.js "$tmp/base-v2.html"
# And escalations.
run_ui "escalations-ui-test.js (classic)" tests/escalations-ui-test.js "$tmp/base.html"
run_ui "escalations-ui-test.js (new design)" tests/escalations-ui-test.js "$tmp/base-web.html"
run_ui "escalations-ui-test.js (2.0)" tests/escalations-ui-test.js "$tmp/base-v2.html"
# And visit plans.
run_ui "visit-plans-ui-test.js (classic)" tests/visit-plans-ui-test.js "$tmp/base.html"
run_ui "visit-plans-ui-test.js (new design)" tests/visit-plans-ui-test.js "$tmp/base-web.html"
run_ui "visit-plans-ui-test.js (2.0)" tests/visit-plans-ui-test.js "$tmp/base-v2.html"
# And the service call additions.
run_ui "service-calls-ui-test.js (classic)" tests/service-calls-ui-test.js "$tmp/base.html"
run_ui "service-calls-ui-test.js (new design)" tests/service-calls-ui-test.js "$tmp/base-web.html"
run_ui "service-calls-ui-test.js (2.0)" tests/service-calls-ui-test.js "$tmp/base-v2.html"
# And the service engineer report.
run_ui "service-engineer-report-ui-test.js (classic)" tests/service-engineer-report-ui-test.js "$tmp/base.html"
run_ui "service-engineer-report-ui-test.js (new design)" tests/service-engineer-report-ui-test.js "$tmp/base-web.html"
run_ui "service-engineer-report-ui-test.js (2.0)" tests/service-engineer-report-ui-test.js "$tmp/base-v2.html"
# And the board's totals, filters, order tab and lead area.
run_ui "board-extras-ui-test.js (classic)" tests/board-extras-ui-test.js "$tmp/base.html"
run_ui "board-extras-ui-test.js (new design)" tests/board-extras-ui-test.js "$tmp/base-web.html"
run_ui "board-extras-ui-test.js (2.0)" tests/board-extras-ui-test.js "$tmp/base-v2.html"
# And the dashboard's period, today's visits and the SDR totals.
run_ui "dashboard-extras-ui-test.js (classic)" tests/dashboard-extras-ui-test.js "$tmp/base.html"
run_ui "dashboard-extras-ui-test.js (new design)" tests/dashboard-extras-ui-test.js "$tmp/base-web.html"
run_ui "dashboard-extras-ui-test.js (2.0)" tests/dashboard-extras-ui-test.js "$tmp/base-v2.html"
# And the form builder: fields of your own on each form.
run_ui "form-fields-ui-test.js (classic)" tests/form-fields-ui-test.js "$tmp/base.html"
run_ui "form-fields-ui-test.js (new design)" tests/form-fields-ui-test.js "$tmp/base-web.html"
run_ui "form-fields-ui-test.js (2.0)" tests/form-fields-ui-test.js "$tmp/base-v2.html"

echo
[ $fail -eq 0 ] && echo "all suites passed" || echo "SOME SUITES FAILED"
exit $fail
