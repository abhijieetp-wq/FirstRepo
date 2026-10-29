/**
 * The service engineer on enquiries and leads, and the Leads by Engineer report, in a browser
 * against the real client.
 *
 *   1. the spare enquiry form offers the service engineers, sends the one picked, and shows
 *      the one already on an enquiry
 *   2. the enquiry list names the engineer and can be searched by them
 *   3. the compressor lead form and list the same
 *   4. the report opens on this financial year, draws a table per stream, narrows to one
 *      engineer when their name is pressed, and downloads what is on screen
 *   5. with no service engineers on the user list, the form and the report say where to add them
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview.html [--ui=web]
 *   node tests/engineer-leads-ui-test.js /tmp/preview.html
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const tally = (o) => Object.assign({ logged: 0, quoted: 0, quotedValue: 0, won: 0,
  orderValue: 0, invoiced: 0 }, o);
const REPORT = {
  generatedAt: '2026-10-20T10:00:00Z', showSpare: true, showUnits: true,
  engineers: [
    { email: 'ravi@pie.in', name: 'Ravi Kumar',
      spare: tally({ logged: 2, quoted: 1, quotedValue: 9000, won: 1, orderValue: 9000, invoiced: 9010 }),
      units: tally({ logged: 1, converted: 0 }) },
    { email: 'suresh@pie.in', name: 'Suresh Patil', spare: tally({}),
      units: tally({ logged: 1, converted: 1, quoted: 1, quotedValue: 590000, won: 1, orderValue: 590000 }) }
  ],
  none: { email: '', name: 'Not from a service engineer',
    spare: tally({ logged: 1, quoted: 1, quotedValue: 2000 }), units: tally({ converted: 0 }) },
  totals: {
    spare: tally({ logged: 3, quoted: 2, quotedValue: 11000, won: 1, orderValue: 9000, invoiced: 9010 }),
    units: tally({ logged: 2, converted: 1, quoted: 1, quotedValue: 590000, won: 1, orderValue: 590000 })
  },
  columns: [{ key: 'engineer', label: 'Service engineer' }, { key: 'ref', label: 'Ref no.' },
    { key: 'customer', label: 'Customer' }, { key: 'quotedValue', label: 'Quoted value (Rs)' }],
  rows: [
    { id: 'E1', ref: 'SE/1', kind: 'Spare enquiry', stream: 'Spare Sales', date: '2026-10-02',
      engineerEmail: 'ravi@pie.in', engineer: 'Ravi Kumar', customer: 'Topworth Urja',
      progress: 'Won', quotes: 'Q/501 R1', quoteCount: 1, quotedValue: 9000, orders: 'SO/1',
      orderCount: 1, orderValue: 9000, invoiced: 9010 },
    { id: 'E3', ref: 'SE/3', kind: 'Spare enquiry', stream: 'Spare Sales', date: '2026-10-06',
      engineerEmail: '', engineer: '', customer: 'Kalyani Steels', progress: 'Lost',
      quotes: 'Q/503', quoteCount: 1, quotedValue: 2000, orders: '', orderCount: 0,
      orderValue: 0, invoiced: 0 },
    { id: 'L1', ref: 'LD/1', kind: 'Compressor lead', stream: 'Compressor Sales',
      date: '2026-10-03', engineerEmail: 'suresh@pie.in', engineer: 'Suresh Patil',
      customer: 'Kalyani Steels', progress: 'Opportunity: Won', quotes: 'Q/601', quoteCount: 1,
      quotedValue: 590000, orders: 'SO/2', orderCount: 1, orderValue: 590000, invoiced: 0 }
  ]
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: true });
  const html = fs.readFileSync(PREVIEW, 'utf8');

  // Somebody who works both streams, with two service engineers on the user list.
  let both = html.replace(/(bootstrap: \{[^}]*?businessStream: )"Spare Sales"/, '$1"All"');
  if (both === html) throw new Error('could not widen the fixture user to both streams');
  const withEngineers = both.replace('serviceCoordinators: [], serviceEngineers: [],',
    'serviceCoordinators: [], serviceEngineers: [{ email: "ravi@pie.in", name: "Ravi Kumar" }, ' +
    '{ email: "suresh@pie.in", name: "Suresh Patil" }],');
  if (withEngineers === both) throw new Error('could not add service engineers to the fixture');
  const copy = PREVIEW.replace(/\.html$/, '') + '.engineers.html';
  fs.writeFileSync(copy, withEngineers);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + copy);
  // ERP 1's lists are what this checks; on 2.0 they open only on purpose.
  await page.evaluate(() => { try { localStorage.setItem('erp.board.spare', 'erp1'); localStorage.setItem('erp.board.compressor', 'erp1'); } catch (e) { /* none */ } });
  await page.waitForTimeout(1200);

  const shown = (sel) => page.$eval(sel, (e) => getComputedStyle(e).display !== 'none');
  const value = (sel) => page.$eval(sel, (e) => e.value);
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
  const lastArgs = (fn) => page.evaluate((f) => {
    const hits = (window.__calls || []).filter((c) => c.fn === f);
    return hits.length ? hits[hits.length - 1].args : null;
  }, fn);
  const go = async (view) => {
    await page.evaluate((v) => document.querySelector('[data-view="' + v + '"]').click(), view);
    await page.waitForTimeout(500);
    // ERP 1's lists are what this checks; on 2.0 the sales screens open on the enquiry board.
    await page.evaluate(() => {
      const list = document.querySelector('.view.active #eb-switch-spare [data-eb-mode="list"]');
      if (list) list.click();
      const leads = document.querySelector('.view.active #subtab-board.btn-primary') && document.getElementById('subtab-leads');
      if (leads) leads.click();
    });
    await page.waitForTimeout(300);
  };
  const options = (sel) => page.$$eval(sel + ' option', (os) => os.map((o) => o.textContent.trim()));

  // The answers this test needs that the shared fixture does not carry.
  await page.evaluate((report) => {
    const D = window.__data;
    const customers = D.listCustomers();
    const enquiries = D.listSpareEnquiries();
    enquiries[0].serviceEngineerEmail = 'ravi@pie.in';
    enquiries[0].serviceEngineerName = 'Ravi Kumar';
    enquiries.push({ id: 'SE-7', enquiryNo: 'SE2610-0007', customerId: 'CU-1',
      customerName: 'Topworth Urja', status: 'New', urgency: 'Normal', items: [],
      requirementText: 'Oil filter', serviceEngineerEmail: '', serviceEngineerName: '',
      date: '2026-10-07' });
    D.spareSalesScreen = function () {
      return { enquiries: enquiries, customers: customers, lostReasons: [], knownModels: [] };
    };
    D.listLeads = [{ id: 'LD-1', leadNo: 'LD2610-0001', date: '2026-10-03',
      customerName: 'Kalyani Steels', status: 'New', nextActionDate: '2026-11-01',
      requirements: [], requirementText: '2 × 30 HP', source: 'Service visit',
      ownerEmail: 'p@pie.in', serviceEngineerEmail: 'suresh@pie.in',
      serviceEngineerName: 'Suresh Patil', budget: '' }];
    D.saveLead = function (o) {
      return Object.assign({ id: o.id || 'LD-9', leadNo: 'LD2610-0009', requirements: [] }, o);
    };
    D.getEngineerLeadsReport = function (input) {
      return Object.assign({}, report, { from: input.from, to: input.to });
    };
  }, REPORT);

  // ------------------------------------------------------------- 1. the enquiry form
  console.log('THE SPARE ENQUIRY FORM ASKS WHICH SERVICE ENGINEER IT CAME FROM');
  await go('enquiries');
  await page.click('#btn-new-enquiry');
  await page.waitForTimeout(400);
  ok('the box is there, labelled for what it is',
    /Service Engineer/.test(await page.$eval('#em-service-engineer', (e) => e.closest('.field').textContent)));
  const emOpts = await options('#em-service-engineer');
  ok('offering None and the service engineers by name',
    emOpts.join('|') === 'None — not from an engineer|Ravi Kumar|Suresh Patil', emOpts);
  ok('a new enquiry starts at None', (await value('#em-service-engineer')) === '');
  ok('and no warning, because there are engineers to pick', (await text('#em-service-engineer-note')) === '');
  await page.fill('#em-customer', 'Topworth Urja');
  await page.selectOption('#em-service-engineer', 'suresh@pie.in');
  await page.click('#btn-save-enquiry');
  await page.waitForTimeout(600);
  const savedEnq = await lastArgs('saveSpareEnquiry');
  ok('the save sends the engineer picked', savedEnq && savedEnq[0].serviceEngineerEmail === 'suresh@pie.in',
    savedEnq && savedEnq[0]);

  // ------------------------------------------------------------- 2. the enquiry list
  console.log('\nTHE ENQUIRY LIST NAMES THE ENGINEER');
  await go('enquiries');
  await page.waitForTimeout(300);
  const heads = await page.$$eval('#view-enquiries thead th', (ths) => ths.map((t) => t.textContent.trim()));
  ok('a Service Engineer column', heads.indexOf('Service Engineer') !== -1, heads);
  const firstRow = await page.$eval('#enquiries-tbody tr', (tr) => tr.textContent);
  ok('showing the name, not the address', /Ravi Kumar/.test(firstRow) && !/ravi@pie\.in/.test(firstRow),
    firstRow);
  await page.fill('#enquiry-search', 'ravi');
  await page.waitForTimeout(200);
  const found = await page.$$eval('#enquiries-tbody tr', (trs) => trs.map((t) => t.textContent));
  ok('and the list can be searched by the engineer',
    found.length === 1 && /SE2610-0001/.test(found[0]), found);
  await page.fill('#enquiry-search', '');
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('[data-open-enq="SE-1"]').click());
  await page.waitForTimeout(400);
  ok('an enquiry opens with its engineer chosen', (await value('#em-service-engineer')) === 'ravi@pie.in',
    await value('#em-service-engineer'));
  await page.click('#btn-cancel-enquiry');

  // ------------------------------------------------------------- 3. the lead
  console.log('\nTHE COMPRESSOR LEAD THE SAME');
  await go('compressor');
  await page.waitForTimeout(400);
  const leadHeads = await page.$$eval('#cs-thead th', (ths) => ths.map((t) => t.textContent.trim()));
  ok('the lead list has a Service Engineer column', leadHeads.indexOf('Service Engineer') !== -1, leadHeads);
  ok('showing the name', /Suresh Patil/.test(await text('#cs-tbody')), await text('#cs-tbody'));
  await page.evaluate(() => document.querySelector('[data-open-lead="LD-1"]').click());
  await page.waitForTimeout(500);
  ok('the lead form has its own box for the service engineer, beside the sales engineer',
    (await page.$('#lm-service-engineer')) !== null && (await page.$('#lm-engineer')) !== null);
  ok('holding the engineer already on the lead', (await value('#lm-service-engineer')) === 'suresh@pie.in',
    await value('#lm-service-engineer'));
  await page.selectOption('#lm-service-engineer', 'ravi@pie.in');
  await page.click('#btn-save-lead');
  await page.waitForTimeout(600);
  const savedLead = await lastArgs('saveLead');
  ok('the save sends the change', savedLead && savedLead[0].serviceEngineerEmail === 'ravi@pie.in',
    savedLead && savedLead[0]);

  // ------------------------------------------------------------- 4. the report
  console.log('\nLEADS BY ENGINEER');
  const navLabel = await page.$eval('#tabs [data-view="engineers"]', (b) => b.textContent.trim());
  ok('the report is on the menu', /Leads by Engineer/.test(navLabel), navLabel);
  await go('engineers');
  await page.waitForTimeout(400);
  ok('the screen opens', await shown('#view-engineers'));
  const asked = await lastArgs('getEngineerLeadsReport');
  const fy = await page.evaluate(() => {
    const d = new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return { from: y + '-04-01', to: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) };
  });
  ok('it opens on this financial year, April to today',
    asked && asked[0].from === fy.from && asked[0].to === fy.to, { asked: asked && asked[0], fy });

  const tables = await page.$$eval('#er-summary table', (ts) => ts.length);
  ok('a table for each stream', tables === 2, tables);
  const summary = await text('#er-summary');
  ok('headed Spare Sales and Compressor Sales', /Spare Sales/.test(summary) && /Compressor Sales/.test(summary));
  const raviLine = await page.$eval('#er-summary table tbody tr', (tr) =>
    Array.from(tr.children).map((td) => td.textContent.trim()));
  ok('each engineer on a line: name, enquiries, quoted, value, ordered, value, invoiced',
    raviLine[0] === 'Ravi Kumar' && raviLine[1] === '2' && raviLine[2] === '1' &&
    /9,000/.test(raviLine[3]) && raviLine[4] === '1' && /9,010/.test(raviLine[6]), raviLine);
  ok('enquiries with no engineer have a line of their own', /Not from a service engineer/.test(summary));
  const unitHeads = await page.$$eval('#er-summary table', (ts) =>
    Array.from(ts[1].querySelectorAll('th')).map((t) => t.textContent.trim()));
  ok('the compressor table counts conversions too', unitHeads.indexOf('Converted') !== -1, unitHeads);
  const lastLine = await page.$eval('#er-summary table tbody tr:last-child', (tr) => tr.textContent);
  ok('and ends on a total', /^Total/.test(lastLine.trim()), lastLine);

  const allRows = await page.$$eval('#er-tbody tr', (trs) => trs.length);
  ok('every enquiry and lead is listed below', allRows === 3, allRows);
  await page.evaluate(() => document.querySelector('#er-summary [data-er-pick="ravi@pie.in"]').click());
  await page.waitForTimeout(200);
  ok('pressing an engineer narrows the list to theirs', (await value('#er-engineer')) === 'ravi@pie.in' &&
    (await page.$$eval('#er-tbody tr', (trs) => trs.length)) === 1 && /SE\/1/.test(await text('#er-tbody')));
  await page.selectOption('#er-engineer', '-');
  await page.waitForTimeout(200);
  ok('and None shows the ones nobody generated', /SE\/3/.test(await text('#er-tbody')) &&
    (await page.$$eval('#er-tbody tr', (trs) => trs.length)) === 1);
  await page.selectOption('#er-engineer', '');
  await page.waitForTimeout(200);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.evaluate(() => document.querySelector('#btn-er-download').click())
  ]);
  const file = fs.readFileSync(await download.path(), 'utf8');
  const fileLines = file.replace(/^﻿/, '').trim().split(/\r\n/);
  ok('the download is a file Excel opens', /\.csv$/.test(download.suggestedFilename()) &&
    file.charCodeAt(0) === 0xfeff, download.suggestedFilename());
  ok('with the column headings', fileLines[0] === '"Service engineer","Ref no.","Customer","Quoted value (Rs)"',
    fileLines[0]);
  ok('a row for each one on screen', fileLines.length === 4, fileLines);
  ok('the ones with no engineer say so in the file', fileLines.some((l) =>
    /^"Not from a service engineer","SE\/3"/.test(l)), fileLines);
  ok('money as a number Excel can add', fileLines.some((l) => /,9000$/.test(l)), fileLines);

  await page.selectOption('#er-period', 'month');
  await page.waitForTimeout(400);
  const monthAsk = await lastArgs('getEngineerLeadsReport');
  ok('This month asks from the first of the month', monthAsk && /-01$/.test(monthAsk[0].from) &&
    monthAsk[0].from.slice(0, 7) === fy.to.slice(0, 7), monthAsk && monthAsk[0]);
  await page.selectOption('#er-period', 'all');
  await page.waitForTimeout(400);
  const allAsk = await lastArgs('getEngineerLeadsReport');
  ok('All time asks with no dates', allAsk && allAsk[0].from === '' && allAsk[0].to === '', allAsk && allAsk[0]);

  const navIcon = await page.evaluate(() => {
    if (!document.querySelector('#tabs .nav-ico')) return 'no icons in this design';
    const b = document.querySelector('#tabs [data-view="engineers"] .nav-ico');
    return b && /m16 11 2 2 4-4/.test(b.innerHTML) ? 'own icon' : 'missing';
  });
  ok('in the new design the menu entry has its own icon', navIcon !== 'missing', navIcon);
  ok('no page errors', errors.length === 0, errors);
  await page.close();

  // ------------------------------------------------------------- 5. nobody to pick
  console.log('\nWITH NO SERVICE ENGINEERS ON THE USER LIST');
  const bare = await context.newPage();
  const bareErrors = [];
  bare.on('pageerror', (e) => bareErrors.push(String(e)));
  await bare.goto('file://' + PREVIEW);
  await bare.waitForTimeout(1200);
  await bare.evaluate((report) => {
    window.__data.getEngineerLeadsReport = function (input) {
      return Object.assign({}, report, { from: input.from, to: input.to, engineers: [],
        showUnits: false, rows: report.rows.filter((r) => r.stream === 'Spare Sales' && !r.engineerEmail) });
    };
  }, REPORT);
  await bare.evaluate(() => document.querySelector('[data-view="enquiries"]').click());
  await bare.waitForTimeout(500);
  await bare.click('#btn-new-enquiry');
  await bare.waitForTimeout(400);
  const bareNote = await bare.$eval('#em-service-engineer-note', (e) => e.textContent);
  ok('the form says where engineers are added', /Settings/.test(bareNote) && /Service Engineer/.test(bareNote),
    bareNote);
  ok('and still offers None', (await bare.$$eval('#em-service-engineer option', (os) => os.length)) === 1);
  await bare.click('#btn-cancel-enquiry');
  await bare.evaluate(() => document.querySelector('[data-view="engineers"]').click());
  await bare.waitForTimeout(500);
  const bareSummary = await bare.$eval('#er-summary', (e) => e.textContent);
  ok('the report says so too', /Settings/.test(bareSummary), bareSummary);
  ok('a Spare Sales coordinator sees only the spare table',
    (await bare.$$eval('#er-summary table', (ts) => ts.length)) === 1 && !/Compressor Sales/.test(bareSummary));
  ok('no page errors here either', bareErrors.length === 0, bareErrors);

  await browser.close();
  try { fs.unlinkSync(copy); } catch (e) { /* left for a look */ }
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack); process.exit(1); });
