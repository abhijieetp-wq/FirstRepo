/**
 * 2.0's Compressor Sales pipeline, in a browser against the real client: what ERP 1's Pipeline
 * and Leads tabs summed, above the board — the open opportunities, their value and weighted
 * value, those past their next action, the count and value at each of ERP 1's opportunity
 * stages, and the leads not yet converted, by status. It follows the board's owner filter and
 * stays in the List view. The other faces keep ERP 1's own tabs.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/compressor-pipeline-v2-ui-test.js /tmp/show-v2.html
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
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  await page.evaluate(() => document.querySelector('#tabs [data-view="compressor"]').click());
  await page.waitForTimeout(1200);
  const tile = (k) => page.evaluate((x) => { const t = document.querySelector('[data-csp-tile="' + x + '"]'); return t ? t.innerText.replace(/\s+/g, ' ').trim() : ''; }, k);
  const stages = () => page.$$eval('[data-csp-stage]', (s) => s.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  const owner = async (v) => { await page.selectOption('#eb-compressor [data-eb-filter="owner"]', v); await page.waitForTimeout(300); };

  if (!v2) {
    console.log('THE OTHER FACES');
    ok('ERP 1’s Leads and Pipeline tabs, no 2.0 pipeline', !(await page.$('[data-csp]')) &&
      await page.evaluate(() => document.getElementById('subtab-pipeline').offsetParent !== null));
  } else {
    console.log('THE PIPELINE ABOVE THE BOARD');
    ok('it sits between the toolbar and the board', await page.evaluate(() => {
      const c = document.querySelector('#eb-compressor [data-csp]');
      return !!c && c.previousElementSibling.classList.contains('eb2-tools') && c.nextElementSibling.classList.contains('eb-sum');
    }));
    ok('open opportunities: won and lost left out', /^Open opportunities 5 /.test(await tile('open')), await tile('open'));
    ok('their value, and weighted by the chance of winning each', /₹62\.00 L/.test(await tile('value')) && /₹25\.15 L/.test(await tile('weighted')),
      [await tile('value'), await tile('weighted')]);
    ok('those past their next action, in red', /^Needs follow-up 1 /.test(await tile('late')) &&
      await page.$eval('[data-csp-tile="late"]', (e) => e.classList.contains('bad')));
    ok('the open leads, by status', (await tile('leads')) === 'Open leads 4 2 new · 1 contacted · 1 qualified · 1 late', await tile('leads'));
    ok('ERP 1’s stages, each with its count and value', (await stages()).join(' | ') ===
      'Requirement Identified 1 ₹9.00 L | Technical Discussion 2 ₹20.00 L | Quotation 1 ₹22.00 L | Negotiation 1 ₹11.00 L | PO Expected 0',
      await stages());

    console.log('\nIT FOLLOWS THE OWNER FILTER');
    await owner('__mine');
    ok('Mine: Management’s own', /^Open opportunities 1 /.test(await tile('open')) && /₹22\.00 L/.test(await tile('value')) &&
      /₹11\.00 L/.test(await tile('weighted')) && /^Open leads 1 1 qualified/.test(await tile('leads')), [await tile('open'), await tile('leads')]);
    await owner('kiran@pie.in');
    ok('a coordinator’s', /^Open opportunities 2 /.test(await tile('open')) && /^Needs follow-up 0 /.test(await tile('late')) &&
      /^Open leads 2 1 new · 1 contacted$/.test(await tile('leads')), [await tile('open'), await tile('late'), await tile('leads')]);
    await owner('');

    console.log('\nAND STAYS IN THE LIST VIEW');
    await page.click('#eb-compressor [data-eb-view="list"]');
    await page.waitForTimeout(400);
    ok('the same figures over the list', !!(await page.$('#eb-compressor .eb2-list')) && /^Open opportunities 5 /.test(await tile('open')));
    await page.click('#eb-compressor [data-eb-view="board"]');
    await page.waitForTimeout(300);
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
