/**
 * The ERP's side of the Tender Desk (JavaScript.html): no Tender Desk screens in the ERP's menu
 * — it is a module with a page of its own — and, on the dashboard, the switch between the ERP
 * and the Tender Desk, with how many things there need the person, for whoever has it.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --title="ELGi Sales ERP"
 *   node tests/tender-switch-ui-test.js /tmp/show-v2.html [screenshot-dir]
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
const SHOTS = process.argv[3] || '';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

const seed = (alerts) => {
  const dash = window.__data.getPersonDashboard;
  window.__data.getPersonDashboard = function (o) {
    const d = dash.apply(null, arguments);
    if (!(o && o.as) && alerts !== null) d.tenderDesk = { alerts };
    return d;
  };
};

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const open = async (alerts) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      let d;
      Object.defineProperty(window, '__data', { configurable: true, get: () => d, set: (v) => { d = v; if (window.__seedTd) window.__seedTd(); } });
    });
    await page.addInitScript('window.__seedTd = function () { (' + seed.toString() + ')(' + JSON.stringify(alerts) + '); };');
    await page.goto('file://' + PREVIEW);
    await page.waitForTimeout(1500);
    return page;
  };

  let page = await open(3);
  const views = await page.$$eval('#tabs [data-view]', (b) => b.map((x) => x.dataset.view));
  ok('the ERP\'s menu has no Tender Desk screens', !views.some((v) => /^tender/.test(v)), views);
  ok('the dashboard has the switch, the ERP lit', !!(await page.$('#view-dashboard .erp-switch')) && (await page.textContent('.erp-switch .on')).trim() === 'ERP');
  ok('the Tender Desk side opens its own page', await page.getAttribute('.erp-switch a', 'href') === '/tender-desk');
  ok('with how many things need them there', (await page.textContent('.erp-switch-n')).trim() === '3');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'erp-switch.png'), clip: { x: 0, y: 0, width: 1440, height: 420 } });
  await page.close();
  page = await open(0);
  ok('no number when nothing needs them', !(await page.$('.erp-switch-n')) && !!(await page.$('.erp-switch')));
  await page.close();
  page = await open(null);
  ok('nobody without the Tender Desk gets the switch', !(await page.$('.erp-switch')));
  await page.close();
  ok('no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : 'all ') + pass + ' passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
