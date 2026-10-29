/**
 * ERP 2.0's service engineer report, in a browser against the real client: the figures, the
 * table, the period, the CSV download, and money only for those who see it. Only the 2.0 face
 * has it; the others must not offer it at all.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/service-engineer-report-ui-test.js /tmp/base-v2.html
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(() => {
    let data;
    Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
      set(v) {
        if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { role: 'Service Coordinator', businessStream: 'All', email: 'sona@pie.in', name: 'Sona' });
        if (v && !v.listServiceJobs) v.listServiceJobs = [];
        data = v;
      } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const lastCall = (fn) => page.evaluate((f) => {
    const all = window.__calls.filter((c) => c.fn === f);
    return all.length ? all[all.length - 1].args : null;
  }, fn);
  const reset = () => page.evaluate(() => { window.__calls = []; });

  if (!v2) {
    console.log('THE OTHER FACES HAVE NO ENGINEER REPORT');
    ok('not in the menu', !(await page.$('#tabs [data-view="engreport"]')));
    ok('no screen for it', !(await page.$('#view-engreport')));
  } else {
    await page.evaluate(() => {
      window.__money = false;
      window.__data.getServiceEngineerReport = (o) => {
        const row = (name, extra) => Object.assign({ email: name.toLowerCase() + '@pie.in', name, assigned: 4, attended: 2, closed: 1, rescheduled: 2,
          rescheduledJobs: 1, pending: 1, local: 1, outstation: 1, noArea: 2, hoursLocal: 3, hoursOutstation: 5.5, hoursNoArea: 0, daysToAttend: 2.5,
          amcVisits: 1, spareEnquiries: 1, leads: 1 }, window.__money ? { spareValue: 18000 } : {}, extra || {});
        const rows = [row('Om', { assigned: 1, attended: 0, closed: 0, rescheduled: 0, rescheduledJobs: 0, local: 1, outstation: 0, noArea: 0, hoursLocal: 0,
          hoursOutstation: 0, daysToAttend: null, amcVisits: 0, spareEnquiries: 0, leads: 0, spareValue: window.__money ? 0 : undefined }), row('Tej')];
        const custom = o && o.period === 'custom';
        return { period: { key: (o && o.period) || 'month', from: custom ? o.from : '2026-10-01', to: custom ? o.to : '2026-10-31' },
          periods: [{ key: 'month', label: 'This month' }, { key: 'lastmonth', label: 'Last month' }, { key: 'quarter', label: 'This quarter' },
            { key: 'fy', label: 'This financial year' }, { key: 'custom', label: 'Custom range' }],
          today: '2026-10-29', money: window.__money, own: false, rows,
          totals: Object.assign({ assigned: 5, attended: 2, closed: 1, rescheduled: 2, rescheduledJobs: 1, pending: 1, local: 2, outstation: 1, noArea: 2,
            hoursLocal: 3, hoursOutstation: 5.5, hoursNoArea: 0, amcVisits: 1, spareEnquiries: 1, leads: 1 }, window.__money ? { spareValue: 18000 } : {}) };
      };
    });

    console.log('THE REPORT IN THE MENU');
    ok('under Reports', !!(await page.$('#tabs [data-view="engreport"]')));
    await reset();
    await page.evaluate(() => document.querySelector('#tabs [data-view="engreport"]').click());
    await page.waitForTimeout(500);
    ok('opens on this month', (await page.evaluate(() => document.querySelector('.view.active').id)) === 'view-engreport' &&
      JSON.stringify(await lastCall('getServiceEngineerReport')) === '[{"period":"month"}]');
    const k = await page.$$eval('#ser-kpis .pd-tile', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('the period in figures', /^Calls assigned 5 2 local · 1 outstation · 2 no area/.test(k[0]) && /^Attended 2 report in · 1 closed/.test(k[1]) &&
      /^Reschedules 2 on 1 call/.test(k[2]) && /^Hours on site 8\.5 3 local · 5\.5 outstation/.test(k[3]) && /^Enquiries passed on 2 1 spares · 1 compressor$/.test(k[4]), k);
    const head = await page.$$eval('#ser-body thead th', (t) => t.map((x) => x.textContent));
    ok('ERP 2’s columns, with no area apart, no money for service', head.join('|') === 'Engineer|Assigned|Attended|Closed|Rescheduled|On calls|Pending now|Local|Outstation|' +
      'No area|Hours local|Hours outstation|Hours, no area|Avg days to attend|AMC visits done|Spare enquiries|Compressor leads', head);
    const tej = await page.$$eval('#ser-body tbody tr:nth-child(2) td', (t) => t.map((x) => x.textContent));
    ok('each engineer’s line', tej.join('|') === 'Tej|4|2|1|2|1|1|1|1|2|3|5.5|0|2.5|1|1|1', tej);
    ok('a rescheduling engineer stands out', await page.$eval('#ser-body tbody tr:nth-child(2) td:nth-child(5)', (e) => e.classList.contains('sdc-late')));

    console.log('\nTHE DOWNLOAD');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-ser-csv')]);
    const file = await dl.path();
    const csv = require('fs').readFileSync(file, 'utf8').replace(/^﻿/, '');
    ok('a CSV named for the period', dl.suggestedFilename() === 'Service engineers 2026-10-01 to 2026-10-31.csv');
    ok('the same columns and lines', csv.split('\r\n')[0] === head.map((h) => '"' + h + '"').join(',') && /"Tej",4,2,1,2,1,1,1,1,2,"3","5\.5","0",2\.5,1,1,1/.test(csv), csv.split('\r\n').slice(0, 3));

    console.log('\nTHE PERIOD');
    await reset();
    await page.selectOption('#ser-period', 'quarter');
    await page.waitForTimeout(300);
    ok('asked of the server', JSON.stringify(await lastCall('getServiceEngineerReport')) === '[{"period":"quarter"}]');
    await page.selectOption('#ser-period', 'custom');
    await page.waitForTimeout(300);
    await page.fill('#ser-from', '2026-09-01');
    await page.waitForTimeout(300);
    ok('or a range', JSON.stringify(await lastCall('getServiceEngineerReport')) === '[{"period":"custom","from":"2026-09-01","to":"2026-10-31"}]', await lastCall('getServiceEngineerReport'));

    console.log('\nMANAGEMENT SEES THE VALUE');
    await page.evaluate(() => { window.__money = true; });
    await page.selectOption('#ser-period', 'month');
    await page.waitForTimeout(300);
    ok('of the enquiries passed on', (await page.$$eval('#ser-body thead th', (t) => t.map((x) => x.textContent))).indexOf('Spare enquiries value') !== -1 &&
      /₹18,000/.test(await page.textContent('#ser-body')) && /₹18K|18,000|0\.18 L/.test(await page.textContent('#ser-kpis')));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
