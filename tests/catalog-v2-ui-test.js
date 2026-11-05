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
    ok('accessories: the specification, as ELGi’s CDOC sheet gives it', (await heads()).join('|') ===
      'Model|Capacity|Working pressure|Max pressure|Dimensions|Weight|ELGi price (sell)|PIE price (cost)|GST' &&
      (await rows()).length === 1 && /TXD-300/.test((await rows())[0]) && /Dryer/.test((await rows())[0]) && /300 cfm 7 to 13 bar/.test((await rows())[0]) &&
      /1 accessory/.test(await page.textContent('#catalog-count')) && !(await shown('#catv-pick')), await rows());
    ok('the button says what it adds', (await page.textContent('#btn-new-catalog-item')).trim() === '+ Add accessory');

    console.log('\nADDING AN ACCESSORY');
    const isOpen = (m) => page.evaluate((x) => document.getElementById(x + '-modal-backdrop').classList.contains('show'), m);
    await page.evaluate(() => { window.__data.saveAccessory = (o) => ({ id: 'SP-NEW', specTitle: (o.type ? o.type + ' ' : '') + o.model }); });
    await page.click('#btn-new-catalog-item');
    await page.waitForTimeout(300);
    ok('its own form, not the spare one', await isOpen('accessory') && !(await isOpen('part')) &&
      (await page.textContent('#accessory-modal-title')) === 'Add Accessory');
    const labels = await page.$$eval('#accessory-modal-backdrop label', (l) => l.map((x) => x.textContent.trim()));
    ok('type, then the six fields: model and capacity required, the rest not', labels.join('|') ===
      'Type|Model *|Capacity *|Normal working pressure|Package weight|Maximum pressure|Dimensions', labels);
    ok('no part number, description, group, stock or price boxes', !(await page.$('#accessory-modal-backdrop input[id*="price"]')) &&
      (await page.$$('#accessory-modal-backdrop input:not([type="hidden"])')).length === 7);
    ok('ELGi’s types offered', (await page.$$eval('#accessory-types option', (o) => o.map((x) => x.value))).indexOf('Air Dryer') !== -1 &&
      (await page.$$eval('#accessory-types option', (o) => o.map((x) => x.value))).indexOf('Dryer') !== -1);
    await page.fill('#acc-type', 'Air Dryer');
    await page.fill('#acc-capacity', '309 cfm');
    await page.click('#btn-save-accessory');
    await page.waitForTimeout(300);
    ok('no model: refused before it is sent', /Model is required/.test(await page.textContent('#msg-box')) &&
      !(await page.evaluate(() => window.__calls.some((c) => c.fn === 'saveAccessory'))));
    await page.fill('#acc-model', 'AR 0310NS A2_INDIA');
    await page.fill('#acc-capacity', '');
    await page.click('#btn-save-accessory');
    await page.waitForTimeout(300);
    ok('no capacity: likewise', /Capacity is required/.test(await page.textContent('#msg-box')) &&
      !(await page.evaluate(() => window.__calls.some((c) => c.fn === 'saveAccessory'))));
    await page.fill('#acc-capacity', '309 cfm');
    ok('it says how the quotation will name it', /ELGi make Air Dryer AR 0310NS A2_INDIA/.test(await page.textContent('#acc-heading-note')));
    if (process.argv[3]) await page.screenshot({ path: process.argv[3], clip: await page.evaluate(() => { const r = document.querySelector('#accessory-modal-backdrop .modal').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) });
    await page.fill('#acc-workpressure', '7 bar');
    await page.fill('#acc-maxpressure', '16 bar');
    await page.fill('#acc-dimensions', '600 x 454 x 1496 mm');
    await page.click('#btn-save-accessory');
    await page.waitForTimeout(500);
    const sentAcc = await page.evaluate(() => window.__calls.filter((c) => c.fn === 'saveAccessory').map((c) => c.args[0]));
    ok('saved with what was typed, weight left out', sentAcc.length === 1 && sentAcc[0].model === 'AR 0310NS A2_INDIA' && sentAcc[0].type === 'Air Dryer' &&
      sentAcc[0].capacity === '309 cfm' && sentAcc[0].workingPressure === '7 bar' && sentAcc[0].maxPressure === '16 bar' &&
      sentAcc[0].dimensions === '600 x 454 x 1496 mm' && sentAcc[0].weight === '' && !sentAcc[0].id, sentAcc);
    ok('and the form closes, saying so', !(await isOpen('accessory')) && /Air Dryer AR 0310NS A2_INDIA saved/.test(await page.textContent('#msg-box')));
    await page.click('#catalog-tbody [data-edit="SP-11"]');
    await page.waitForTimeout(400);
    ok('editing one opens the accessory form with what it has', await isOpen('accessory') &&
      (await page.textContent('#accessory-modal-title')) === 'Edit Accessory' && (await page.inputValue('#acc-model')) === 'TXD-300' &&
      (await page.inputValue('#acc-type')) === 'Dryer' && (await page.inputValue('#acc-capacity')) === '300 cfm' &&
      /ELGi price ₹1,68,000/.test(await page.textContent('#acc-price-note')));
    await page.click('#btn-cancel-accessory');
    await page.waitForTimeout(200);
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
