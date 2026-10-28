/**
 * ERP 2.0's SDR rows, in a browser against the real client: each call worked where it sits on
 * the list — what the customer said, a remark, and the quotation with what it is for (Spares,
 * AMC renewal or Service) — without opening the call.
 *
 * Only the 2.0 face has them. Run against the current design, the same checks make sure the row
 * there is exactly ERP 1's: one Call column, no controls in it, and a spares quotation as before.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/sdr-rows-ui-test.js /tmp/base-v2.html
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-web.html --ui=web
 *   node tests/sdr-rows-ui-test.js /tmp/base-web.html
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

const STATUSES = ['To call', 'Called', 'Quotation prepared', 'Quotation sent', 'Following up',
  'PO received', 'Not closed', 'PO rejected'];
const call = (id, extra) => Object.assign({
  id, fabNo: 'FAB' + id, productModel: 'TX 15-7.5', sdrCustomerName: 'TESTWELL AGRO FOODS PVT LTD',
  customerId: 'CU-1', customerName: 'Topworth Urja', ownerEmail: 'p@pie.in', status: 'To call',
  dueParts: 'Overdue: AF', overdue: 'TRUE', followUpCount: 0, listedCount: 1,
  firstListDate: '2026-10-19', lastListDate: '2026-10-19', quoteValue: '', outcome: '',
  notClosedReason: '', poRejectedReason: '', callDate: '', callResponse: '', callNotes: '',
  contactName: '', contactId: '', nextFollowUpDate: '', quoteNo: '', enquiryType: ''
}, extra || {});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');

  await page.evaluate((args) => {
    const [STATUSES, calls] = args;
    const D = window.__data;
    const byId = {};
    calls.forEach((c) => { byId[c.id] = c; });
    D.getServiceDueScreen = () => ({
      lists: [{ id: 'SDL-1', listDate: '2026-10-19', machineCount: 5 }], calls: calls.map((c) => Object.assign({}, c)),
      coordinators: [{ email: 'p@pie.in', name: 'Priya' }], statuses: STATUSES,
      responses: ['Needs spares', 'Needs service', 'Not now'], modes: ['Call'], followUpLimit: 6,
      quoteTypes: ['Spares', 'AMC renewal', 'Service'], me: 'p@pie.in', canEdit: true
    });
    D.getServiceDueCall = (id) => Object.assign({}, byId[id], { followUps: [], siblings: [],
      contacts: [{ id: 'CC-1', name: 'Mr Rao', phone: '9800000001', email: 'rao@x.in' }] });
    // As the server does: a remark on its own changes only the remark; a response logs the call.
    D.saveServiceDueCall = (input) => {
      const c = byId[input.id];
      if (input.callResponse !== undefined) {
        Object.assign(c, { callResponse: input.callResponse, callDate: input.callDate, callNotes: input.callNotes || '',
          status: c.status === 'To call' ? 'Called' : c.status });
      } else if (input.callNotes !== undefined) {
        c.callNotes = input.callNotes;
      }
      return D.getServiceDueCall(input.id);
    };
    D.prepareServiceDueQuotation = (id, type) => ({ quotationId: 'QT-1', quoteNo: 'SPARE/26/0009',
      enquiryType: type || 'Spares', existing: false });
  }, [STATUSES, [
    call('1'),
    call('2', { status: 'Called', callDate: '2026-10-27', callResponse: 'Not now', callNotes: 'Plant shut' }),
    call('3', { status: 'Not closed', outcome: 'Not closed', notClosedReason: 'Bought locally', callNotes: 'Old remark',
      callDate: '2026-10-20', callResponse: 'Needs spares' }),
    call('4', { customerId: '', customerName: '', sdrCustomerName: 'UNKNOWN MILLS' }),
    call('5', { status: 'Quotation prepared', quoteNo: 'SPARE/26/0005', quotationId: 'QT-5', enquiryType: 'AMC renewal',
      callDate: '2026-10-26', callResponse: 'Needs service' })
  ]]);
  await page.evaluate(() => document.querySelector('[data-view="servicedue"]').click());
  await page.waitForTimeout(600);

  const heads = () => page.$$eval('#sdc-tbody', (b) => Array.from(b[0].parentNode.querySelectorAll('thead th')).map((t) => t.textContent.trim()));
  const lastCall = (fn) => page.evaluate((f) => {
    const all = window.__calls.filter((c) => c.fn === f);
    return all.length ? all[all.length - 1].args : null;
  }, fn);
  const open = () => page.evaluate(() => document.getElementById('sdc-modal-backdrop').classList.contains('show'));

  if (!v2) {
    console.log('THE CURRENT DESIGN KEEPS ERP 1’S ROW');
    ok('no controls in the rows', (await page.$$('#sdc-tbody .sdc-inline')).length === 0);
    const h = await heads();
    ok('one Call column, as before', h.length === 9 && h[5] === 'Call' && h.indexOf('Remark') === -1, h);
    ok('the call shown as text', /Not now/.test(await page.textContent('#sdc-tbody tr[data-sdc="2"]')));
    ok('no type shown on the quotation', (await page.$$('#sdc-tbody .sdc-type')).length === 0);
    ok('no type on the enquiry form', !(await page.$('#em-type')));
    await page.click('#sdc-tbody tr[data-sdc="1"] td:nth-child(2)');
    await page.waitForTimeout(300);
    ok('the call window opens from the row', await open());
    ok('and prepares a spares quotation, as before', !(await page.$('#sdc-quote-type')) &&
      (await page.textContent('#btn-sdc-quote')).trim() === 'Prepare spares quotation');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#btn-sdc-quote');
    await page.waitForTimeout(300);
    const args = await lastCall('prepareServiceDueQuotation');
    ok('with the call alone sent, nothing new', args && args.length === 1 && args[0] === '1', args);
  } else {
    console.log('THE LIST HEADS THE NEW COLUMNS');
    const h = await heads();
    ok('What they said and Remark, where Call was', h.length === 10 && h[5] === 'What they said' && h[6] === 'Remark' &&
      h[7] === 'Quotation', h);

    console.log('\nWHAT THEY SAID, PICKED ON THE ROW');
    const said1 = await page.$$eval('[data-sdc-resp="1"] option', (o) => o.map((x) => x.value));
    ok('an uncalled machine reads Not called yet, then the answers', JSON.stringify(said1) ===
      '["","Needs spares","Needs service","Not now"]', said1);
    ok('a called one shows what was said', await page.$eval('[data-sdc-resp="2"]', (s) => s.value) === 'Not now');
    ok('a closed call is text, not a control', !(await page.$('[data-sdc-resp="3"]')) && !(await page.$('[data-sdc-remark="3"]')) &&
      /Old remark/.test(await page.textContent('#sdc-tbody tr[data-sdc="3"]')));
    await page.click('[data-sdc-resp="1"]');
    await page.waitForTimeout(150);
    ok('pressing a control on the row does not open the call', !(await open()));
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__calls = []; });
    await page.selectOption('[data-sdc-resp="1"]', 'Needs spares');
    await page.waitForTimeout(300);
    const saved = (await lastCall('saveServiceDueCall') || [])[0] || {};
    const today = await page.evaluate(() => { const d = new Date();
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); });
    ok('logged as a call today, with the remark as it is', saved.id === '1' && saved.callResponse === 'Needs spares' &&
      saved.callDate === today && saved.callNotes === '', saved);
    ok('the row moves on to Called', /Called/.test(await page.textContent('#sdc-tbody tr[data-sdc="1"] td:last-child')));
    ok('and so do the counts', await page.$eval('.sdc-tile[data-sdc-tile="Called"] .kpi-value', (e) => e.textContent) === '2');
    ok('Not called yet is gone once it is', (await page.$$eval('[data-sdc-resp="1"] option', (o) => o.map((x) => x.value)))[0] === 'Needs spares');
    ok('it says it saved', /Saved: Needs spares/.test(await page.textContent('#msg-box')));
    ok('the call window stayed shut', !(await open()));

    console.log('\nA REMARK, TYPED ON THE ROW');
    await page.evaluate(() => { window.__calls = []; });
    await page.fill('[data-sdc-remark="2"]', 'Ring after Diwali');
    await page.press('[data-sdc-remark="2"]', 'Enter');
    await page.waitForTimeout(300);
    const remark = (await lastCall('saveServiceDueCall') || [])[0] || {};
    ok('kept on its own, without logging a call', remark.id === '2' && remark.callNotes === 'Ring after Diwali' &&
      remark.callResponse === undefined && remark.callDate === undefined, remark);
    ok('what they said is left as it was', await page.$eval('[data-sdc-resp="2"]', (s) => s.value) === 'Not now');
    await page.evaluate(() => { window.__calls = []; });
    await page.focus('[data-sdc-remark="2"]');
    await page.evaluate(() => document.querySelector('[data-sdc-remark="2"]').blur());
    await page.waitForTimeout(200);
    ok('leaving it unchanged sends nothing', !(await lastCall('saveServiceDueCall')));
    // Picking what they said, then typing a remark before the save comes back: the row is drawn
    // again under the cursor, and the typing must survive it.
    await page.evaluate(() => {
      document.querySelector('#sdc-tbody tr[data-sdc="2"]').__old = true;
      const s = document.querySelector('[data-sdc-resp="2"]');
      s.value = 'Needs service';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      const r = document.querySelector('[data-sdc-remark="2"]');
      r.focus();
      r.value = 'Ring after Diwali, ask for Mr Rao';
    });
    await page.waitForTimeout(300);
    ok('the row was drawn again', await page.evaluate(() => !document.querySelector('#sdc-tbody tr[data-sdc="2"]').__old &&
      document.querySelector('[data-sdc-resp="2"]').value === 'Needs service'));
    ok('a remark being typed survives the row being redrawn',
      await page.evaluate(() => { const r = document.querySelector('[data-sdc-remark="2"]');
        return r.value === 'Ring after Diwali, ask for Mr Rao' && document.activeElement === r; }));

    console.log('\nTHE QUOTATION AND WHAT IT IS FOR');
    const types = await page.$$eval('[data-sdc-quote="1"] option', (o) => o.map((x) => x.textContent));
    ok('Spares, AMC renewal or Service', JSON.stringify(types) === '["Quote…","Spares","AMC renewal","Service"]', types);
    ok('not before the customer is linked', !(await page.$('[data-sdc-quote="4"]')) &&
      /Link the customer first/.test(await page.textContent('#sdc-tbody tr[data-sdc="4"]')));
    ok('a quotation already made shows its number and what it is for',
      /SPARE\/26\/0005/.test(await page.textContent('#sdc-tbody tr[data-sdc="5"]')) &&
      (await page.textContent('#sdc-tbody tr[data-sdc="5"] .sdc-type')) === 'AMC renewal');
    await page.evaluate(() => { window.__calls = []; });
    await page.selectOption('[data-sdc-quote="1"]', 'AMC renewal');
    await page.waitForTimeout(500);
    const prep = await lastCall('prepareServiceDueQuotation');
    ok('raised with its type', prep && prep[0] === '1' && prep[1] === 'AMC renewal', prep);
    ok('and opened, saying what it is', /AMC renewal quotation SPARE\/26\/0009 raised for FAB1/.test(await page.textContent('#msg-box')) &&
      await page.evaluate(() => document.querySelector('.view.active').id) !== 'view-servicedue');

    console.log('\nTHE CALL WINDOW TOO');
    await page.evaluate(() => document.querySelector('[data-view="servicedue"]').click());
    await page.waitForTimeout(500);
    await page.click('#sdc-tbody tr[data-sdc="2"] td:nth-child(2)');
    await page.waitForTimeout(300);
    ok('opens from the row, away from its controls', await open());
    ok('asks what the quotation is for', JSON.stringify(await page.$$eval('#sdc-quote-type option', (o) => o.map((x) => x.value))) ===
      '["Spares","AMC renewal","Service"]' && (await page.textContent('#btn-sdc-quote')).trim() === 'Prepare quotation');
    await page.selectOption('#sdc-quote-type', 'Service');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#btn-sdc-quote');
    await page.waitForTimeout(400);
    const prep2 = await lastCall('prepareServiceDueQuotation');
    ok('and sends it', prep2 && prep2[0] === '2' && prep2[1] === 'Service', prep2);

    console.log('\nTHE ENQUIRY FORM');
    ok('asks what the quotation will be for', JSON.stringify(await page.$$eval('#em-type option', (o) => o.map((x) => x.value))) ===
      '["Spares","AMC renewal","Service"]');
  }
  ok('with no script errors', errors.length === 0, errors);

  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
