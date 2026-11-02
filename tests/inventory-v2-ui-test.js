/**
 * ERP 2.0's Inventory & Inward, as the 2.0 demo draws it, in a browser against the real client:
 * the five totals (each opening what it counts), "+ Inward (GRN)" at the top, and ERP 1's four
 * lists as tabs in the demo's tables — stock (spares or compressors, by store, below reorder),
 * reservations with Release, goods received with their verification, and serials. The other
 * faces keep ERP 1's lists.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/inventory-v2-ui-test.js /tmp/show-v2.html
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
  const press = async (sel) => { await page.evaluate((s) => document.querySelector(s).click(), sel); await page.waitForTimeout(300); };
  const rows = () => page.$$eval('#ivv-tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  const pick = async (sel, v) => { await page.selectOption('#ivv-host [data-ivv-sel="' + sel + '"]', v); await page.waitForTimeout(150); };
  const isOpen = (id) => page.evaluate((i) => document.getElementById(i).classList.contains('show'), id);

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('inventory');
    ok('ERP 1’s tabs and list', await shown('#subtab-stock') && await shown('#inv-tbody') && !(await page.$('#ivv-host')));
  } else {
    console.log('INVENTORY & INWARD');
    await go('inventory');
    ok('ERP 1’s tabs and list put away, 2.0’s in their place', await shown('#ivv-host') && !(await shown('#subtab-stock')) && !(await shown('#inv-tbody')));
    ok('+ Inward (GRN) at the top, on every tab', await shown('#btn-new-grn') && /Inward \(GRN\)/.test(await page.textContent('#btn-new-grn')));
    const tiles = await page.$$eval('#ivv-host .qv-kpi', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('five totals', tiles.length === 5 && tiles[0] === 'Spares in stock 42 4 part numbers' && tiles[1] === 'GRNs to verify 1 stock not added yet' &&
      tiles[2] === 'Compressors in stock 3 2 free' && tiles[3] === 'Below reorder level 2 order from ELGi' && tiles[4] === 'Reserved 10 against orders', tiles);

    console.log('\nSTOCK');
    ok('the table, in the demo’s columns', (await page.$$eval('#ivv-host th', (t) => t.map((x) => x.textContent))).join('|') ===
      'Part|Description|Store|On hand|Reserved|Free|Reorder at|Value');
    const st = await rows();
    ok('each part: description, store and bin, on hand, reserved, free, reorder level, value', st.length === 4 && /2205190474/.test(st[0]) &&
      /Air-oil separator element/.test(st[0]) && /Main store A-04/.test(st[0]) && /Low/.test(st[0]) && /₹1,10,400/.test(st[0]), st);
    ok('a part at or below its reorder level stands out', (await page.$$('#ivv-tbody tr.ivv-low')).length === 2);
    await pick('store', 'Service van');
    ok('a store', (await rows()).length === 1 && /Airend oil/.test((await rows())[0]));
    await pick('store', '');
    await press('#ivv-host [data-ivv-low]');
    ok('below reorder only', (await rows()).length === 2);
    await press('#ivv-host [data-ivv-low]');
    await pick('type', 'Product');
    ok('compressors too', (await rows()).length === 2 && /EG 37 screw compressor/.test((await rows())[0]));
    await pick('type', 'Spare');
    await page.fill('#ivv-host [data-ivv-q]', 'filter');
    await page.waitForTimeout(150);
    ok('search, keeping the box', (await rows()).length === 2 && await page.evaluate(() => document.activeElement.matches('[data-ivv-q]')));
    await page.fill('#ivv-host [data-ivv-q]', '');
    await page.waitForTimeout(150);

    console.log('\nTHE TOTALS OPEN WHAT THEY COUNT');
    await press('#ivv-host [data-ivv-tile="low"]');
    await page.waitForTimeout(600);
    ok('Below reorder level: the stock, below reorder only', await page.$eval('#ivv-host [data-ivv-tab="stock"]', (b) => b.getAttribute('aria-selected')) === 'true' &&
      await page.$eval('#ivv-host [data-ivv-low]', (c) => c.checked) && (await rows()).length === 2);
    await press('#ivv-host [data-ivv-tile="inward"]');
    await page.waitForTimeout(600);
    const gr = await rows();
    ok('GRNs to verify: the goods received, the waiting one marked', gr.length === 2 && /GRN2610-0007/.test(gr[0]) && /ELGi inv 4410287/.test(gr[0]) &&
      /Waiting/.test(gr[0]) && /Verified · 16 Oct/.test(gr[1]) && (await page.$$('#ivv-tbody tr.ivv-low')).length === 1, gr);
    await page.evaluate(() => { window.__calls = []; window.__failNext = 'getGRN'; });
    await press('#ivv-tbody tr[data-ivv-grn="GRN-2"]');
    ok('a GRN opens ERP 1’s window, where it is verified', await page.evaluate(() => window.__calls.some((c) => c.fn === 'getGRN' && c.args[0] === 'GRN-2')));
    await press('#ivv-host [data-ivv-tile="reservations"]');
    await page.waitForTimeout(600);
    const rs = await rows();
    ok('Reserved: the reservations, each with its order and Release', rs.length === 3 && /SO2610-0042/.test(rs[0]) && /Spare/.test(rs[0]) && /Compressor/.test(rs[2]) &&
      (await page.$$('#ivv-tbody [data-ivv-release]')).length === 3, rs);
    await press('#ivv-tbody [data-ivv-release="RS-1"]');
    ok('Release asks why first', await isOpen('ask-modal-backdrop'));
    await page.evaluate(() => document.getElementById('ask-modal-backdrop').classList.remove('show'));
    await press('#ivv-host [data-ivv-tile="serials"]');
    await page.waitForTimeout(600);
    const sn = await rows();
    ok('Compressors in stock: the serials, a free one called Free', sn.length === 4 && /EG37-24410/.test(sn[0]) && /Free/.test(sn[0]) && /Reserved/.test(sn[1]) && /Installed/.test(sn[3]), sn);
    ok('and + Add serial beside + Inward (GRN) here', await shown('#btn-new-serial') && await shown('#btn-new-grn'));
    await press('#btn-new-grn');
    ok('+ Inward (GRN) opens ERP 1’s goods received form', await isOpen('grn-modal-backdrop'));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
