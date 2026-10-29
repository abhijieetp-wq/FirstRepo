/**
 * ERP 2.0's dashboard per person, in a browser against the real client: everybody opens on
 * their own desk, every figure goes where it can be acted on, ERP 1's control tower is still
 * underneath, and Management can open anybody's desk.
 *
 * Only the 2.0 face has it; on the others the same file checks the Dashboard is ERP 1's.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/person-dashboard-ui-test.js /tmp/base-v2.html /tmp/show-v2.html
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
const SHOWCASE = process.argv[3];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (file) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('file://' + file);
    await page.waitForTimeout(1200);
    return page;
  };
  const active = (page) => page.evaluate(() => document.querySelector('.view.active').id);
  const lastCall = (page, fn) => page.evaluate((f) => {
    const all = window.__calls.filter((c) => c.fn === f);
    return all.length ? all[all.length - 1].args : null;
  }, fn);

  const page = await open(PREVIEW);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');

  if (!v2) {
    console.log('THE OTHER FACES KEEP ERP 1’S DASHBOARD');
    ok('a coordinator still opens on their work, not the dashboard', (await active(page)) !== 'view-dashboard', await active(page));
    await page.evaluate(() => document.querySelector('[data-view="dashboard"]').click());
    await page.waitForTimeout(500);
    ok('the Dashboard is the control tower alone', !(await page.$('#pd-host')) && !!(await page.$('#dash-body')));
    ok('and the personal one was never asked for', !(await page.evaluate(() => window.__calls.some((c) => c.fn === 'getPersonDashboard'))));
  } else {
    console.log('A COORDINATOR OPENS ON THEIR OWN DESK');
    ok('2.0 opens on the dashboard', (await active(page)) === 'view-dashboard');
    ok('greeting them by name', /^Good (morning|afternoon|evening), Priya$/.test(await page.textContent('#pd-host h1')), await page.textContent('#pd-host h1'));
    const tiles = await page.$$eval('#pd-host [data-pd-tile]', (t) => t.map((x) => x.querySelector('.pd-label').textContent));
    ok('their six figures', tiles.join(' | ') === 'My open enquiries | Follow-ups due | Waiting for the customer’s answer | ' +
      'Drafts to approve and send | My orders this month | SDR calls to make', tiles);
    ok('a late figure stands out', await page.$eval('[data-pd-tile="due"]', (e) => e.classList.contains('bad')));
    ok('money in lakhs where it is money', /₹1\.82 L/.test(await page.textContent('[data-pd-tile="open"]')), await page.textContent('[data-pd-tile="open"]'));
    ok('nobody else’s desk on offer', !(await page.$('#pd-as')));
    ok('ERP 1’s control tower is still under it', !!(await page.$('#pd-host + .page-head')) && !!(await page.$('#dash-body')));
    ok('their lists, each with its count', (await page.$$eval('[data-pd-list] .pd-panel-head h3', (h) => h.map((x) => x.textContent))).join() ===
      'Follow-ups due,Drafts to approve and send,Waiting for the customer’s answer');
    ok('an empty list says so', /No offers out with customers/.test(await page.textContent('[data-pd-list="waiting"]')));
    await page.click('[data-pd-list="due"] .pd-row');
    await page.waitForTimeout(500);
    ok('a follow-up opens its enquiry', await page.evaluate(() => document.getElementById('enquiry-modal-backdrop').classList.contains('show')));
    await page.evaluate(() => document.getElementById('enquiry-modal-backdrop').classList.remove('show'));
    await page.click('[data-pd-list="approve"] .pd-row');
    await page.waitForTimeout(600);
    ok('a draft opens the quotation', (await active(page)) === 'view-quote', await active(page));
    await page.evaluate(() => document.querySelector('[data-view="dashboard"]').click());
    await page.waitForTimeout(500);
    await page.click('[data-pd-tile="open"]');
    await page.waitForTimeout(500);
    ok('a figure goes where it is worked', (await active(page)) === 'view-enquiries');

    console.log('\nSERVICE SEES ITS DESK, NOT THE MONEY');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addInitScript(() => {
      let data;
      Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
        set(v) { if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { role: 'Service Engineer', businessStream: 'All' }); data = v; } });
    });
    const svc = await ctx.newPage();
    svc.on('pageerror', (e) => errors.push(String(e)));
    await svc.goto('file://' + PREVIEW);
    await svc.waitForTimeout(1200);
    ok('a service engineer opens on the dashboard too', (await active(svc)) === 'view-dashboard');
    ok('with their desk', !!(await svc.$('#pd-host h1')));
    ok('and without the control tower’s money', await svc.evaluate(() => {
      const hidden = (sel) => { const e = document.querySelector(sel); return !e || e.offsetParent === null; };
      return hidden('#dash-body') && hidden('#view-dashboard > .page-head') && hidden('#view-dashboard > .dash-head');
    }) && !(await svc.evaluate(() => window.__calls.some((c) => c.fn === 'getDashboard'))));
    await ctx.close();

    if (SHOWCASE) {
      console.log('\nMANAGEMENT SEES THE TEAM, AND ANYBODY’S DESK');
      const boss = await open(SHOWCASE);
      ok('the team, one row a person', (await boss.$$eval('.pd-team tbody tr', (r) => r.length)) === 3);
      ok('late follow-ups stand out', await boss.$eval('.pd-team tbody tr td.pd-bad', (e) => e.textContent) === '2');
      await boss.evaluate(() => { window.__calls = []; });
      await boss.click('.pd-team [data-pd-as="kiran@pie.in"]');
      await boss.waitForTimeout(500);
      ok('a name opens their desk', JSON.stringify(await lastCall(boss, 'getPersonDashboard')) === JSON.stringify([{ as: 'kiran@pie.in', period: 'month' }]) &&
        (await boss.textContent('#pd-host h1')) === 'Kiran Patil’s desk');
      ok('as they see it', (await boss.$$('#pd-host [data-pd-tile]')).length === 6 && await boss.$eval('#pd-as', (s) => s.value) === 'kiran@pie.in');
      await boss.click('#pd-host [data-pd-as=""]');
      await boss.waitForTimeout(500);
      ok('and back to their own', /^Good (morning|afternoon|evening), Anil$/.test(await boss.textContent('#pd-host h1')) &&
        JSON.stringify(await lastCall(boss, 'getPersonDashboard')) === JSON.stringify([{ as: '', period: 'month' }]));
      await boss.selectOption('#pd-as', 'neha@pie.in');
      await boss.waitForTimeout(500);
      ok('or by picking from the list', JSON.stringify(await lastCall(boss, 'getPersonDashboard')) === JSON.stringify([{ as: 'neha@pie.in', period: 'month' }]));

      console.log('\nTHE CONTROL TOWER UNDER A DESK IS THAT PERSON’S');
      const tower = () => boss.evaluate(() => {
        const on = (id) => document.getElementById(id).offsetParent !== null;
        const act = document.querySelector('#dash-stream button.active');
        return { title: document.getElementById('dash-title').textContent, switch: on('dash-stream'), body: on('dash-body'), active: act ? act.dataset.stream : null };
      });
      const towerAsked = async () => ((await lastCall(boss, 'getDashboard')) || [{}])[0].stream;
      // Neha, picked above, is on the spares desk only.
      let t = await tower();
      ok('a spares coordinator’s: spares only, no switch to the other desk', t.title === 'Control Tower · Spare Sales — as Neha sees it' && !t.switch && t.body &&
        await towerAsked() === 'Spare Sales', t);
      await boss.click('#pd-host [data-pd-as=""]');
      await boss.waitForTimeout(500);
      t = await tower();
      ok('back on their own desk, Management get both again', t.title === 'Control Tower' && t.switch && t.active === '' && await towerAsked() === '', t);
      await boss.click('#dash-stream [data-stream="Compressor Sales"]');
      await boss.waitForTimeout(300);
      await boss.selectOption('#pd-as', 'kiran@pie.in');
      await boss.waitForTimeout(500);
      ok('whatever desk they had picked', await towerAsked() === 'Spare Sales');
      await boss.click('#pd-host [data-pd-as=""]');
      await boss.waitForTimeout(500);
      t = await tower();
      ok('and that pick comes back with them', t.active === 'Compressor Sales' && t.switch && await towerAsked() === 'Compressor Sales', t);
      await boss.evaluate(() => {
        const D = window.__data;
        const base = D.getPersonDashboard;
        D.getPersonDashboard = (o) => {
          const d = base(o);
          if (o && o.as === 'sanjay@pie.in') Object.assign(d.person, { role: 'Service Engineer', stream: 'All' });
          if (o && o.as === 'omkar@pie.in') Object.assign(d.person, { role: 'Sales Engineer', stream: 'All' });
          return d;
        };
      });
      await boss.selectOption('#pd-as', 'sanjay@pie.in');
      await boss.waitForTimeout(500);
      t = await tower();
      ok('a service engineer’s: none, as they never see it', !t.body && !t.switch, t);
      await boss.selectOption('#pd-as', 'omkar@pie.in');
      await boss.waitForTimeout(500);
      t = await tower();
      ok('somebody on both desks: both, combined', t.body && t.switch && t.active === '' && t.title === 'Control Tower — as Omkar sees it' && await towerAsked() === '', t);
      await boss.click('#pd-host [data-pd-as=""]');
      await boss.waitForTimeout(500);
      t = await tower();
      ok('and Management’s own once more', t.body && t.active === 'Compressor Sales' && t.title === 'Control Tower', t);
    }
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
