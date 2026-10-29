/**
 * ERP 2.0's look, in a browser: what web2/Theme.html and web2/Shell.html add over the new
 * design, and that nothing of ERP 1 is lost under it.
 *
 * portal-ui-test.js and the other screen suites run against the 2.0 face as well (tests/run.sh),
 * which is what shows the behaviour is untouched. This checks what only 2.0 has: its colours and
 * typefaces, the SDR name PIE asked for, the "2.0" mark and the way back — and that the things
 * PIE named as must-stay (the bulk imports) are still on their screens.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2 \
 *        --title="ELGi Sales ERP"
 *   node tests/v2-ui-test.js /tmp/show-v2.html
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const V2 = process.argv[2];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'warning' && /\[(2\.0 )?shell\]/.test(m.text())) errors.push(m.text()); });
  await page.goto('file://' + V2);
  await page.waitForTimeout(900);
  const go = async (view) => {
    await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view);
    await page.waitForTimeout(250);
  };
  const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; }, sel);

  console.log('2.0 OPENS');
  ok('with no script errors, and no complaint from either shell', errors.length === 0, errors);
  ok('both shells ran', await page.evaluate(() =>
    document.documentElement.classList.contains('shell-ready') && document.documentElement.classList.contains('v2')));

  console.log('\nIN ERP 2’S COLOURS AND TYPE');
  const look = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const h2 = document.querySelector('.view.active .page-head h2');
    return { accent: root.getPropertyValue('--brand-500').trim(), rail: root.getPropertyValue('--night-900').trim(),
      body: getComputedStyle(document.body).fontFamily, heading: h2 ? getComputedStyle(h2).fontFamily : '',
      amberName: root.getPropertyValue('--amber').trim() };
  });
  ok('the green accent', look.accent.toUpperCase() === '#23772F', look.accent);
  ok('the green rail', look.rail.toUpperCase() === '#0F2B14', look.rail);
  ok('IBM Plex Sans for reading', /^"?IBM Plex Sans/.test(look.body), look.body);
  ok('Archivo for headings', /^"?Archivo/.test(look.heading), look.heading);
  ok('the names JavaScript.html reads still resolve', look.amberName !== '', look.amberName);

  console.log('\nTHE SCREEN PIE ASKED TO BE CALLED SDR IS CALLED SDR');
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('#tabs [data-view]')).map((b) => b.textContent.trim()));
  ok('in the menu', menu.indexOf('SDR') !== -1, menu);
  ok('and the old name is nowhere in it', !menu.some((m) => /Service Due/.test(m)), menu);
  await go('servicedue');
  ok('on its own heading', (await text('#view-servicedue .page-head h2')) === 'SDR', await text('#view-servicedue .page-head h2'));
  ok('in the breadcrumb', (await text('#ws-crumb-page')) === 'SDR', await text('#ws-crumb-page'));
  ok('and not in the browser tab under its old name', !/Service Due/.test(await page.title()), await page.title());
  ok('the screen is still ERP 1’s, with its report and its filters',
    await page.evaluate(() => !!document.getElementById('btn-sdc-download') && !!document.querySelector('#view-servicedue input[type=search], #view-servicedue input')));
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  await page.keyboard.type('sdr');
  await page.waitForTimeout(150);
  const found = await page.evaluate(() => Array.from(document.querySelectorAll('#cmdk-list [role=option], #cmdk-list button, #cmdk-list li'))
    .map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('and the command palette finds it as SDR', found.some((t) => t.indexOf('SDR') === 0) && !found.some((t) => /Service Due/.test(t)), found);
  await page.keyboard.press('Escape');

  console.log('\nTHE MARK AND THE WAY BACK');
  ok('"2.0" beside the app’s name', (await text('#app-name .v2-tag')) === '2.0');
  ok('the name itself is the company’s', /ELGi Sales ERP/.test(await text('#app-name')), await text('#app-name'));
  const back = await page.evaluate(() => { const a = document.querySelector('.topbar .v2-back'); return a ? { href: a.getAttribute('href'), t: a.textContent } : null; });
  ok('a way back to the current look at the foot of the menu', back && back.href === '?look=web' && /current look/.test(back.t), back);

  console.log('\nNOTHING OF ERP 1 IS LOST UNDER IT');
  await go('catalog');
  ok('the catalogue still has its Bulk Upload', await page.evaluate(() => {
    const b = document.getElementById('btn-bulk-upload'); return !!b && b.offsetParent !== null; }));
  await go('customers');
  ok('and so do customers', await page.evaluate(() => {
    const b = document.getElementById('btn-customer-bulk'); return !!b && b.offsetParent !== null; }));
  ok('no New Quotation screen in the menu: All Quotations starts one', !(await page.$('#tabs [data-view="quote"]')));
  ok('every screen of the menu opens', await page.evaluate(() => {
    const views = Array.from(document.querySelectorAll('#tabs [data-view]')).map((b) => b.dataset.view);
    return views.every((v) => { document.querySelector('#tabs [data-view="' + v + '"]').click();
      return document.getElementById('view-' + v).classList.contains('active'); });
  }));
  ok('with no script errors along the way', errors.length === 0, errors);

  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
