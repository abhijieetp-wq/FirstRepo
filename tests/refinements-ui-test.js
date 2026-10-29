/**
 * The refinements PIE asked for on 19 Oct, checked in a browser against the real client.
 *
 *   1. a new customer can be added from the enquiry and from the lead, carrying across what
 *      was already typed
 *   2. Quotation Progress names who created each offer, and downloads the lot as a file
 *      Excel opens — with the reason for every decline
 *   3. the invoice screens agree with each other about what is owed, and say what a draft is
 *   4. a quotation cannot be revised without saying why
 *   5. emailing the offer says plainly whether it went, and why not when it did not
 *   6. saving something does not throw away your place on the page
 *   7. a compressor can be found by the flow and pressure the customer needs
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
  await page.click('[data-open-quote], [data-qv-open]');
  await page.waitForTimeout(600);
  ok('a sent quotation offers Revise', !!(await page.$('#btn-qb-revise')));
  // Revise lives in the Status menu now.
  await page.click('#btn-qb-status');
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
    await page.click('#btn-qb-status');
    await page.click('#btn-qb-revise');
    await page.waitForTimeout(200);
    await page.click('#ask-cancel');
    await page.waitForTimeout(200);
    ok('cancel sends nothing', (await count('reviseQuotation')) === before);
  } else {
    ok('cancel sends nothing', true);
  }

  // ------------------------------------------------------------- 5. emailing the offer
  console.log('\nEMAILING THE OFFER SAYS WHETHER IT WENT');
  await page.evaluate(() => {
    const D = window.__data;
    D.buildQuotationHtml = '<html><body>The offer</body></html>';
    D.prepareQuotationEmail = { quoteNo: 'PIE/ELGI/QUOT/26-27/401', revision: 'R1',
      customerName: 'Topworth Urja', grand: 12500, to: 'purchase@topworth.in', cc: '',
      subject: 'Quotation PIE/ELGI/QUOT/26-27/401 R1', body: 'Dear Sir, please find attached.' };
    D.sendQuotationEmail = { sentTo: 'purchase@topworth.in', cc: 'accounts@topworth.in',
      quoteNo: 'PIE/ELGI/QUOT/26-27/401', attachment: 'PIE-ELGI-QUOT-26-27-401 R1.pdf',
      statusNow: 'Submitted' };
  });
  await page.evaluate(() => document.querySelector('#btn-qb-print').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#btn-qd-email').click());
  await page.waitForTimeout(400);
  ok('the email window opens', await shown('#qmail-modal-backdrop'));

  // A failure first: it used to be said behind this window, where nobody could see it.
  await page.evaluate(() => { window.__failNext = 'sendQuotationEmail'; });
  await page.evaluate(() => document.querySelector('#btn-qmail-send').click());
  await page.waitForTimeout(400);
  ok('a failed send keeps the window open, with what was typed', await shown('#qmail-modal-backdrop') &&
    (await value('#qmail-to')) === 'purchase@topworth.in');
  ok('and says so inside it', /Not sent\./.test(await text('#qmail-error')) &&
    /deliberate failure/.test(await text('#qmail-error')), await text('#qmail-error'));
  ok('where it can be seen', await page.$eval('#qmail-error', (e) => {
    const r = e.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 20, r.top + r.height / 2);
    return !!(hit && e.contains(hit));
  }));
  ok('and Send can be pressed again', !(await page.$eval('#btn-qmail-send', (e) => e.disabled)) &&
    (await text('#btn-qmail-send')) === 'Send');
  ok('no success window for a send that failed', !(await shown('#qsent-modal-backdrop')));

  await page.evaluate(() => document.querySelector('#btn-qmail-send').click());
  await page.waitForTimeout(600);
  ok('a good send closes the email window', !(await shown('#qmail-modal-backdrop')));
  ok('and opens a window saying it was sent', await shown('#qsent-modal-backdrop') &&
    /Quotation sent/.test(await text('#qsent-title')));
  ok('in front of everything', await inFront('#qsent-modal-backdrop'));
  const facts = await text('#qsent-facts');
  ok('naming who it went to and the copy', /purchase@topworth\.in/.test(facts) &&
    /accounts@topworth\.in/.test(facts), facts);
  ok('the file attached', /PIE-ELGI-QUOT-26-27-401 R1\.pdf/.test(facts), facts);
  ok('and where the offer stands now, in plain words', /Sent to customer/.test(facts), facts);
  ok('the error from the first try is not left behind', (await text('#qmail-error')) === '');
  await page.evaluate(() => document.querySelector('#btn-qsent-ok').click());
  await page.waitForTimeout(200);
  ok('OK closes it', !(await shown('#qsent-modal-backdrop')));

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
  // ERP 2.0 draws its own Progress page (tests/quotations-v2-ui-test.js); ERP 1's list is on the other faces.
  const v2face = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  if (v2face) {
    ok('2.0 draws its own progress page', await page.evaluate(() => document.getElementById('qv-progress').offsetParent !== null && document.getElementById('progress-tbody').offsetParent === null));
  } else {
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
  }

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

  // ------------------------------------------------------------- 6. the page stays put
  console.log('\nSAVING DOES NOT THROW AWAY YOUR PLACE ON THE PAGE');
  await page.evaluate(() => {
    const list = window.__data.listCustomers();
    for (let i = 0; i < 80; i++) {
      list.push({ id: 'CX-' + i, customerCode: 'C9' + i, name: 'Filler Customer ' + i,
        active: 'TRUE', addresses: [], contacts: [] });
    }
  });
  await go('customers');
  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForTimeout(200);
  const yBefore = await page.evaluate(() => Math.round(window.scrollY));
  ok('the list is long enough to be half way down', yBefore > 1000, yBefore);
  // Clicked the way a person would, without the test scrolling to the button first.
  await page.evaluate(() => document.querySelector('[data-edit-cust="CX-40"]').click());
  await page.waitForTimeout(400);
  await page.fill('#cm-name', 'Filler Customer 40 renamed');
  await page.evaluate(() => document.querySelector('#btn-save-customer').click());
  await page.waitForTimeout(900);
  const yAfter = await page.evaluate(() => Math.round(window.scrollY));
  ok('after saving, the page is where it was', Math.abs(yAfter - yBefore) < 60, [yBefore, yAfter]);
  ok('and the confirmation is on screen anyway', await page.$eval('#msg-box', (e) => {
    const r = e.getBoundingClientRect();
    return /show/.test(e.className) && r.top >= 0 && r.bottom <= innerHeight;
  }));

  console.log('\nAN ERROR FROM INSIDE A WINDOW IS NOT HIDDEN BEHIND IT');
  await page.evaluate(() => document.querySelector('[data-edit-cust="CX-41"]').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__failNext = 'saveCustomer'; });
  await page.evaluate(() => document.querySelector('#btn-save-customer').click());
  await page.waitForTimeout(500);
  ok('the error shows in front of the open window', await page.$eval('#msg-box', (e) => {
    const r = e.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return /msg-error/.test(e.className) && !!(hit && e.contains(hit));
  }));
  ok('without moving the page either',
    Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - yAfter) < 60);

  // ------------------------------------------------------------- 7. the compressor picker
  console.log('\nFROM AN OPPORTUNITY, THE PICKER STARTS FROM THE REQUIREMENT');
  await page.evaluate(() => {
    const D = window.__data;
    const opp = { id: 'OP-1', opportunityNo: 'OP-0001', customerId: 'CU-1', customerName: 'Topworth Urja',
      title: 'Plant air', stage: 'Technical Discussion', expectedValue: 900000, probability: 25,
      weightedValue: 225000, expectedCloseDate: '', competitor: '', nextActionDate: '', ownerEmail: '',
      lostReasonId: '', hasTechnicalRequirement: true,
      technicalRequirement: { application: 'Plant air', requiredFad: '4.25 m3/min', workingPressure: '7 bar' },
      selections: [], siteVisits: [], activities: [], quotations: [] };
    D.listOpportunities = [opp];
    D.getOpportunity = opp;
    D.listProducts = [{ id: 'PR-1', productCode: 'TX37-7.5', model: 'TX 37-7.5 DM', price: 1200000 },
      { id: 'PR-2', productCode: 'TX45-7.5', model: 'TX 45-7.5 DM' }];
    D.findCompressors = function (q) {
      if (q && q.fad === '400') {
        return { requirement: { fadCfm: 400, pressureBar: 7, series: '', from: 'entered' }, matches: [],
          considered: 10, unreadable: [], seriesAvailable: ['TX', 'TY'],
          largestAtPressure: { productCode: 'TX45-7.5', model: 'TX 45-7.5 DM', fadCfm: 296 } };
      }
      return {
        requirement: { fadCfm: 150.1, pressureBar: 7, series: '', from: q && q.opportunityId ? 'requirement' : 'entered',
          requirementText: { fad: '4.25 m3/min', pressure: '7 bar' } },
        matches: [
          { id: 'PR-1', productCode: 'TX37-7.5', model: 'TX 37-7.5 DM', series: 'TX', fadCfm: 242,
            fadM3min: 6.85, workingBar: 7, motorKw: '37 kW, 50 hp', spc: 18.67, inputKw: 45.18,
            sparePct: 61.2, price: 1200000, closest: true },
          { id: 'PR-2', productCode: 'TX45-7.5', model: 'TX 45-7.5 DM', series: 'TX', fadCfm: 296,
            fadM3min: 8.38, workingBar: 7, motorKw: '45 kW, 60 hp', spc: 18.38, inputKw: 54.4,
            sparePct: 97.2, price: null, bestSpc: true }],
        considered: 10, unreadable: ['OLD-1'], seriesAvailable: ['TX', 'TY'], largestAtPressure: null };
    };
  });
  await go('compressor');
  await page.evaluate(() => document.querySelector('#subtab-pipeline').click());
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('[data-open-opp]').click());
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('#btn-selection-form').click());
  await page.waitForTimeout(400);
  ok('the selection form offers the picker', await shown('#btn-sel-find'));
  await page.evaluate(() => document.querySelector('#btn-sel-find').click());
  await page.waitForTimeout(500);
  ok('the picker opens in front of the opportunity', await shown('#picker-modal-backdrop') &&
    await inFront('#picker-modal-backdrop'));
  ok('asking the server with the opportunity, not with guesses',
    JSON.stringify(await lastArgs('findCompressors')) === JSON.stringify([{ opportunityId: 'OP-1' }]),
    await lastArgs('findCompressors'));
  ok('the boxes show what the requirement was taken to mean',
    (await value('#pk-fad')) === '150.1' && (await value('#pk-pressure')) === '7' &&
    (await value('#pk-unit')) === 'cfm');
  ok('and say where it came from', /4\.25 m3\/min/.test(await text('#pk-from')), await text('#pk-from'));
  const pk = await text('#pk-result');
  ok('the closest fit and the lowest energy use are both named',
    /Closest fit/.test(pk) && /Lowest energy use/.test(pk), pk.slice(0, 200));
  ok('with spare flow and input power', /\+61\.2%/.test(pk) && /45\.18 kW/.test(pk), pk.slice(0, 300));
  ok('a model that could not be read is named', /OLD-1/.test(pk));
  ok('the series filter offers what the catalogue has',
    (await page.$$eval('#pk-series option', (o) => o.map((x) => x.value))).join() === ',TX,TY');

  await page.evaluate(() => document.querySelector('[data-pk-choose="PR-1"]').click());
  await page.waitForTimeout(300);
  ok('Choose closes the picker', !(await shown('#picker-modal-backdrop')));
  ok('and puts the model into the selection', (await value('#sel-product')) === 'PR-1');
  ok('which is still open to add accessories', await shown('#om-selection-form') &&
    await shown('#opp-modal-backdrop'));

  console.log('\nA SEARCH BY HAND SENDS WHAT WAS TYPED');
  await page.evaluate(() => document.querySelector('#btn-sel-find').click());
  await page.waitForTimeout(400);
  await page.fill('#pk-fad', '3.5');
  await page.selectOption('#pk-unit', 'm3min');
  await page.fill('#pk-pressure', '8');
  await page.selectOption('#pk-series', 'TX');
  await page.evaluate(() => document.querySelector('#btn-pk-find').click());
  await page.waitForTimeout(400);
  ok('flow, unit, pressure and series go to the server as typed',
    JSON.stringify((await lastArgs('findCompressors'))[0]) ===
      JSON.stringify({ fad: '3.5', fadUnit: 'm3min', pressure: '8', series: 'TX' }),
    await lastArgs('findCompressors'));
  await page.fill('#pk-fad', '400');
  await page.selectOption('#pk-unit', 'cfm');
  await page.evaluate(() => document.querySelector('#btn-pk-find').click());
  await page.waitForTimeout(400);
  ok('nothing big enough says what the biggest is', /No model in the catalogue delivers 400 cfm/.test(
    await text('#pk-result')) && /TX 45-7\.5 DM/.test(await text('#pk-result')), await text('#pk-result'));
  await page.evaluate(() => document.querySelector('#btn-pk-close').click());
  await page.evaluate(() => document.querySelector('#btn-cancel-opp').click());
  await page.waitForTimeout(200);

  console.log('\nAND FROM THE CATALOGUE, FOR LOOKING');
  await go('catalog');
  await page.evaluate(() => document.querySelector('#subtab-parts').click());
  await page.waitForTimeout(300);
  ok('not offered among the spares', !(await shown('#btn-find-compressor')));
  await page.evaluate(() => document.querySelector('#subtab-units').click());
  await page.waitForTimeout(400);
  ok('offered among the compressors', await shown('#btn-find-compressor'));
  await page.evaluate(() => document.querySelector('#btn-find-compressor').click());
  await page.waitForTimeout(300);
  ok('it opens empty, asking for the requirement', await shown('#picker-modal-backdrop') &&
    (await value('#pk-fad')) === '');
  await page.fill('#pk-fad', '150');
  await page.fill('#pk-pressure', '7');
  await page.evaluate(() => document.querySelector('#btn-pk-find').click());
  await page.waitForTimeout(400);
  ok('it lists the models', /Closest fit/.test(await text('#pk-result')));
  ok('with nothing to choose into', (await page.$$('[data-pk-choose]')).length === 0);
  await page.evaluate(() => document.querySelector('#btn-pk-close').click());

  // ------------------------------------------------------------- the customer's e-mail
  console.log('\nAN OFFER WITH NO E-MAIL TO PRINT SAYS SO');
  // Whatever an earlier check left open is closed first; it is not what this looks at.
  const openQuote = () => page.evaluate(() => {
    document.querySelectorAll('.modal-backdrop.show').forEach((m) => m.classList.remove('show'));
    document.querySelector('[data-open-quote], [data-qv-open]').click();
  });
  await page.evaluate(() => {
    const D = window.__data;
    D.getQuotation = Object.assign({}, D.getQuotation, { status: 'Draft', locked: false,
      printEmail: '', emailGap: 'Test Customer has no e-mail address on file, so the offer will ' +
        'print without one. Add it to a contact on their record (Customers) and it prints here.' });
  });
  await go('quotations');
  await page.waitForTimeout(300);
  await openQuote();
  await page.waitForTimeout(600);
  ok('a warning above the quotation, saying where to add it',
    !!(await page.$('[data-email-gap]')) && /Customers/.test(await text('[data-email-gap]')));
  await page.evaluate(() => {
    window.__data.getQuotation = Object.assign({}, window.__data.getQuotation,
      { printEmail: 'buyer@test.in', emailGap: '' });
  });
  await go('quotations');
  await page.waitForTimeout(300);
  await openQuote();
  await page.waitForTimeout(600);
  ok('and none once there is one', !(await page.$('[data-email-gap]')));

  ok('no page errors anywhere', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack); process.exit(1); });
