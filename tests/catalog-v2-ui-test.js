/**
 * ERP 2.0's Catalogue, as the 2.0 demo draws it, in a browser against the real client: three tabs
 * (Compressors, Accessories, Spares) over ERP 1's own list; "Pick by need" on compressors (air in
 * cfm and pressure in bar, up to 45% headroom); the demo's columns — the ELGi price (sell), the PIE
 * price (cost, Management only), HSN, GST, stock, a compressor's specification; and ERP 1's edit
 * window from a row. The other faces keep ERP 1's two buttons and columns.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/catalog-v2-ui-test.js /tmp/show-v2.html
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e) + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(900); };
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
  const heads = () => page.$$eval('#catalog-thead th', (t) => t.map((x) => x.textContent).filter(Boolean));
  const rows = () => page.$$eval('#catalog-tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  const tab = async (t) => { await page.click('#catv-tabs [data-catv-tab="' + t + '"]'); await page.waitForTimeout(500); };
  const need = async (cfm, bar) => { await page.fill('#catv-cfm', cfm); await page.fill('#catv-bar', bar); await page.waitForTimeout(200); };

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('catalog');
    ok('ERP 1’s Spares and Products buttons, no 2.0 tabs', await shown('#subtab-parts') && await shown('#subtab-units') && !(await page.$('#catv-tabs')));
  } else {
    console.log('THE CATALOGUE');
    await go('catalog');
    ok('three tabs, opening on Compressors, ERP 1’s buttons put away', !(await shown('#subtab-parts')) &&
      (await page.$$eval('#catv-tabs [data-catv-tab]', (b) => b.map((x) => x.textContent + (x.getAttribute('aria-selected') === 'true' ? '*' : '')))).join('|') === 'Compressors*|Accessories|Spares');
    ok('the demo’s buttons', /Import price list/.test(await page.textContent('#btn-bulk-upload')) && /Add item/.test(await page.textContent('#btn-new-catalog-item')));
    ok('compressors, in the demo’s columns, the PIE price for Management', (await heads()).join('|') ===
      'Model|Description|kW|Air (cfm)|Bar|ELGi price (sell)|PIE price (cost)|HSN|Specs|In stock', await heads());
    const c = await rows();
    ok('each model: air, pressure, prices, HSN, whether its spec is in', c.length === 4 && /EG 22/.test(c[0]) && / 128 /.test(c[0]) && /₹6,85,000/.test(c[0]) &&
      /₹5,98,000/.test(c[0]) && /Spec sheet/.test(c[0]) && /Missing/.test(c[3]) && / 28 12 /.test(c[3]), c);
    ok('the count', /4 compressors/.test(await page.textContent('#catalog-count')));

    console.log('\nPICK BY NEED');
    await need('180', '');
    ok('air needed, up to 45% headroom', (await rows()).length === 1 && /EG 37/.test((await rows())[0]) && /1 of 4 compressors/.test(await page.textContent('#catalog-count')), await rows());
    await need('150', '9');
    ok('and the pressure', (await rows()).length === 1 && /EG 37/.test((await rows())[0]), await rows());
    await need('900', '');
    ok('nothing big enough says so', /No compressor gives 900 cfm within 45% headroom/.test(await page.textContent('#catalog-tbody')));
    await page.click('#btn-catv-clear');
    await page.waitForTimeout(200);
    ok('Clear brings them all back', (await rows()).length === 4 && await shown('#btn-find-compressor'));

    console.log('\nACCESSORIES AND SPARES');
    await tab('acc');
    ok('accessories: the spares with a specification table', (await heads()).join('|') === 'Item|Description|Capacity|ELGi price (sell)|PIE price (cost)|HSN|GST|In stock' &&
      (await rows()).length === 1 && /TX Air Dryer 300/.test((await rows())[0]) && /300 cfm · 7 to 13 bar/.test((await rows())[0]) &&
      /1 accessory/.test(await page.textContent('#catalog-count')) && !(await shown('#catv-pick')), await rows());
    await tab('spares');
    const sp = await rows();
    ok('spares: every one, the dryer too, with group, GST and stock', (await heads()).join('|') === 'Part|Description|ELGi price (sell)|PIE price (cost)|Alternate|HSN|GST|In stock' &&
      sp.length === 11 && /Air oil separator/.test(sp[0]) && /RCD Spares/.test(sp[0]) && /18%/.test(sp[0]) && /11 spares/.test(await page.textContent('#catalog-count')), sp);
    await page.fill('#catalog-search', 'valve');
    await page.waitForTimeout(400);
    ok('ERP 1’s search still narrows it', (await rows()).length === 4 && /4 of 11 spares/.test(await page.textContent('#catalog-count')));
    await page.fill('#catalog-search', '');
    await page.waitForTimeout(400);
    await page.click('#catalog-tbody [data-edit="SP-11"]');
    await page.waitForTimeout(500);
    ok('a row’s pencil opens ERP 1’s item window', await page.evaluate(() => Array.from(document.querySelectorAll('.modal-backdrop.show')).length === 1));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
