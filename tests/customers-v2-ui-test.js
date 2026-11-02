/**
 * ERP 2.0's Customers, as the 2.0 demo draws it, in a browser against the real client: search
 * by name, code, GSTIN, phone or city; segment, salesperson and Has overdue dues; and the table —
 * code, customer with city, segment and a missing GSTIN, machines, salesperson, what is owed (red
 * when overdue) and the open enquiries and service calls. A row opens ERP 1's customer window.
 * The other faces keep ERP 1's list.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/customers-v2-ui-test.js /tmp/show-v2.html
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
  const names = () => page.$$eval('#cuv-tbody tr[data-edit-cust] b', (b) => b.map((x) => x.textContent));
  const pick = async (sel, v) => { await page.selectOption('#cuv-host [data-cuv-sel="' + sel + '"]', v); await page.waitForTimeout(150); };
  const find = async (q) => { await page.fill('#cuv-host [data-cuv-q]', q); await page.waitForTimeout(150); };

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('customers');
    ok('ERP 1’s customer list', await shown('#customers-tbody') && !(await page.$('#cuv-host')));
  } else {
    console.log('CUSTOMERS');
    await go('customers');
    ok('ERP 1’s list put away, 2.0’s in its place', await shown('#cuv-host') && !(await shown('#customers-tbody')) && !(await shown('#customer-search')));
    ok('the heading and the demo’s button', /One customer code across compressors, spares and service/.test(await page.textContent('#view-customers .page-head')) &&
      /Add customer/.test(await page.textContent('#btn-new-customer')) && await shown('#btn-customer-bulk'));
    ok('the table, in the demo’s columns', (await page.$$eval('#cuv-host th', (t) => t.map((x) => x.textContent))).join('|') ===
      'Code|Customer|Machines|Salesperson|Outstanding|Open items');
    ok('every customer, by name', (await names()).length === 8 && (await names())[0] === 'Bhima Sugar Industries', await names());
    const rows = await page.$$eval('#cuv-tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    const deccan = rows.find((r) => /Deccan Polymers/.test(r)) || '';
    ok('a row: code, city and segment, machines, salesperson, what is owed, open items', /C0102/.test(deccan) && /Chakan · Plastics/.test(deccan) &&
      /₹4\.72 L/.test(deccan) && /1 enquiry/.test(deccan) && /1 call/.test(deccan) && / 2 Kiran Patil/.test(deccan), deccan);
    ok('owed and overdue is red; owed but not yet due is not', await page.evaluate(() => {
      const td = (name) => Array.from(document.querySelectorAll('#cuv-tbody tr')).find((r) => r.textContent.indexOf(name) !== -1).children[4];
      return !!td('Deccan Polymers').querySelector('.qv-late') && !td('Godavari Textile Mills').querySelector('.qv-late');
    }));
    ok('a customer with no GSTIN yet says so', rows.some((r) => /Tapi Engineering Works/.test(r) && /no GSTIN yet/.test(r)));

    console.log('\nFINDING ONE');
    await find('98220');
    ok('by a contact’s phone', JSON.stringify(await names()) === '["Sahyadri Castings Pvt Ltd"]', await names());
    await find('nashik');
    ok('by city', JSON.stringify(await names()) === '["Vardhman Precision Tools"]');
    await find('');
    await pick('seg', 'Engineering');
    ok('a segment', JSON.stringify(await names()) === '["Sahyadri Castings Pvt Ltd","Vardhman Precision Tools"]', await names());
    await pick('seg', '');
    await pick('sp', 'Neha Rao');
    ok('a salesperson', (await names()).length === 4 && (await names()).indexOf('Konkan Agro Foods') !== -1);
    await pick('sp', '');
    await page.click('#cuv-host [data-cuv-due]');
    await page.waitForTimeout(150);
    ok('has overdue dues', JSON.stringify(await names()) === '["Deccan Polymers","Vardhman Precision Tools"]', await names());
    await page.click('#cuv-host [data-cuv-due]');
    await page.waitForTimeout(150);

    console.log('\nA ROW');
    await page.click('#cuv-tbody tr[data-edit-cust="CU-3"] td:nth-child(2)');
    await page.waitForTimeout(500);
    ok('opens ERP 1’s customer window', await page.evaluate(() => document.getElementById('customer-modal-backdrop').classList.contains('show')) &&
      await page.inputValue('#cm-id') === 'CU-3');
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
