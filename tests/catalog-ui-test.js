/**
 * The catalogue at the size PIE's really is.
 *
 * It drew every row it had: 13,587 spares, rebuilt on each keystroke in the search, with two
 * click handlers attached to every row each time. Measured in a browser, opening it took 16.6
 * seconds and each letter typed 1.7 to 2.1 more. It now draws the first hundred matches and
 * offers more, waits for a pause in the typing, and handles every row's clicks with one
 * listener on the table. This checks that nothing was lost on the way: the count covers the
 * whole catalogue, the search reaches every row, and Compare and Edit still work.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview.html [--ui=web]
 *   node tests/catalog-ui-test.js /tmp/preview.html
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
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);

  const N = 1200;
  await page.evaluate((n) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({ id: 'SP-' + i, partNo: 'ELG-' + (100000 + i), description: 'Separator element ' + i,
        productGroup: ['Airend', 'Filters'][i % 2], category: 'Filter', uom: 'Nos', price: 500 + i,
        elgiPrice: 500 + i, onHand: 0, reserved: 0, available: 0, active: 'TRUE',
        alternates: [], compatibility: [] });
    }
    // One accessory with a specification table, for the part form below.
    Object.assign(rows[1], { specTitle: 'TX Air Dryer 300', specCapacity: '300 cfm' });
    window.__data.listSpares = rows;
  }, N);

  const drawn = () => page.$$eval('#catalog-tbody tr:not(.catalog-more)', (r) => r.length);
  const count = () => page.$eval('#catalog-count', (e) => e.textContent.trim());
  const moreText = () => page.$eval('#catalog-tbody', (t) => {
    const b = t.querySelector('[data-catalog-more]');
    return b ? b.textContent.trim() : '';
  });

  console.log('A SCREENFUL IS DRAWN, AND THE COUNT IS THE WHOLE CATALOGUE');
  const t0 = Date.now();
  await page.evaluate(() => document.querySelector('[data-view="catalog"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#catalog-tbody tr').length > 50);
  const openMs = Date.now() - t0;
  ok('the count is every spare', (await count()) === '1,200 spares', await count());
  ok('a hundred rows are drawn, not twelve hundred', (await drawn()) === 100, await drawn());
  ok('the table says there are more, and offers them', (await moreText()) === 'Show 500 more' &&
    /first 100 of 1,200/.test(await page.$eval('#catalog-tbody', (t) => t.textContent)), await moreText());
  ok('and it opens quickly', openMs < 3000, openMs);

  console.log('\nSHOW MORE SHOWS MORE, TO THE END');
  await page.evaluate(() => document.querySelector('[data-catalog-more]').click());
  await page.waitForTimeout(150);
  ok('five hundred more', (await drawn()) === 600, await drawn());
  await page.evaluate(() => document.querySelector('[data-catalog-more]').click());
  await page.waitForTimeout(150);
  ok('then the next five hundred', (await drawn()) === 1100 && (await moreText()) === 'Show 100 more',
    [await drawn(), await moreText()]);
  await page.evaluate(() => document.querySelector('[data-catalog-more]').click());
  await page.waitForTimeout(150);
  ok('then the last hundred, and no button left', (await drawn()) === 1200 && (await moreText()) === '');

  console.log('\nTHE SEARCH REACHES EVERY ROW, AND WAITS FOR A PAUSE');
  const redraws = await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const obs = new MutationObserver(() => { n++; });
    obs.observe(document.querySelector('#catalog-tbody'), { childList: true });
    const box = document.querySelector('#catalog-search');
    let i = 0;
    const word = 'ELG-10110';
    const tick = setInterval(() => {
      box.value = word.slice(0, ++i);
      box.dispatchEvent(new Event('input'));
      if (i === word.length) {
        clearInterval(tick);
        setTimeout(() => { obs.disconnect(); resolve(n); }, 400);
      }
    }, 40);
  }));
  ok('nine quick keystrokes, one redraw', redraws === 1, redraws);
  ok('finding rows from the far end of the catalogue', (await count()) === '10 of 1,200 spares' &&
    (await drawn()) === 10, [await count(), await drawn()]);
  await page.fill('#catalog-search', 'Separator');
  await page.waitForTimeout(350);
  ok('a new search starts from the top of its own results',
    (await drawn()) === 100 && (await count()) === '1,200 spares', [await drawn(), await count()]);

  console.log('\nCOMPARE AND EDIT STILL WORK, THROUGH ONE LISTENER');
  await page.fill('#catalog-search', 'ELG-10010');
  await page.waitForTimeout(350);
  const boxes = await page.$$('#catalog-tbody [data-compare]');
  ok('the rows can be ticked', boxes.length >= 2, boxes.length);
  await boxes[0].check();
  await boxes[1].check();
  await page.click('#btn-compare-selected');
  await page.waitForTimeout(200);
  ok('Compare shows the two ticked', /2 selected/.test(await page.$eval('#compare-strip-zone', (z) => z.textContent)),
    await page.$eval('#compare-strip-zone', (z) => z.textContent.slice(0, 80)));
  await page.fill('#catalog-search', '');
  await page.waitForTimeout(350);
  // The ticked rows are past the first hundred, so not drawn now — but still chosen.
  await page.click('#btn-compare-selected');
  await page.waitForTimeout(200);
  ok('ticks survive the search being cleared, drawn or not',
    /2 selected/.test(await page.$eval('#compare-strip-zone', (z) => z.textContent)));
  await page.click('#catalog-tbody [data-edit]');
  await page.waitForTimeout(300);
  ok('Edit opens the part', await page.$eval('#part-modal-backdrop', (e) => getComputedStyle(e).display !== 'none'));
  await page.click('#btn-cancel-part');

  console.log('\nAN ACCESSORY’S SPECIFICATION TABLE, ON THE PART FORM');
  await page.fill('#catalog-search', 'ELG-100001');
  await page.waitForTimeout(350);
  await page.click('#catalog-tbody [data-edit="SP-1"]');
  await page.waitForTimeout(200);
  ok('a part with a table opens with the section unfolded and filled in',
    await page.evaluate(() => document.querySelector('#pm-spec').open &&
      document.querySelector('#pm-spec-title').value === 'TX Air Dryer 300' &&
      document.querySelector('#pm-spec-capacity').value === '300 cfm' &&
      document.querySelector('#pm-spec-maxpressure').value === ''));
  await page.fill('#pm-spec-weight', ' 110 kg ');
  await page.evaluate(() => { window.__calls = []; window.__data.saveSpare = (o) => o; });
  await page.click('#btn-save-part');
  await page.waitForTimeout(200);
  const saved = await page.evaluate(() => (window.__calls.filter((c) => c.fn === 'saveSpare')[0] || {}).args);
  ok('saving sends every field of the table, trimmed', saved && saved[0].specTitle === 'TX Air Dryer 300' &&
    saved[0].specWeight === '110 kg' && saved[0].specMaxPressure === '' &&
    ['specModel', 'specCapacity', 'specWorkingPressure', 'specDimensions'].every((k) => k in saved[0]), saved);
  await page.fill('#catalog-search', 'ELG-100002');
  await page.waitForTimeout(350);
  await page.click('#catalog-tbody [data-edit="SP-2"]');
  await page.waitForTimeout(200);
  ok('a part without one opens folded and empty — nothing carried over from the last',
    await page.evaluate(() => !document.querySelector('#pm-spec').open &&
      document.querySelector('#pm-spec-title').value === '' &&
      document.querySelector('#pm-spec-weight').value === ''));
  await page.click('#btn-cancel-part');

  ok('no page errors anywhere', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); process.exit(1); });
