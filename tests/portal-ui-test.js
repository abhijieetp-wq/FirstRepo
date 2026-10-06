/**
 * The four screen behaviours shipped in 46528a7, which went out with no browser check because
 * the suite had been lost with its container. This is the check.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview.html
 *   node tests/portal-ui-test.js /tmp/preview.html
 */
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
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);

  const shown = (sel) => page.$eval(sel, (e) => getComputedStyle(e).display !== 'none');
  const calls = () => page.evaluate(() => (window.__calls || []).map((c) => c.fn));
  const lastArgs = (fn) => page.evaluate((f) => {
    const hits = (window.__calls || []).filter((c) => c.fn === f);
    return hits.length ? hits[hits.length - 1].args : null;
  }, fn);

  console.log('THE PORTAL OPENS');
  ok('the app is showing', await shown('#app'));
  ok('and the sign-in screen is not', !(await shown('#signin-screen')));

  // ---------------------------------------------------------------- the enquiry form

  console.log('\nA CUSTOMER CAN BE ADDED FROM THE ENQUIRY');
  await page.evaluate(() => document.querySelector('[data-view="enquiries"]').click());
  await page.waitForTimeout(400);
  await page.click('#btn-new-enquiry');
  await page.waitForTimeout(400);
  ok('the enquiry window is open', await shown('#enquiry-modal-backdrop'));
  // A spares offer can only begin as an enquiry, so a customer who is not on the books had no
  // way in at all — the form refused and named a tab somewhere else.
  ok('there is a way to add one', !!(await page.$('#em-new-customer')));
  await page.click('#em-new-customer');
  await page.waitForTimeout(400);
  ok('the customer window opened', await shown('#customer-modal-backdrop'));

  console.log('\nAND EVERYTHING ABOUT THEM FITS IN ONE SITTING');
  // It used to take three saves, two of them locked: the address form refused until the
  // customer existed, because an address needs a customerId.
  ok('the address form is already open', await shown('#cm-address-form'));
  ok('and so is the contact form', await shown('#cm-contact-form'));
  ok('their own save buttons are out of the way',
    !(await shown('#btn-save-address')) && !(await shown('#btn-save-contact')));
  ok('and the one button says what it does',
    (await page.$eval('#btn-save-customer', (e) => e.textContent.trim())) === 'Save Customer & Details',
    await page.$eval('#btn-save-customer', (e) => e.textContent.trim()));

  await page.fill('#cm-name', 'Plasflow Industries L.L.P');
  await page.fill('#af-line1', 'Plot No. 44, Beside Durga Mandir');
  await page.fill('#af-city', 'Nagpur');
  await page.fill('#cf-name', 'Mr Abhay Agrawal');
  await page.fill('#cf-phone', '9822737001');
  await page.click('#btn-save-customer');
  await page.waitForTimeout(700);

  const sent = await lastArgs('saveCustomerWithDetails');
  ok('one call carried all three', !!sent, await calls());
  ok('the customer', sent && sent[0].customer.name === 'Plasflow Industries L.L.P', sent);
  ok('their address', sent && sent[0].address.line1 === 'Plot No. 44, Beside Durga Mandir', sent);
  ok('and the person who rang', sent && sent[0].contact.name === 'Mr Abhay Agrawal', sent);
  ok('and it was not the old one-at-a-time save',
    (await calls()).indexOf('saveCustomerAddress') === -1, await calls());

  console.log('\nTHE WINDOW CLOSES, AND THE ENQUIRY HAS THEM');
  ok('the customer window is gone', !(await shown('#customer-modal-backdrop')));
  ok('the enquiry still has the name',
    (await page.$eval('#em-customer', (e) => e.value)) === 'Plasflow Industries L.L.P',
    await page.$eval('#em-customer', (e) => e.value));

  // ---------------------------------------------------------------- straight to the quote

  console.log('\nCREATE QUOTATION GOES STRAIGHT THERE, FROM AN UNSAVED ENQUIRY');
  ok('the button is offered before saving', await shown('#btn-quote-enquiry'));
  await page.fill('#em-requirement', 'Air oil separator');
  await page.click('#btn-quote-enquiry');
  await page.waitForTimeout(900);

  const seq = await calls();
  // Logging the call and quoting it are one intention. It used to mean save, close, find the
  // row, press again.
  ok('it saved the enquiry first', seq.indexOf('saveSpareEnquiry') !== -1, seq);
  ok('then raised the quotation', seq.indexOf('createQuotationFromEnquiry') !== -1, seq);
  ok('in that order',
    seq.indexOf('saveSpareEnquiry') < seq.indexOf('createQuotationFromEnquiry'), seq);
  ok('the enquiry window closed', !(await shown('#enquiry-modal-backdrop')));
  ok('and the quotation page is open',
    (await page.$eval('.view.active', (e) => e.id)) === 'view-quote',
    await page.$eval('.view.active', (e) => e.id));
  ok('showing the builder, not the start card', await shown('#qb-body'));
  ok('for the right offer',
    (await page.$eval('#qb-title', (e) => e.textContent)).indexOf('26-27/401') !== -1,
    await page.$eval('#qb-title', (e) => e.textContent));

  console.log('\nAND NOTHING IS FETCHED TWICE');
  // A wasted round trip is most of a second here. The directory guard only took effect once
  // the answer came back, so two forms opening together — a coordinator picker and an owner
  // picker on the same modal — each sent their own request for the same data.
  const all = await calls();
  const count = (fn) => all.filter((c) => c === fn).length;
  ok('the directory is asked for once', count('listPeople') === 1, all);
  ok('and so are the config lists', count('getConfigLists') <= 1, all);
  ok('and the user list', count('listActiveUsers') <= 1, all);

  ok('no page errors anywhere', errors.length === 0, errors);

  await browser.close();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})();
