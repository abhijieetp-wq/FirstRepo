/**
 * ERP 2.0's dashboard and SDR additions, in a browser against the real client: the period
 * selector on the dashboard, a visit row that opens Visit plans, and the SDR list's totals —
 * customers, called, quotations raised, converted. The other faces have neither.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/dashboard-extras-ui-test.js /tmp/base-v2.html
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
const STATUSES = ['To call', 'Called', 'Quotation prepared', 'Quotation sent', 'Following up', 'PO received', 'Not closed', 'PO rejected'];
const call = (id, extra) => Object.assign({ id, fabNo: 'FAB' + id, productModel: 'TX 15-7.5', sdrCustomerName: 'TESTWELL AGRO FOODS PVT LTD',
  customerId: 'CU-' + id, customerName: 'Customer ' + id, ownerEmail: 'p@pie.in', status: 'To call', dueParts: 'Overdue: AF', overdue: 'TRUE',
  followUpCount: 0, listedCount: 1, firstListDate: '2026-10-19', lastListDate: '2026-10-19', quoteValue: '', outcome: '', notClosedReason: '',
  poRejectedReason: '', callDate: '', callResponse: '', callNotes: '', contactName: '', contactId: '', nextFollowUpDate: '', quoteNo: '',
  enquiryType: '', poValue: '' }, extra || {});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const lastCall = (fn) => page.evaluate((f) => {
    const all = window.__calls.filter((c) => c.fn === f);
    return all.length ? all[all.length - 1].args : null;
  }, fn);
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(600); };

  await page.evaluate((args) => {
    const [STATUSES, calls] = args;
    const D = window.__data;
    const dash = D.getPersonDashboard;
    D.getPersonDashboard = (o) => {
      const d = dash(o);
      const key = (o && o.period) || 'month';
      d.period = { key, from: key === 'custom' ? o.from : '2026-10-01', to: key === 'custom' ? o.to : '2026-10-31' };
      d.periods = [{ key: 'month', label: 'This month' }, { key: 'lastmonth', label: 'Last month' }, { key: 'quarter', label: 'This quarter' },
        { key: 'fy', label: 'This financial year' }, { key: 'custom', label: 'Custom range' }];
      d.lists = [{ key: 'visits', title: 'Today’s visits', count: 1, empty: '', rows: [{ title: 'Brightline Mills', sub: 'Air audit · Wardha (Outstation)',
        right: '', rightSub: 'Planned', tone: 'warn', open: { kind: 'visits', id: 'V1' } }] }].concat(d.lists || []);
      return d;
    };
    D.getVisitPlans = (o) => ({ from: o.from, to: o.to, today: o.from, me: 'p@pie.in', seeAll: true, engineer: '', people: [], areas: [],
      lists: { purposes: ['New customer – prospecting'], compTypes: [], brands: [], timelines: [], industries: [] }, statuses: ['Planned'], interest: [],
      customers: [], canEditAreas: false, visits: [] });
    D.getServiceDueScreen = () => ({ lists: [{ id: 'SDL-1', listDate: '2026-10-19', machineCount: 5 }], calls: calls.map((c) => Object.assign({}, c)),
      coordinators: [{ email: 'p@pie.in', name: 'Priya' }], statuses: STATUSES, responses: ['Needs spares'], modes: ['Call'], followUpLimit: 6,
      quoteTypes: ['Spares', 'AMC renewal', 'Service'], me: 'p@pie.in', canEdit: true });
  }, [STATUSES, [
    call('1'),
    call('2', { status: 'Called', callDate: '2026-10-27' }),
    call('3', { status: 'Quotation sent', callDate: '2026-10-26', quoteNo: 'SPARE/26/0001', quoteValue: 12500 }),
    call('4', { status: 'PO received', callDate: '2026-10-20', quoteNo: 'SPARE/26/0002', quoteValue: 20000, poValue: 19500 }),
    call('5', { customerId: 'CU-4', customerName: 'Customer 4', fabNo: 'FAB5' })
  ]]);

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('servicedue');
    ok('no SDR totals strip', !(await page.$('.sdc-totals')));
  } else {
    console.log('THE DASHBOARD’S PERIOD');
    await go('dashboard');
    ok('a period to pick', !!(await page.$('#pd-period')) && await page.inputValue('#pd-period') === 'month');
    await page.evaluate(() => { window.__calls = []; });
    await page.selectOption('#pd-period', 'quarter');
    await page.waitForTimeout(300);
    ok('the figures asked for it', JSON.stringify(await lastCall('getPersonDashboard')) === JSON.stringify([{ as: '', period: 'quarter' }]));
    await page.selectOption('#pd-period', 'custom');
    await page.waitForTimeout(300);
    ok('a range shows its dates', !!(await page.$('#pd-from')) && !!(await page.$('#pd-to')) &&
      JSON.stringify(await lastCall('getPersonDashboard')) === JSON.stringify([{ as: '', period: 'custom', from: '2026-10-01', to: '2026-10-31' }]));
    await page.fill('#pd-from', '2026-09-01');
    await page.dispatchEvent('#pd-from', 'change');
    await page.waitForTimeout(300);
    ok('and asks for them', (await lastCall('getPersonDashboard'))[0].from === '2026-09-01');

    console.log('\nTODAY’S VISITS');
    ok('on the desk', /Today’s visits/.test(await page.textContent('#pd-host')) && /Brightline Mills/.test(await page.textContent('#pd-host')));
    await page.click('[data-pd-open="visits"]');
    await page.waitForTimeout(600);
    ok('a visit opens Visit plans', (await page.evaluate(() => document.querySelector('.view.active').id)) === 'view-visits');

    console.log('\nTHE SDR TOTALS');
    await go('servicedue');
    const t = await page.$$eval('.sdc-totals .pd-tile', (x) => x.map((y) => y.innerText.replace(/\s+/g, ' ').trim()));
    ok('customers in the list, called, quotations raised, converted', t.length === 4 && /^Customers in the list 4/.test(t[0]) &&
      /^Called 3 60% of the list/.test(t[1]) && /^Quotations raised 2 ₹33K$/.test(t[2]) && /^Converted 1 ₹20K won$/.test(t[3]), t);
    ok('above ERP 1’s count by status', !!(await page.$('.sdc-totals + .sdc-tiles')));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
