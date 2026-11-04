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
# ERP 2.0 is the portal's only face (server/page.js), so every screen suite runs against it: the
# behaviour fixture and the showcase, which has a menu and a dashboard to draw.
node tests/build-preview.js tests/fixtures/base.html "$tmp/base-v2.html" >/dev/null
node tests/build-preview.js tests/fixtures/showcase.html "$tmp/show-v2.html" --title="ELGi Sales ERP" >/dev/null
run_ui() {
  printf '%-34s' "$1"; shift
  if out=$(node "$@" 2>&1); then echo "${out##*$'\n'}"; else echo "FAILED"; echo "$out" | tail -20; fail=1; fi
}
run_ui "portal-ui-test.js" tests/portal-ui-test.js "$tmp/base-v2.html"
run_ui "shell-ui-test.js" tests/shell-ui-test.js "$tmp/show-v2.html"
run_ui "v2-ui-test.js" tests/v2-ui-test.js "$tmp/show-v2.html"
run_ui "theme-v2-ui-test.js" tests/theme-v2-ui-test.js "$tmp/show-v2.html"
run_ui "compressor-pipeline-v2-ui-test.js" tests/compressor-pipeline-v2-ui-test.js "$tmp/show-v2.html"
run_ui "refinements-ui-test.js" tests/refinements-ui-test.js "$tmp/base-v2.html"
run_ui "catalog-ui-test.js" tests/catalog-ui-test.js "$tmp/base-v2.html"
run_ui "engineer-leads-ui-test.js" tests/engineer-leads-ui-test.js "$tmp/base-v2.html"
run_ui "quote-text-ui-test.js" tests/quote-text-ui-test.js "$tmp/base-v2.html"
run_ui "quote-status-ui-test.js" tests/quote-status-ui-test.js "$tmp/base-v2.html"
run_ui "service-due-ui-test.js" tests/service-due-ui-test.js "$tmp/base-v2.html"
# The SDR rows worked in place are 2.0's alone: the other faces must keep ERP 1's row.
run_ui "sdr-rows-ui-test.js" tests/sdr-rows-ui-test.js "$tmp/base-v2.html"
# The enquiry board is 2.0's too: the other faces keep the Spare and Compressor lists.
run_ui "enquiry-board-ui-test.js" tests/enquiry-board-ui-test.js "$tmp/base-v2.html"
# And its drawer, as the 2.0 demo has it: the dropdowns, follow-ups, marking lost.
run_ui "board-drawer-ui-test.js" tests/board-drawer-ui-test.js "$tmp/base-v2.html"
# All Quotations and Quotation Progress, as the 2.0 demo draws them.
run_ui "quotations-v2-ui-test.js" tests/quotations-v2-ui-test.js "$tmp/show-v2.html"
# The Service Desk, as the 2.0 demo draws it: four tabs, totals, call types, one table.
run_ui "service-desk-v2-ui-test.js" tests/service-desk-v2-ui-test.js "$tmp/show-v2.html"
# Sales Orders, as the 2.0 demo draws them.
run_ui "orders-v2-ui-test.js" tests/orders-v2-ui-test.js "$tmp/show-v2.html"
# Dispatch & Billing, as the 2.0 demo draws it.
run_ui "dispatch-v2-ui-test.js" tests/dispatch-v2-ui-test.js "$tmp/show-v2.html"
# Collections, as the 2.0 demo draws it.
run_ui "collections-v2-ui-test.js" tests/collections-v2-ui-test.js "$tmp/show-v2.html"
# The quotation page, laid out as the 2.0 demo has it.
run_ui "quote-builder-v2-ui-test.js" tests/quote-builder-v2-ui-test.js "$tmp/base-v2.html"
# Inventory & Inward, as the 2.0 demo draws it.
run_ui "inventory-v2-ui-test.js" tests/inventory-v2-ui-test.js "$tmp/show-v2.html"
# Customers, as the 2.0 demo draws it.
run_ui "customers-v2-ui-test.js" tests/customers-v2-ui-test.js "$tmp/show-v2.html"
# The Catalogue, as the 2.0 demo draws it.
run_ui "catalog-v2-ui-test.js" tests/catalog-v2-ui-test.js "$tmp/show-v2.html"
# So is the dashboard per person; the showcase adds Management's view of the team.
run_ui "person-dashboard-ui-test.js" tests/person-dashboard-ui-test.js "$tmp/base-v2.html" "$tmp/show-v2.html"
# And the service desk's statuses; the other faces keep ERP 1's job window.
run_ui "service-desk-ui-test.js" tests/service-desk-ui-test.js "$tmp/base-v2.html"
# AMC is a 2.0 screen; the other faces must not offer it at all.
run_ui "amc-ui-test.js" tests/amc-ui-test.js "$tmp/base-v2.html"
# So is the next-day plan.
run_ui "next-day-plan-ui-test.js" tests/next-day-plan-ui-test.js "$tmp/base-v2.html"
# And tasks with the scorecard.
run_ui "tasks-ui-test.js" tests/tasks-ui-test.js "$tmp/base-v2.html"
# And escalations.
run_ui "escalations-ui-test.js" tests/escalations-ui-test.js "$tmp/base-v2.html"
# And visit plans.
run_ui "visit-plans-ui-test.js" tests/visit-plans-ui-test.js "$tmp/base-v2.html"
# And the service call additions.
run_ui "service-calls-ui-test.js" tests/service-calls-ui-test.js "$tmp/base-v2.html"
# And the service engineer report.
run_ui "service-engineer-report-ui-test.js" tests/service-engineer-report-ui-test.js "$tmp/base-v2.html"
# And the board's totals, filters, order tab and lead area.
run_ui "board-extras-ui-test.js" tests/board-extras-ui-test.js "$tmp/base-v2.html"
# And the dashboard's period, today's visits and the SDR totals.
run_ui "dashboard-extras-ui-test.js" tests/dashboard-extras-ui-test.js "$tmp/base-v2.html"
# And the form builder: fields of your own on each form.
run_ui "form-fields-ui-test.js" tests/form-fields-ui-test.js "$tmp/base-v2.html"
# And the Ask bar: a request in plain words, read by Claude, done only once ticked.
run_ui "ai-commands-ui-test.js" tests/ai-commands-ui-test.js "$tmp/base-v2.html"

echo
[ $fail -eq 0 ] && echo "all suites passed" || echo "SOME SUITES FAILED"
exit $fail
