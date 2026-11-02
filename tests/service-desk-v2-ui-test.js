/**
 * ERP 2.0's Service Desk, as the 2.0 demo draws it, in a browser against the real client: the
 * four tabs (Calls, Engineer reports, AMC and dues, Next-day plan) on all three screens; the
 * five totals; the call types, engineer, status, area and search; the table; a row opening the
 * job; Tomorrow's plan and + Service call. The other faces keep ERP 1's Service Jobs list.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/service-desk-v2-ui-test.js /tmp/show-v2.html
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e) + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
  // The test data is dated October 2026; the clock is held there so "this month" stays put.
  await page.clock.setFixedTime(new Date('2026-10-29T10:00:00+05:30'));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(700); };
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
  const rows = () => page.$$eval('#sdv-tbody tr[data-open-job]', (r) => r.map((x) => x.querySelector('td .mono').textContent));
  const tabs = (view) => page.$$eval('#view-' + view + ' .sdv-tabs [data-sdv-tab]', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ').trim() + (x.getAttribute('aria-selected') === 'true' ? '*' : '')));
  const pick = async (sel, v) => { await page.selectOption('#sdv-host [data-sdv-sel="' + sel + '"]', v); await page.waitForTimeout(150); };

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('service');
    ok('ERP 1’s Service Jobs list, no tabs', await shown('#service-tbody') && !(await page.$('.sdv-tabs')) && !(await page.$('#sdv-host')));
  } else {
    await page.evaluate(() => {
      const D = window.__data;
      D.getServiceJob = (id) => Object.assign({ items: [], proofs: [], deliveryProofs: [], reschedules: [] }, D.listServiceJobs().find((j) => j.id === id));
    });

    console.log('THE CALLS TAB');
    await go('service');
    ok('ERP 1’s list put away, 2.0’s in its place', await shown('#sdv-host') && !(await shown('#service-tbody')) && !(await shown('#service-search')));
    ok('the heading’s two buttons', await shown('#btn-sdv-plan') && /Tomorrow’s plan/.test(await page.textContent('#btn-sdv-plan')) &&
      /Service call/.test(await page.textContent('#btn-new-breakdown')));
    ok('four tabs, with the counts', JSON.stringify(await tabs('service')) === JSON.stringify(['Calls 7*', 'Engineer reports 2', 'AMC and dues 5', 'Next-day plan']), await tabs('service'));
    const tiles = await page.$$eval('#sdv-host .qv-kpi', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('five totals', tiles.length === 5 && tiles[0] === 'Open calls 7 9 logged this month' && tiles[1] === 'Breakdowns open 2 2 open over 24 hours' &&
      tiles[2] === 'Installations to do 1 from confirmed deliveries' && tiles[3] === 'Reports in, not closed 2 the coordinator closes these' &&
      tiles[4] === 'Closed this month 2 average 2.5 days to close', tiles);
    ok('a breakdown open is a red total', await page.$eval('#sdv-host .qv-kpi:nth-child(2)', (e) => e.classList.contains('bad')));
    ok('the table, in the demo’s columns', (await page.$$eval('#sdv-host th', (t) => t.map((x) => x.textContent))).join('|') ===
      'Call|Type|Customer|Machine · source|Opened|Engineer|Visit|Status');
    ok('the open calls, newest first', JSON.stringify(await rows()) === JSON.stringify(['SVJ2610-031', 'SVJ2610-030', 'SVJ2610-029', 'SVJ2610-028', 'SVJ2610-027', 'SVJ2610-026', 'SVJ2610-025']), await rows());
    const first = await page.$eval('#sdv-tbody tr', (r) => r.innerText.replace(/\s+/g, ' '));
    ok('a row: call, type, customer and town, machine and what is wrong, how long open, status', /SVJ2610-031/.test(first) && /Breakdown/.test(first) &&
      /Urgent/.test(first) && /Konkan Agro Foods/.test(first) && /Kamptee · Local/.test(first) && /EG22-40877/.test(first) && /Tripping on high temperature/.test(first) &&
      /28 Oct · 24 h/.test(first) && /New/.test(first), first);
    ok('a breakdown open a day is marked', await page.$eval('#sdv-tbody tr', (r) => r.classList.contains('sdv-hot')));
    const second = await page.$eval('#sdv-tbody tr:nth-child(2)', (r) => r.innerText.replace(/\s+/g, ' '));
    ok('the engineer by name, the visit, and a visit today says so', /Sagar Raut/.test(second) && /29 Oct 10:00/.test(second) && /Visit today/.test(second), second);
    ok('a moved visit says how often', /moved 1×/.test(await page.$eval('#sdv-tbody tr:nth-child(3)', (r) => r.innerText)));

    console.log('\nTHE FILTERS');
    ok('the six call types, and all', (await page.$$eval('#sdv-host [data-sdv-type]', (b) => b.map((x) => x.textContent))).join('|') ===
      'All types|Breakdown|AMC visit|Regular service|Spare change|Installation|Commissioning');
    await page.click('#sdv-host [data-sdv-type="Breakdown"]');
    await page.waitForTimeout(150);
    ok('a type', JSON.stringify(await rows()) === '["SVJ2610-031","SVJ2610-030"]', await rows());
    await page.click('#sdv-host [data-sdv-type=""]');
    await pick('eng', 'sagar@pie.in');
    ok('an engineer', JSON.stringify(await rows()) === '["SVJ2610-030","SVJ2610-028","SVJ2610-026"]', await rows());
    ok('the engineers to pick from', (await page.$$eval('#sdv-host [data-sdv-sel="eng"] option', (o) => o.map((x) => x.textContent))).join('|') ===
      'All engineers|Not assigned|Sagar Raut|Vikas Meshram');
    await pick('eng', '__none');
    ok('or the calls nobody has', JSON.stringify(await rows()) === '["SVJ2610-031","SVJ2610-025"]', await rows());
    await pick('eng', '');
    await pick('status', 'Closed');
    ok('a status, closed ones too', JSON.stringify(await rows()) === '["SVJ2610-024","SVJ2610-023"]', await rows());
    await pick('status', 'open');
    await pick('area', 'Outstation');
    ok('outstation calls', JSON.stringify(await rows()) === '["SVJ2610-029","SVJ2610-028","SVJ2610-025"]', await rows());
    await pick('area', '');
    await page.fill('#sdv-host [data-sdv-q]', 'godavari');
    await page.waitForTimeout(150);
    ok('search, keeping the box', JSON.stringify(await rows()) === '["SVJ2610-029","SVJ2610-028"]' && await page.evaluate(() => document.activeElement.matches('[data-sdv-q]')));
    await page.fill('#sdv-host [data-sdv-q]', '');
    await page.waitForTimeout(150);

    console.log('\nENGINEER REPORTS');
    await page.click('#view-service [data-sdv-tab="reports"]');
    await page.waitForTimeout(200);
    ok('the calls whose report is in, waiting to be closed', JSON.stringify(await rows()) === '["SVJ2610-028","SVJ2610-027"]' &&
      (await tabs('service'))[1] === 'Engineer reports 2*' && await page.$eval('#sdv-host [data-sdv-sel="status"]', (s) => s.value) === 'Report submitted', await tabs('service'));
    await page.click('#sdv-host [data-sdv-tile="Report submitted"]');
    await page.waitForTimeout(150);
    ok('the total turns it off again, back to Calls', (await rows()).length === 7 && (await tabs('service'))[0] === 'Calls 7*');
    await page.click('#sdv-host [data-sdv-tile="Report submitted"]');
    await page.waitForTimeout(150);
    ok('and on', (await rows()).length === 2);
    await page.click('#view-service [data-sdv-tab="calls"]');
    await page.waitForTimeout(150);

    console.log('\nA ROW');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#sdv-tbody tr[data-open-job="SJ-30"]');
    await page.waitForTimeout(500);
    ok('opens the job window', await page.evaluate(() => window.__calls.some((c) => c.fn === 'getServiceJob' && c.args[0] === 'SJ-30')) &&
      await page.evaluate(() => document.getElementById('service-modal-backdrop').classList.contains('show')));
    await page.evaluate(() => document.querySelectorAll('.modal-backdrop.show').forEach((m) => m.classList.remove('show')));

    console.log('\nTHE OTHER TWO TABS');
    await page.click('#view-service [data-sdv-tab="amc"]');
    await page.waitForTimeout(500);
    ok('AMC and dues opens the AMC screen, with the same tabs', await page.evaluate(() => document.getElementById('view-amc').classList.contains('active')) &&
      (await tabs('amc')).join('|') === 'Calls 7|Engineer reports 2|AMC and dues 5*|Next-day plan', await tabs('amc'));
    await page.click('#view-amc [data-sdv-tab="plan"]');
    await page.waitForTimeout(500);
    ok('Next-day plan opens the plan, with the same tabs', await page.evaluate(() => document.getElementById('view-plan').classList.contains('active')) &&
      (await tabs('plan')).join('|') === 'Calls 7|Engineer reports 2|AMC and dues 5|Next-day plan*', await tabs('plan'));
    await page.click('#view-plan [data-sdv-tab="reports"]');
    await page.waitForTimeout(500);
    ok('Engineer reports from there goes back to the desk, filtered', await page.evaluate(() => document.getElementById('view-service').classList.contains('active')) &&
      (await rows()).length === 2);
    await page.click('#btn-sdv-plan');
    await page.waitForTimeout(500);
    ok('Tomorrow’s plan opens the plan', await page.evaluate(() => document.getElementById('view-plan').classList.contains('active')));
    await go('service');
    await page.click('#btn-new-breakdown');
    await page.waitForTimeout(500);
    ok('+ Service call opens the call form', await page.evaluate(() => document.getElementById('breakdown-modal-backdrop').classList.contains('show')));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
