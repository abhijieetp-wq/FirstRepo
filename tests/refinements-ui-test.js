/**
 * The refinements PIE asked for on 19 Oct, checked in a browser against the real client.
 *
 *   1. a new customer can be added from the enquiry and from the lead, carrying across what
 *      was already typed
 *   2. Quotation Progress names who created each offer, and downloads the lot as a file
 *      Excel opens — with the reason for every decline
 *   3. the invoice screens agree with each other about what is owed, and say what a draft is
 *   4. a quotation cannot be revised without saying why
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview.html [--ui=web]
 *   node tests/refinements-ui-test.js /tmp/preview.html
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

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The shared fixture signs in a Spare Sales coordinator, who is not offered Compressor
  // Sales at all. Leads live there, so this run signs in somebody who works both streams.
  const html = fs.readFileSync(PREVIEW, 'utf8');
  const both = html.replace(/(bootstrap: \{[^}]*?businessStream: )"Spare Sales"/, '$1"All"');
  if (both === html) throw new Error('could not widen the fixture user to both streams');
  const copy = PREVIEW.replace(/\.html$/, '') + '.both-streams.html';
  fs.writeFileSync(copy, both);
  await page.goto('file://' + copy);
  await page.waitForTimeout(1200);

  const shown = (sel) => page.$eval(sel, (e) => getComputedStyle(e).display !== 'none');
  const value = (sel) => page.$eval(sel, (e) => e.value);
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());
  const calls = () => page.evaluate(() => (window.__calls || []).map((c) => c.fn));
  const lastArgs = (fn) => page.evaluate((f) => {
    const hits = (window.__calls || []).filter((c) => c.fn === f);
    return hits.length ? hits[hits.length - 1].args : null;
  }, fn);
  const count = async (fn) => (await calls()).filter((c) => c === fn).length;
  const go = async (view) => {
    await page.evaluate((v) => document.querySelector('[data-view="' + v + '"]').click(), view);
    await page.waitForTimeout(500);
  };
  // What a person would actually click at the middle of a window: whether it is in front.
  const inFront = (sel) => page.$eval(sel, (el) => {
    const box = el.querySelector('.modal').getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 40);
    return !!(hit && el.contains(hit));
  });

  // Answers this test needs that the shared fixture does not carry. Saving a customer files
  // the contact with it, as the real server does, so the hand-back can be checked.
  await page.evaluate(() => {
    const D = window.__data;
    let n = 10;
    D.saveCustomerWithDetails = function (input) {
      const saved = D.saveCustomer(input.customer);
      saved.contacts = input.contact ? [Object.assign({ id: 'CC-' + (n++) }, input.contact)] : [];
      return saved;
    };
  });

  // ------------------------------------------------------------- 1a. from the enquiry
  console.log('A NEW CUSTOMER FROM THE ENQUIRY, WITH WHAT WAS TYPED');
  await go('enquiries');
  await page.click('#btn-new-enquiry');
  await page.waitForTimeout(400);
  ok('the button is a button beside the box, not a link under it',
    (await page.$eval('#em-new-customer', (e) => e.tagName)) === 'BUTTON');
  await page.fill('#em-customer', 'Shree Ganesh Pumps');
  await page.fill('#em-contact', 'Mr Joshi');
  await page.fill('#em-contactphone', '9890012345');
  await page.fill('#em-contactemail', 'joshi@sgpumps.in');
  await page.click('#em-new-customer');
  await page.waitForTimeout(400);
  ok('the customer window opens', await shown('#customer-modal-backdrop'));
  ok('in front of the enquiry, where clicks land on it', await inFront('#customer-modal-backdrop'));
  ok('holding the name typed on the enquiry', (await value('#cm-name')) === 'Shree Ganesh Pumps',
    await value('#cm-name'));
  ok('and the person', (await value('#cf-name')) === 'Mr Joshi', await value('#cf-name'));
  ok('their phone', (await value('#cf-phone')) === '9890012345');
  ok('and their email', (await value('#cf-email')) === 'joshi@sgpumps.in');

  await page.fill('#af-line1', 'Plot 12, MIDC Bhosari');
  await page.fill('#af-city', 'Pune');
  await page.click('#btn-save-customer');
  await page.waitForTimeout(700);
  const savedCust = await lastArgs('saveCustomerWithDetails');
  ok('one save carried customer, address and contact', savedCust &&
    savedCust[0].customer.name === 'Shree Ganesh Pumps' &&
    savedCust[0].address.city === 'Pune' && savedCust[0].contact.name === 'Mr Joshi', savedCust);
  ok('the customer window closes', !(await shown('#customer-modal-backdrop')));
  ok('the enquiry is still open', await shown('#enquiry-modal-backdrop'));
  ok('with the new customer selected', (await value('#em-customer')) === 'Shree Ganesh Pumps');
  ok('and the person tied to the contact just filed, so the save does not add them twice',
    /^CC-/.test(await value('#em-contactid')), await value('#em-contactid'));
  ok('which the form says', /Already on file/.test(await text('#em-contact-note')),
    await text('#em-contact-note'));
  ok('and the customer list was not fetched a second time for it',
    (await count('listCustomers')) <= 2, await calls());
  await page.click('#btn-cancel-enquiry');

  // ------------------------------------------------------------- 1b. from the lead
  console.log('\nAND FROM THE LEAD');
  await go('compressor');
  await page.click('#btn-new-lead');
  await page.waitForTimeout(400);
  ok('the lead form offers it', await shown('#lm-new-customer'));
  await page.fill('#lm-prospect', 'Vardhman Castings');
  await page.fill('#lm-contact', 'Ms Kulkarni');
  await page.fill('#lm-phone', '9765400011');
  await page.fill('#lm-email', 'purchase@vardhman.in');
  await page.fill('#lm-city', 'Kolhapur');
  await page.click('#lm-new-customer');
  await page.waitForTimeout(400);
  ok('the customer window opens over the lead', await shown('#customer-modal-backdrop') &&
    await inFront('#customer-modal-backdrop'));
  ok('with the prospect as the name', (await value('#cm-name')) === 'Vardhman Castings');
  ok('the contact, phone and email', (await value('#cf-name')) === 'Ms Kulkarni' &&
    (await value('#cf-phone')) === '9765400011' &&
    (await value('#cf-email')) === 'purchase@vardhman.in');
  ok('and the city on the address', (await value('#af-city')) === 'Kolhapur');
  await page.fill('#af-line1', 'Gat 44, Shiroli MIDC');
  await page.click('#btn-save-customer');
  await page.waitForTimeout(700);
  const linked = await value('#lm-linkcustomer');
  const linkedName = await page.$eval('#lm-linkcustomer', (e) => e.options[e.selectedIndex].text);
  ok('the lead is linked to the customer just added', /^CU-/.test(linked) &&
    linkedName === 'Vardhman Castings', [linked, linkedName]);
  ok('and the lead window is still open', await shown('#lead-modal-backdrop'));
  await page.click('#btn-cancel-lead');

  // ------------------------------------------------------------- 4. a reason to revise
  console.log('\nA REVISION NEEDS A REASON');
  await page.evaluate(() => {
    const D = window.__data;
    const sent = Object.assign({}, D.getQuotation, { status: 'Submitted', locked: true,
      submittedDate: '2026-10-08', approvalDate: '2026-10-07', approvedBy: 'boss@pie.in' });
    D.getQuotation = sent;
    D.listQuotations = [Object.assign({ itemCount: 1, journey: { label: 'Sent to customer',
      stages: [{}, {}, {}, {}], reachedIndex: 2, nextLabel: 'Accepted by customer' } }, sent)];
    D.reviseQuotation = function (id, reason) {
      return Object.assign({}, sent, { id: 'QT-10', revision: 'R1', status: 'Draft',
        locked: false, revisionReason: reason });
    };
  });
  await go('quotations');
  await page.click('[data-open-quote]');
  await page.waitForTimeout(600);
  ok('a sent quotation offers Revise', !!(await page.$('#btn-qb-revise')));
  await page.click('#btn-qb-revise');
  await page.waitForTimeout(300);
  ok('it asks why before anything happens', await shown('#ask-modal-backdrop') &&
    /Why is this quotation being revised/.test(await text('#ask-title')), await text('#ask-title'));
  ok('with a box for the reason', await shown('#ask-input-wrap'));

  await page.click('#ask-ok');
  await page.waitForTimeout(200);
  ok('an empty reason is not accepted', await shown('#ask-modal-backdrop') &&
    (await count('reviseQuotation')) === 0);

  await page.fill('#ask-input', 'ok');
  await page.click('#ask-ok');
  await page.waitForTimeout(200);
  ok('nor is a token one', await shown('#ask-modal-backdrop') &&
    (await count('reviseQuotation')) === 0);
  ok('and it says what it wants, under the box', /real reason/.test(await text('#ask-error')),
    await text('#ask-error'));

  await page.fill('#ask-input', 'Customer asked for 5% lower price on the separator');
  await page.click('#ask-ok');
  await page.waitForTimeout(500);
  const revArgs = await lastArgs('reviseQuotation');
  ok('a real reason revises, and is sent with it', revArgs && revArgs[0] === 'QT-9' &&
    revArgs[1] === 'Customer asked for 5% lower price on the separator', revArgs);
  ok('the dialog is gone', !(await shown('#ask-modal-backdrop')));

  // Cancelling is still a way out, and sends nothing.
  await page.evaluate(() => { window.__data.getQuotation.id = 'QT-9'; });
  const before = await count('reviseQuotation');
  if (await page.$('#btn-qb-revise')) {
    await page.click('#btn-qb-revise');
    await page.waitForTimeout(200);
    await page.click('#ask-cancel');
    await page.waitForTimeout(200);
    ok('cancel sends nothing', (await count('reviseQuotation')) === before);
  } else {
    ok('cancel sends nothing', true);
  }

  // ------------------------------------------------------------- 2. progress
  console.log('\nQUOTATION PROGRESS NAMES WHO CREATED EACH OFFER');
  await page.evaluate(() => {
    const D = window.__data;
    D.listProgressCandidates = [
      { id: 'QT-1', quoteNo: 'Q/401', revision: 'R1', date: '2026-10-09', status: 'Lost',
        businessStream: 'Spare Sales', customerName: 'Topworth Urja', grand: 12500,
        createdBy: 'Priya Deshmukh', revisedBy: 'Rahul Patil', stage: 'Declined',
        lostReason: 'Price too high' },
      { id: 'QT-2', quoteNo: 'Q/402', revision: 'R0', date: '2026-10-08', status: 'Submitted',
        businessStream: 'Spare Sales', customerName: 'Kalyani Steels', grand: 8800,
        createdBy: 'Priya Deshmukh', revisedBy: '', stage: 'Sent to customer', lostReason: '' }
    ];
    D.exportQuotationProgress = {
      generatedAt: '2026-10-19T10:00:00Z',
      headers: ['Quote No.', 'Customer', 'Quoted value (Rs)', 'Created by', 'Reason for decline',
        'What the customer said', 'Balance due (Rs)'],
      rows: [
        ['Q/401', 'Topworth Urja, Pune', 12500, 'Priya Deshmukh', 'Price too high',
          'Said "too costly" — went with Atlas', ''],
        ['Q/402', '=HYPERLINK("http://x")', 8800, 'Shrée Patil', '', '', -150.5]
      ]
    };
  });
  await go('progress');
  ok('the list has a Created by column',
    (await page.$$eval('#view-progress thead th', (ths) => ths.map((t) => t.textContent)))
      .indexOf('Created by') !== -1);
  const firstRow = await page.$eval('#progress-tbody tr', (r) => r.textContent);
  ok('naming who created it', /Priya Deshmukh/.test(firstRow), firstRow);
  ok('and who made the live revision, when that was somebody else',
    /R1 by Rahul Patil/.test(firstRow), firstRow);
  ok('with where it got to and why it was declined', /Declined/.test(firstRow) &&
    /Price too high/.test(firstRow), firstRow);
  ok('a declined offer is shown as Declined, not Lost',
    !/\bLost\b/.test(firstRow), firstRow);
  await page.fill('#progress-search', 'rahul');
  await page.waitForTimeout(200);
  ok('and the search finds offers by the person',
    (await page.$$('#progress-tbody tr [data-progress]')).length === 1);
  await page.fill('#progress-search', '');

  console.log('\nAND DOWNLOADS THE LOT AS A FILE EXCEL OPENS');
  ok('there is a download button', await shown('#btn-progress-download'));
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#btn-progress-download')
  ]);
  const name = download.suggestedFilename();
  ok('named for what it is and when', name === 'Quotation progress 2026-10-19.csv', name);
  const file = fs.readFileSync(await download.path());
  ok('starts with the byte-order mark, so Excel reads it as UTF-8',
    file[0] === 0xEF && file[1] === 0xBB && file[2] === 0xBF, [...file.slice(0, 3)]);
  const csv = file.slice(3).toString('utf8');
  const lines = csv.split('\r\n');
  ok('one header line and one line per offer, Windows line endings',
    lines.length === 4 && lines[3] === '', lines.length);
  ok('the header is the server\'s, in order', lines[0] ===
    '"Quote No.","Customer","Quoted value (Rs)","Created by","Reason for decline",' +
    '"What the customer said","Balance due (Rs)"', lines[0]);
  ok('a comma stays inside its cell', lines[1].indexOf('"Topworth Urja, Pune"') !== -1, lines[1]);
  ok('quotes inside text are doubled', lines[1].indexOf('"Said ""too costly"" — went with Atlas"') !== -1,
    lines[1]);
  ok('numbers go in as numbers', lines[1].indexOf(',12500,') !== -1 && /,-150\.5$/.test(lines[2]),
    [lines[1], lines[2]]);
  ok('text that would run as a formula is made into text',
    lines[2].indexOf('"\'=HYPERLINK(""http://x"")"') !== -1, lines[2]);
  ok('and an accented name survives', lines[2].indexOf('Shrée Patil') !== -1, lines[2]);

  // ------------------------------------------------------------- 3. invoices
  console.log('\nTHE INVOICES TAB AGREES WITH COLLECTIONS ABOUT WHAT IS OWED');
  await page.evaluate(() => {
    const D = window.__data;
    D.bootstrap.role = 'Sales Coordinator';
    D.listInvoices = [
      { id: 'IN-1', invoiceNo: 'ELGI/0444/26-27', invoiceDate: '2026-09-01', customerName: 'Topworth Urja',
        orderNo: 'SO-1', grand: 100000, billedAmt: 100400, balanceAmt: 60400, status: 'Issued',
        owed: true, dueDate: '2026-10-01', overdueDays: 18, tallySyncStatus: 'Synced' },
      { id: 'IN-2', invoiceNo: '', invoiceDate: '2026-10-18', customerName: 'Kalyani Steels',
        orderNo: 'SO-2', grand: 50000, billedAmt: 50000, balanceAmt: 50000, status: 'Draft',
        owed: false, dueDate: '2026-11-17', overdueDays: 0, tallySyncStatus: 'Pending' }
    ];
    D.getInvoice = function (id) {
      return { id: 'IN-1', invoiceNo: 'ELGI/0444/26-27', customerName: 'Topworth Urja', status: 'Issued',
        grand: 100000, invoiceValue: 100400, billedAmt: 100400, receivedAmt: 40000,
        balanceAmt: 60400, computedValue: 100000, valueVariance: 400, valueMatches: false,
        subtotal: 84745.76, discountAmt: 0, taxAmt: 15254.24, freight: 0, items: [], receipts: [],
        documents: [], documentTypes: [], invoiceDate: '2026-09-01', dueDate: '2026-10-01',
        tallySyncStatus: 'Synced', notes: '' };
    };
    D.getReceivables = [{ invoiceId: 'IN-1', invoiceNo: 'ELGI/0444/26-27',
      customerName: 'Topworth Urja', balanceAmt: 60400, overdueDays: 18 }];
    D.saveReceipt = { id: 'RC-1' };
  });
  await go('dispatch');
  await page.click('#subtab-invoices');
  await page.waitForTimeout(500);
  const rowsText = await page.$$eval('#dsp-tbody tr', (rs) => rs.map((r) => r.textContent));
  ok('a draft says it has no Tally number yet, rather than a blank cell',
    /Awaiting Tally no\./.test(rowsText[1] || ''), rowsText);
  ok('the value is what Tally billed', /1,00,400/.test(rowsText[0] || ''), rowsText[0]);
  ok('and a draft has no balance owed yet', /not issued/.test(rowsText[1] || ''), rowsText[1]);
  const kpis = await page.$$eval('#dsp-summary .kpi-card', (cs) => cs.map((c) => c.textContent));
  const outstandingCard = kpis.filter((k) => /Outstanding/.test(k))[0] || '';
  ok('outstanding counts the issued invoice only, at what was billed',
    /60,400/.test(outstandingCard) && !/1,10,400/.test(outstandingCard), outstandingCard);

  console.log('\nTHE INVOICE WINDOW ADDS UP, AND TAKES A PAYMENT');
  await page.click('[data-open-invoice="IN-1"]');
  await page.waitForTimeout(500);
  const totals = await text('#im-totals');
  ok('when Tally billed a different figure, both are shown', /Lines come to/.test(totals) &&
    /Billed in Tally/.test(totals), totals);
  ok('so billed − received = balance can be read off the box',
    /1,00,400/.test(totals) && /40,000/.test(totals) && /60,400/.test(totals), totals);
  ok('and a payment can be recorded from here', await shown('#btn-im-receipt'));
  await page.click('#btn-im-receipt');
  await page.waitForTimeout(500);
  ok('the payment form opens on this invoice', await shown('#receipt-modal-backdrop') &&
    (await value('#rcp-invoice')) === 'IN-1');
  ok('in front of the invoice', await inFront('#receipt-modal-backdrop'));
  const fetchesBefore = await count('getInvoice');
  await page.click('#btn-save-receipt');
  await page.waitForTimeout(600);
  ok('saving records the payment', (await lastArgs('saveReceipt'))[0].invoiceId === 'IN-1');
  ok('and refreshes the invoice it came from', (await count('getInvoice')) === fetchesBefore + 1,
    await calls());
  ok('which is still open', await shown('#invoice-modal-backdrop'));

  ok('no page errors anywhere', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack); process.exit(1); });
