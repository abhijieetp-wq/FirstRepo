/**
 * The Service Due Calls screen, in a browser against the real client.
 *
 *   - the weekly sheet is read from a real (deflated) .xlsx in the browser — headings found by
 *     name, Excel's date serials turned into days in India — and handed to the server;
 *   - the list shows where each machine stands, with the reasons highlighted;
 *   - a call is logged, for the customer's other machines too when asked;
 *   - closing as Not closed without a reason shows the server's refusal in the window;
 *   - the report downloads as an .xlsx with the reason cells styled.
 *
 * The .xlsx here is built by the test, with invented machines.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview.html [--ui=web]
 *   node tests/service-due-ui-test.js /tmp/preview.html
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

/** A small .xlsx the way Excel writes one: deflated, shared strings, dates as serial numbers. */
function sdrWorkbook() {
  const serial = (y, m, d, frac) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000 + (frac || 0);
  const strings = ['S.no', 'Dealer Name', 'Fabrication Number', 'Model', 'Customer Name', 'Warranty Type',
    'Comm Date', 'AF DUE DATE', 'OIL DUE DATE', 'Over Due', 'PREMIER INDIA ENTERPRISES - CU1P01781',
    'TXFAB001', 'TX 15-7.5', 'Testwell Agro Foods', 'Out of warranty', 'TXFAB002', 'TX 22-7.5'];
  const si = (t) => strings.indexOf(t);
  const s = (ref, t) => '<c r="' + ref + '" t="s"><v>' + si(t) + '</v></c>';
  const n = (ref, v) => '<c r="' + ref + '" s="1"><v>' + v + '</v></c>';
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1">' + ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((c, i) => s(c + '1', strings[i])).join('') + '</row>' +
    '<row r="2">' + n('A2', 1) + s('B2', strings[10]) + s('C2', 'TXFAB001') + s('D2', 'TX 15-7.5') +
      s('E2', 'Testwell Agro Foods') + s('F2', 'Out of warranty') +
      // 23 Jan 2022 18:30 UTC is 24 Jan in India; ELGi's dates come like that.
      n('G2', serial(2022, 1, 23, 0.770833333)) + n('H2', serial(2026, 8, 9, 0.770833333)) +
      n('I2', serial(2026, 11, 15)) + n('J2', 1) + '</row>' +
    // Column E missing on purpose: a blank cell is left out of the XML, as Excel does.
    '<row r="3">' + n('A3', 2) + s('C3', 'TXFAB002') + s('D3', 'TX 22-7.5') + s('F3', 'Out of warranty') +
      n('J3', 0) + '</row>' +
    '</sheetData></worksheet>';
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId7"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/data.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      strings.map((t) => '<si><t>' + t + '</t></si>').join('') + '</sst>',
    'xl/worksheets/data.xml': sheet
  };
  // Deflated, with the central directory at the end, as Excel writes it.
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const nm = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    local.push(lh, nm, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const STATUSES = ['To call', 'Called', 'Quotation prepared', 'Quotation sent', 'Following up',
  'PO received', 'Not closed', 'PO rejected'];
const call = (id, extra) => Object.assign({
  id, fabNo: 'FAB' + id, productModel: 'TX 15-7.5', sdrCustomerName: 'TESTWELL AGRO FOODS PVT LTD',
  customerId: 'CU-1', customerName: 'Topworth Urja', ownerEmail: 'p@pie.in', status: 'To call',
  dueParts: 'Overdue: AF · Next month: Oil', overdue: 'TRUE', followUpCount: 0, listedCount: 1,
  firstListDate: '2026-10-19', lastListDate: '2026-10-19', quoteValue: '', outcome: '',
  notClosedReason: '', poRejectedReason: '', callDate: '', nextFollowUpDate: ''
}, extra || {});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);

  await page.evaluate((args) => {
    const [STATUSES, calls] = args;
    const D = window.__data;
    const screen = {
      lists: [{ id: 'SDL-1', listDate: '2026-10-19', machineCount: 438 }],
      calls, coordinators: [{ email: 'p@pie.in', name: 'Priya' }, { email: 'd@pie.in', name: 'Dhriti' }],
      statuses: STATUSES, responses: ['Needs spares', 'Not now'], modes: ['Call', 'WhatsApp'],
      followUpLimit: 6, me: 'p@pie.in', canEdit: true
    };
    D.getServiceDueScreen = () => screen;
    D.getServiceDueCall = (id) => Object.assign({}, calls.find((c) => c.id === id), {
      followUps: [], contacts: [{ id: 'CC-1', name: 'Mr Rao', phone: '9800000001', email: 'rao@x.in' }],
      siblings: id === '1' ? [{ id: '2', fabNo: 'FAB2', productModel: 'TX 22', dueParts: '' }] : []
    });
    D.saveServiceDueCall = (input) => Object.assign(D.getServiceDueCall(input.id), { status: 'Called', callDate: input.callDate,
      callResponse: input.callResponse });
    D.closeServiceDueCall = (input) => Object.assign(D.getServiceDueCall(input.id), { status: input.outcome,
      outcome: input.outcome, outcomeDate: '2026-10-27', notClosedReason: input.reason });
    D.importServiceDueList = (input) => ({ listId: 'SDL-2', listDate: input.listDate, machines: input.rows.length,
      added: input.rows.length, carried: 0, skipped: { dealer: 0 }, unmatchedCustomers: [] });
    D.assignServiceDueCalls = (ids, to) => ({ assigned: ids.length, ownerEmail: to });
    D.exportServiceDueReport = () => ({
      generatedAt: '2026-10-27T10:00:00Z',
      headers: ['Fab No', 'Customer', 'Status', 'Reason not closed', 'Reason PO rejected', 'Quotation value'],
      rows: [['FAB3', 'Topworth Urja', 'Not closed', 'Bought locally', '', 12500.5],
             ['FAB4', 'Topworth Urja', 'PO received', '', '', 20000]],
      reasonColumns: [3, 4], statusColumn: 2,
      summaryHeaders: ['Coordinator', 'Not closed'], summary: [['Priya', 1]]
    });
  }, [STATUSES, [
    call('1'),
    call('2', { fabNo: 'FAB2', overdue: 'FALSE', dueParts: 'Next month: AF' }),
    call('3', { status: 'Not closed', outcome: 'Not closed', notClosedReason: 'Bought from a local supplier',
      ownerEmail: 'd@pie.in', followUpCount: 6 }),
    call('4', { status: 'PO rejected', outcome: 'PO rejected', poRejectedReason: 'Price above budget',
      customerId: '', customerName: '', sdrCustomerName: 'UNKNOWN MILLS' })
  ]]);

  await page.evaluate(() => document.querySelector('[data-view="servicedue"]').click());
  await page.waitForTimeout(600);

  console.log('THE LIST');
  const rows = () => page.$$eval('#sdc-tbody tr[data-sdc]', (r) => r.map((x) => x.dataset.sdc));
  ok('every machine on it', (await rows()).length === 4, await rows());
  const tiles = await page.$$eval('.sdc-tile', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim().toLowerCase()));
  ok('a count for every stage', tiles[0] === 'all 4' && tiles.includes('to call 2') && tiles.includes('not closed 1') &&
    tiles.includes('po rejected 1'), tiles);
  ok('the reasons stand out on the list', await page.$$eval('.sdc-reason', (r) => r.map((x) => x.textContent)).then((t) =>
    t.length === 2 && /Bought from a local supplier/.test(t.join()) && /Price above budget/.test(t.join())));
  ok('a customer not in Customers is marked', /Not in Customers yet/.test(await page.textContent('#sdc-tbody')));
  ok('overdue parts in red', (await page.$$('.sdc-due .sdc-late')).length >= 1);
  await page.click('.sdc-tile[data-sdc-tile="Not closed"]');
  ok('a tile filters to its stage', JSON.stringify(await rows()) === '["3"]', await rows());
  await page.click('.sdc-tile[data-sdc-tile=""]');
  await page.selectOption('#sdc-owner', '__me');
  ok('Mine shows my calls', (await rows()).length === 3, await rows());
  await page.selectOption('#sdc-owner', '');
  await page.check('#sdc-overdue');
  ok('overdue only', !(await rows()).includes('2'), await rows());
  await page.uncheck('#sdc-overdue');
  await page.fill('#sdc-search', 'unknown');
  await page.waitForTimeout(100);
  ok('search finds by ELGi’s spelling of the name', JSON.stringify(await rows()) === '["4"]', await rows());
  await page.fill('#sdc-search', '');
  await page.waitForTimeout(100);

  console.log('\nHANDING CALLS OVER');
  await page.check('[data-sdc-tick="1"]');
  await page.check('[data-sdc-tick="2"]');
  ok('ticking shows the assign bar', await page.isVisible('#sdc-bulk') && /2 calls ticked/.test(await page.textContent('#sdc-bulk-count')));
  await page.selectOption('#sdc-bulk-owner', 'd@pie.in');
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#btn-sdc-assign');
  await page.waitForTimeout(400);
  const assigned = await page.evaluate(() => (window.__calls.find((c) => c.fn === 'assignServiceDueCalls') || {}).args);
  ok('assigned to who was picked', assigned && JSON.stringify(assigned[0].sort()) === '["1","2"]' && assigned[1] === 'd@pie.in', assigned);

  console.log('\nA CALL');
  await page.evaluate(() => document.querySelector('#sdc-tbody tr[data-sdc="1"] td:nth-child(2)').click());
  await page.waitForTimeout(500);
  ok('the call opens', await page.isVisible('#sdc-modal-backdrop') && /FAB1/.test(await page.textContent('#sdc-sub')));
  ok('the customer’s numbers, to ring', /9800000001/.test(await page.textContent('#sdc-contacts')));
  ok('and the offer to cover their other machine', await page.isVisible('#sdc-siblings-wrap') &&
    /FAB2/.test(await page.textContent('#sdc-siblings-text')));
  await page.selectOption('#sdc-call-response', 'Needs spares');
  await page.fill('#sdc-call-contact', 'Mr Rao');
  await page.check('#sdc-siblings');
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#btn-sdc-save-call');
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => (window.__calls.find((c) => c.fn === 'saveServiceDueCall') || {}).args);
  ok('the call is sent, with the contact matched and the other machine', saved && saved[0].callResponse === 'Needs spares' &&
    saved[0].contactId === 'CC-1' && JSON.stringify(saved[0].alsoIds) === '["2"]', saved);
  ok('and the window says so', /Call saved/.test(await page.textContent('#sdc-msg')));

  console.log('\nCLOSING');
  await page.click('[data-sdc-outcome="Not closed"]');
  ok('Not closed asks why', await page.isVisible('#sdc-reason'));
  await page.evaluate(() => { window.__failNext = 'closeServiceDueCall'; });
  await page.click('#btn-sdc-close-call');
  await page.waitForTimeout(300);
  ok('a refusal shows in the window, not behind it', /deliberate failure/.test(await page.textContent('#sdc-msg')));
  ok('and the form stays open to put it right', await page.isVisible('#sdc-reason'));
  await page.fill('#sdc-reason', 'Plant shut till March');
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#btn-sdc-close-call');
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => (window.__calls.find((c) => c.fn === 'closeServiceDueCall') || {}).args);
  ok('the reason goes with it', closed && closed[0].outcome === 'Not closed' && closed[0].reason === 'Plant shut till March', closed);
  ok('and shows highlighted', /Plant shut till March/.test(await page.textContent('#sdc-outcome .sdc-reason')));
  await page.click('#btn-sdc-close');

  console.log('\nTHE WEEKLY SHEET');
  await page.evaluate(() => { const m = document.querySelector('#msg-box'); if (m) m.classList.remove('show'); });
  await page.click('#btn-sdc-import');
  await page.fill('#sdc-import-date', '2026-10-26');
  await page.setInputFiles('#sdc-import-file', { name: 'SDR_TEST.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: sdrWorkbook() });
  await page.waitForFunction(() => /machines/.test(document.querySelector('#sdc-import-preview').textContent) ||
    document.querySelector('#sdc-import-msg').textContent, null, { timeout: 8000 });
  ok('read in the browser', /2 machines/.test(await page.textContent('#sdc-import-preview')),
    [await page.textContent('#sdc-import-preview'), await page.textContent('#sdc-import-msg')]);
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#btn-sdc-import-go');
  await page.waitForTimeout(500);
  const up = await page.evaluate(() => (window.__calls.find((c) => c.fn === 'importServiceDueList') || {}).args);
  const r0 = up && up[0].rows[0];
  ok('for the week picked', up && up[0].listDate === '2026-10-26' && up[0].fileName === 'SDR_TEST.xlsx', up && up[0].listDate);
  ok('headings found by name, shared strings read', r0 && r0.fabNo === 'TXFAB001' && r0.customerName === 'Testwell Agro Foods' &&
    r0.productModel === 'TX 15-7.5' && r0.dealerName === 'PREMIER INDIA ENTERPRISES - CU1P01781', r0);
  ok('Excel’s date serials as days in India — 18:30 UTC is the next morning',
    r0 && r0.commissionDate === '2022-01-24' && r0.dueDates.AF === '2026-08-10' && r0.dueDates.OIL === '2026-11-15', r0 && [r0.commissionDate, r0.dueDates]);
  ok('a blank cell is blank, not the next column’s value', up && up[0].rows[1].fabNo === 'TXFAB002' &&
    !up[0].rows[1].customerName && up[0].rows[1].warrantyType === 'Out of warranty', up && up[0].rows[1]);
  ok('the window closes and says what happened', !(await page.isVisible('#sdc-import-backdrop')) &&
    /2 new to call/.test(await page.textContent('#msg-box')));
  await page.click('#btn-sdc-import');
  await page.setInputFiles('#sdc-import-file', { name: 'other.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Name,Phone\nA,1\n') });
  await page.waitForTimeout(400);
  ok('a sheet that is not the report is refused, saying why', /no Fabrication Number column/.test(await page.textContent('#sdc-import-msg')) &&
    await page.isDisabled('#btn-sdc-import-go'));
  await page.setInputFiles('#sdc-import-file', { name: 'sdr.csv', mimeType: 'text/csv',
    buffer: Buffer.from('﻿Fabrication Number,Customer Name,AF DUE DATE\nCSV1,"Rao, Sons",09-08-2026\n') });
  await page.waitForTimeout(400);
  ok('a CSV reads too, commas in quotes and Indian dates', /1 machines/.test(await page.textContent('#sdc-import-preview')));
  await page.click('#btn-sdc-import-cancel');

  console.log('\nTHE REPORT');
  await page.evaluate(() => { const m = document.querySelector('#msg-box'); if (m) m.classList.remove('show'); });
  const dl = page.waitForEvent('download', { timeout: 10000 });
  await page.click('#btn-sdc-download');
  const file = await dl;
  ok('an .xlsx', /^Service due calls 2026-10-27\.xlsx$/.test(file.suggestedFilename()), file.suggestedFilename());
  const buf = fs.readFileSync(await file.path());
  const txt = buf.toString('utf8');
  ok('a zip, ending with its directory', buf.readUInt32LE(0) === 0x04034b50 && buf.readUInt32LE(buf.length - 22) === 0x06054b50);
  ok('two sheets: the calls and the summary', /xl\/worksheets\/sheet1\.xml/.test(txt) && /xl\/worksheets\/sheet2\.xml/.test(txt) &&
    /name="By coordinator"/.test(txt));
  ok('the reason cell styled as a reason', /<c r="D2" t="inlineStr" s="2"><is><t xml:space="preserve">Bought locally<\/t>/.test(txt));
  ok('Not closed picked out, PO received in green', /<c r="C2" t="inlineStr" s="4">/.test(txt) && /<c r="C3" t="inlineStr" s="3">/.test(txt));
  ok('numbers stay numbers', /<c r="F2"><v>12500\.5<\/v><\/c>/.test(txt));
  ok('the heading row frozen and filtered', /state="frozen"/.test(txt) && /<autoFilter ref="A1:F3"\/>/.test(txt));

  ok('no page errors anywhere', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack); process.exit(1); });
