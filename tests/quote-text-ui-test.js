/**
 * Settings → Quotation Text: the compressor series a section is written for.
 *
 * The EG and the EQ have different scopes of supply, so a section can now be written for one
 * series. The field has to show what is there and send it back on every save: the form used to
 * leave "applies to" out entirely, and a save without it would have made the EG's text print on
 * every series the first time somebody corrected a typo in it.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview.html [--ui=web]
 *   node tests/quote-text-ui-test.js /tmp/preview.html
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
// A real picture to try the upload with, if given; otherwise one is drawn.
const PICTURE = process.argv[3];
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
  // The admin's dashboard has cards the shared fixture has no data for. It is not what this
  // tests, so its errors are not counted; any other is.
  page.on('pageerror', (e) => { if (!/renderDashboard/.test(e.stack || '')) errors.push(String(e)); });
  // Quotation text is edited by Management and the ERP Admin; the shared fixture signs in a
  // coordinator, who only reads it.
  const html = fs.readFileSync(PREVIEW, 'utf8');
  const admin = html.replace(/(bootstrap: \{[^}]*?role: )"Sales Coordinator"/, '$1"ERP Admin"');
  if (admin === html) throw new Error('could not make the fixture user an ERP Admin');
  const copy = PREVIEW.replace(/\.html$/, '') + '.admin.html';
  fs.writeFileSync(copy, admin);
  await page.goto('file://' + copy);
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    const scope = (id, series, title) => ({ id, section: 'ScopeOfSupply', brand: 'ELGI',
      businessStream: 'Compressor Sales', appliesTo: series, title, body: 'Controls System:\nController',
      sortOrder: 2, active: 'TRUE' });
    window.__data.getSettings = {
      brands: [], users: [], configLists: [], lostReasons: [], warehouses: [], roles: [],
      companyProfile: {}, tally: {}, system: { drift: [] },
      quoteSections: ['CoverLetter', 'ScopeOfSupply', 'Terms'],
      quoteTemplates: [scope('QTPL-COMP-SCOPE', '', 'Scope of supply'),
        scope('QTPL-COMP-SCOPE-EG', 'EG', 'Scope of supply')]
    };
    window.__data.saveQuoteTemplate = () => window.__data.getSettings.quoteTemplates;
  });
  await page.evaluate(() => document.querySelector('[data-view="settings"]').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#subtab-quotetext').click());
  await page.waitForTimeout(300);

  console.log('THE LIST SAYS WHICH SERIES A SECTION IS FOR');
  const rowText = (id) => page.$eval('[data-qtpl="' + id + '"]', (b) => b.closest('tr').textContent);
  ok('the EG scope is marked EG', /EG series/.test(await rowText('QTPL-COMP-SCOPE-EG')),
    await rowText('QTPL-COMP-SCOPE-EG'));
  ok('the general one is not marked', !/series/.test(await rowText('QTPL-COMP-SCOPE')));

  const saved = () => page.evaluate(() => {
    const c = window.__calls.filter((x) => x.fn === 'saveQuoteTemplate');
    return c.length ? c[c.length - 1].args[0] : null;
  });

  console.log('\nEDITING THE TEXT KEEPS ITS SERIES');
  await page.click('[data-qtpl="QTPL-COMP-SCOPE-EG"]');
  await page.waitForTimeout(200);
  ok('the form shows it', (await page.$eval('#qtpl-applies', (e) => e.value)) === 'EG');
  await page.fill('#qtpl-body', 'Controls System:\nNeuron IV controller');
  await page.click('#btn-save-qtpl');
  await page.waitForTimeout(300);
  let sent = await saved();
  ok('and sends it back with the edit', sent && sent.appliesTo === 'EG' && sent.id === 'QTPL-COMP-SCOPE-EG', sent);

  console.log('\nTHE GENERAL ONE STAYS GENERAL');
  await page.click('[data-qtpl="QTPL-COMP-SCOPE"]');
  await page.waitForTimeout(200);
  ok('an empty field, not the last one’s value', (await page.$eval('#qtpl-applies', (e) => e.value)) === '');
  await page.click('#btn-save-qtpl');
  await page.waitForTimeout(300);
  sent = await saved();
  ok('sent as blank — every series', sent && sent.appliesTo === '' && sent.id === 'QTPL-COMP-SCOPE', sent);

  console.log('\nA NEW SECTION FOR TWO SERIES');
  await page.evaluate(() => document.querySelector('#btn-add-qtpl').click());
  await page.waitForTimeout(200);
  ok('starts blank', (await page.$eval('#qtpl-applies', (e) => e.value)) === '');
  await page.selectOption('#qtpl-section', 'ScopeOfSupply');
  await page.fill('#qtpl-applies', ' eg, en ');
  await page.fill('#qtpl-body', 'Controls System:\nController');
  await page.click('#btn-save-qtpl');
  await page.waitForTimeout(300);
  sent = await saved();
  ok('sent in capitals, trimmed', sent && sent.appliesTo === 'EG, EN' && !sent.id, sent);

  console.log('\nTHE COMPRESSOR OFFER PICTURE, ON THE LETTERHEAD PANEL');
  await page.evaluate(() => { window.__data.saveCompanyProfile = (o) => o; window.__calls = []; });
  await page.evaluate(() => document.querySelector('#subtab-company').click());
  await page.waitForTimeout(300);
  ok('it has a place beside the logos', /Compressor Offer Picture/.test(await page.$eval('#set-panel', (e) => e.textContent)));
  // A wide picture, larger than it needs to be, the way one arrives from a brochure.
  const upload = PICTURE || null;
  if (upload) {
    await page.setInputFiles('#compressor-file', upload);
  } else {
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 1800; c.height = 620;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 1800, 620);
      g.addColorStop(0, '#eeeeee'); g.addColorStop(1, '#333333');
      x.fillStyle = g; x.fillRect(0, 0, 1800, 620);
      for (let i = 0; i < 40; i++) {
        x.fillStyle = ['#c00', '#111', '#ddd', '#888'][i % 4];
        x.fillRect((i * 97) % 1700, (i * 53) % 560, 80 + (i * 13) % 120, 40 + (i * 7) % 90);
      }
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'range.png', { type: 'image/png' }));
      const inp = document.querySelector('#compressor-file');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change'));
    });
  }
  await page.waitForTimeout(800);
  await page.click('#btn-save-company');
  await page.waitForTimeout(300);
  const co = await page.evaluate(() => {
    const c = window.__calls.filter((x) => x.fn === 'saveCompanyProfile');
    return c.length ? c[c.length - 1].args[0] : null;
  });
  const pic = co && co.compressorPictureUrl || '';
  ok('it is resized and saved with the letterhead', /^data:image\/(png|jpeg);base64,/.test(pic) && pic.length <= 48000,
    [pic.slice(0, 30), pic.length]);
  const dims = await page.evaluate((src) => new Promise((r) => {
    const i = new Image(); i.onload = () => r([i.width, i.height]); i.src = src;
  }), pic);
  ok('no wider than the page needs', dims[0] <= 900 && dims[1] <= 340, dims);
  ok('the logos travel with it untouched', co && 'logoUrl' in co && 'partnerLogoUrl' in co && 'sealUrl' in co);
  const panelText = await page.$eval('#set-panel', (e) => e.textContent);
  ok('the two installation drawings have their places too', /Air System Drawing/.test(panelText) &&
    /Placement Drawing/.test(panelText) && !!(await page.$('#airsystem-file')) && !!(await page.$('#placement-file')));
  ok('and are saved with the letterhead', co && 'airSystemPictureUrl' in co && 'placementPictureUrl' in co);

  ok('no page errors anywhere', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack); process.exit(1); });
