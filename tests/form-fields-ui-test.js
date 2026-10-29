/**
 * ERP 2.0's form builder, in a browser against the real client: Masters → Form fields for
 * Management (add, type, choices, required, list column, reorder, remove, a preview); the
 * fields under "More details" on the forms, a required one stopping the save, the values saved
 * after the record; a list column on Customers; a line on an enquiry card. The other faces have
 * none of it.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/form-fields-ui-test.js /tmp/base-v2.html
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Management, on both desks: the builder is theirs.
  await context.addInitScript(() => {
    let data;
    Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
      set(v) { if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { role: 'Management', businessStream: 'All' }); data = v; } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(600); };
  const calls = (fn) => page.evaluate((f) => window.__calls.filter((c) => c.fn === f).map((c) => c.args), fn);
  const lastCall = async (fn) => { const all = await calls(fn); return all.length ? all[all.length - 1] : null; };
  const toast = () => page.evaluate(() => { const t = document.querySelector('#msg, .msg, .toast'); return t ? t.textContent : ''; });

  await page.evaluate(() => {
    const D = window.__data;
    const FORMS = [['enquiry', 'Spare enquiries'], ['lead', 'Compressor leads'], ['service', 'Service jobs'], ['customer', 'Customers'],
      ['amc', 'AMC contracts'], ['visit', 'Visits'], ['task', 'Tasks']].map((f) => ({ key: f[0], label: f[1] }));
    const fields = { enquiry: [
      { key: 'warranty_ends', label: 'Warranty ends', type: 'date', options: [], required: false, inList: true },
      { key: 'plant_shift', label: 'Plant shift', type: 'select', options: ['Day', 'Night'], required: true, inList: false },
      { key: 'running_hours', label: 'Running hours', type: 'number', options: [], required: false, inList: false }
    ], lead: [], service: [], customer: [
      { key: 'class', label: 'Class', type: 'select', options: ['A', 'B', 'C'], required: false, inList: true },
      { key: 'vip', label: 'Key account', type: 'checkbox', options: [], required: false, inList: false }
    ], amc: [], visit: [], task: [] };
    window.__fields = fields;
    D.getFormFields = () => ({ forms: FORMS, types: ['text', 'number', 'date', 'select', 'textarea', 'checkbox'], fields: JSON.parse(JSON.stringify(fields)), canEdit: true });
    D.saveFormFields = (form, list) => list.map((f, i) => ({ key: f.key || 'new_' + i, label: f.label, type: f.type,
      options: String(f.options || '').split(',').map((o) => o.trim()).filter(Boolean), required: !!f.required, inList: !!f.inList }));
    const VALUES = { enquiry: { E1: { warranty_ends: '2027-03-31' } }, customer: { 'CU-1': { class: 'B', vip: 'TRUE' } } };
    D.getCustomValues = (form, ids) => {
      const out = {};
      ids.forEach((id) => { if ((VALUES[form] || {})[id]) out[id] = Object.assign({}, VALUES[form][id]); });
      return out;
    };
    D.saveCustomValues = (form, id, vals) => vals;
    D.saveSpareEnquiry = (obj) => Object.assign({ items: [], status: 'New', enquiryNo: 'SE2610-0009' }, obj, { id: obj.id || 'SE-9' });
  });

  if (!v2) {
    console.log('THE OTHER FACES');
    ok('no Form fields in the menu', !(await page.$('#tabs [data-view="formfields"]')) && !(await page.$('#view-formfields')));
    ok('no More details on any form', (await page.$$('.xf-sec')).length === 0);
    await go('customers');
    ok('nor list columns, nor a call for them', (await page.$$('.xf-col')).length === 0 && (await calls('getFormFields')).length === 0);
  } else {
    console.log('THE BUILDER');
    ok('under Masters, for Management', !!(await page.$('#tabs [data-view="formfields"]')));
    await go('formfields');
    ok('its own screen and address', (await page.evaluate(() => document.querySelector('.view.active').id)) === 'view-formfields');
    const picks = await page.$$eval('[data-xf-form-pick]', (b) => b.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('the seven forms with their counts', picks.length === 7 && picks[0] === 'Spare enquiries 3' && picks[3] === 'Customers 2', picks);
    ok('a form’s fields in order', (await page.$$eval('#xf-edit .xf-l', (i) => i.map((x) => x.value))).join() === 'Warranty ends,Plant shift,Running hours');
    ok('a dropdown shows its choices', await page.$eval('[data-xf-i="1"] .xf-o', (i) => i.value) === 'Day, Night');
    ok('nothing to save yet', await page.$eval('#btn-xf-save', (b) => b.disabled));
    ok('and a preview of the section', /More details/.test(await page.textContent('#xf-preview')) && !!(await page.$('#xf-preview select')));

    await page.click('#btn-xf-add');
    await page.fill('[data-xf-i="3"] .xf-l', 'Site contact');
    await page.selectOption('[data-xf-i="3"] .xf-t', 'select');
    await page.waitForTimeout(100);
    ok('a dropdown asks for its choices', !!(await page.$('[data-xf-i="3"] .xf-o')));
    await page.fill('[data-xf-i="3"] .xf-o', 'Owner, Plant head');
    await page.check('[data-xf-i="3"] .xf-r');
    await page.check('[data-xf-i="3"] .xf-c');
    ok('marked not saved', /Not saved yet/.test(await page.textContent('#xf-edit')) && !(await page.$eval('#btn-xf-save', (b) => b.disabled)));
    await page.click('[data-xf-i="0"] [data-xf-move="1"]');
    ok('moved down', (await page.$$eval('#xf-edit .xf-l', (i) => i.map((x) => x.value))).join() === 'Plant shift,Warranty ends,Running hours,Site contact');
    await page.click('[data-xf-i="2"] [data-xf-drop]');
    ok('and one taken off', (await page.$$eval('#xf-edit .xf-l', (i) => i.map((x) => x.value))).join() === 'Plant shift,Warranty ends,Site contact');
    await page.click('[data-xf-form-pick="lead"]');
    await page.waitForTimeout(200);
    ok('leaving with changes asks first', await page.evaluate(() => document.getElementById('ask-modal-backdrop').classList.contains('show')));
    await page.click('#ask-cancel');
    await page.waitForTimeout(100);
    await page.click('#btn-xf-save');
    await page.waitForTimeout(300);
    const saved = await lastCall('saveFormFields');
    ok('saved as listed', saved && saved[0] === 'enquiry' && JSON.stringify(saved[1]) === JSON.stringify([
      { key: 'plant_shift', label: 'Plant shift', type: 'select', options: 'Day, Night', required: true, inList: false },
      { key: 'warranty_ends', label: 'Warranty ends', type: 'date', options: '', required: false, inList: true },
      { key: '', label: 'Site contact', type: 'select', options: 'Owner, Plant head', required: true, inList: true }]), saved);
    ok('and the count follows', /^Spare enquiries 3$/.test(await page.$eval('[data-xf-form-pick="enquiry"]', (b) => b.innerText.replace(/\s+/g, ' ').trim())) &&
      !/Not saved yet/.test(await page.textContent('#xf-edit')));
    // Back to the fields the forms below are tested with.
    await page.evaluate(() => { window.__calls = []; });
    await go('dashboard');
    await go('formfields');

    console.log('\nON THE FORM');
    await go('enquiries');
    await page.evaluate(() => document.getElementById('btn-new-enquiry').click());
    await page.waitForTimeout(500);
    ok('More details on the enquiry', await page.$eval('#xf-host-enquiry', (h) => h.style.display !== 'none' && /More details/.test(h.textContent)) &&
      (await page.$$('#xf-host-enquiry [data-xf-field]')).length === 3);
    ok('each its type, the required marked', await page.$eval('#xf-enquiry-warranty_ends', (i) => i.type) === 'date' &&
      await page.$eval('#xf-enquiry-running_hours', (i) => i.type) === 'number' && /Plant shift \*/.test(await page.textContent('#xf-host-enquiry')));
    await page.evaluate(() => {
      const c = document.getElementById('em-customer');
      c.value = 'Topworth Urja';
      c.dispatchEvent(new Event('input', { bubbles: true }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.fill('#em-requirement', 'Separator element');
    await page.click('#btn-save-enquiry');
    await page.waitForTimeout(300);
    ok('a required one empty stops the save', (await calls('saveSpareEnquiry')).length === 0 && /Fill in: Plant shift\./.test(await page.evaluate(() => document.body.innerText)));
    await page.selectOption('#xf-enquiry-plant_shift', 'Night');
    await page.fill('#xf-enquiry-running_hours', '12500');
    await page.click('#btn-save-enquiry');
    await page.waitForTimeout(500);
    const sv = await lastCall('saveCustomValues');
    ok('the record first, then its details', (await calls('saveSpareEnquiry')).length === 1 &&
      JSON.stringify(sv) === JSON.stringify(['enquiry', 'SE-9', { warranty_ends: '', plant_shift: 'Night', running_hours: '12500' }]), sv);

    console.log('\nA RECORD ALREADY HOLDING VALUES');
    await go('customers');
    await page.waitForTimeout(300);
    const head = await page.$$eval('#customers-tbody', (b) => [...b[0].closest('table').querySelectorAll('thead th')].map((t) => t.textContent));
    ok('a list column, before the Open button', head[head.length - 2] === 'Class', head);
    const row = await page.$eval('[data-edit-cust="CU-1"]', (b) => [...b.closest('tr').children].map((td) => td.textContent));
    ok('with the record’s value', row[row.length - 2] === 'B', row);
    await page.click('[data-edit-cust="CU-1"]');
    await page.waitForTimeout(400);
    ok('the form shows what it holds', await page.$eval('#xf-customer-class', (s) => s.value) === 'B' && await page.$eval('#xf-customer-vip', (c) => c.checked));
    await page.selectOption('#xf-customer-class', 'A');
    await page.uncheck('#xf-customer-vip');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#btn-save-customer');
    await page.waitForTimeout(600);
    ok('and saves what changed', JSON.stringify(await lastCall('saveCustomValues')) === JSON.stringify(['customer', 'CU-1', { class: 'A', vip: '' }]),
      await lastCall('saveCustomValues'));
    ok('the list follows', await page.$eval('[data-edit-cust="CU-1"]', (b) => { const c = b.closest('tr').children; return c[c.length - 2].textContent; }) === 'A');

    await page.evaluate(() => { window.__failNext = 'getCustomValues'; window.__calls = []; });
    await page.click('[data-edit-cust="CU-1"]');
    await page.waitForTimeout(400);
    ok('values that could not be read are not shown empty', /could not be loaded/.test(await page.textContent('#xf-host-customer')) && !(await page.$('#xf-customer-class')));
    await page.click('#btn-save-customer');
    await page.waitForTimeout(500);
    ok('nor saved over', (await calls('saveCustomValues')).length === 0 && (await calls('saveCustomer')).length === 1);

    console.log('\nEVERY FORM, AND A TASK');
    ok('a More details place on all eight windows', (await page.$$eval('.xf-sec[id^="xf-host-"]', (h) => h.map((x) => x.id.slice(8)))).sort().join() ===
      'amc,call,customer,enquiry,lead,service,task,visit');
    await page.evaluate(() => {
      const D = window.__data;
      window.__fields.task = [{ key: 'outcome', label: 'Outcome', type: 'textarea', options: [], required: false, inList: true }];
      const task = { id: 'T1', title: 'Call back Topworth', details: '', assigneeEmail: 'p@pie.in', assigneeName: 'Priya', byName: 'Anil', createdDay: '2026-10-28',
        dueDate: '2026-10-30', priority: 'Normal', status: 'Open', state: 'open', label: 'Open', possible: 0, earned: 0, canEdit: true, canTick: true, link: null };
      D.getTasks = () => ({ today: '2026-10-29', me: 'p@pie.in', boss: true, canScore: true, period: { key: 'month', from: '2026-10-01', to: '2026-10-31' },
        periods: [{ key: 'month', label: 'This month' }], scoring: { High: 15, Normal: 10, Low: 5, latePct: 50, overduePct: 50 }, priorities: ['High', 'Normal', 'Low'],
        statuses: ['Open', 'In progress', 'Done', 'Cancelled'], people: [{ email: 'p@pie.in', name: 'Priya', role: 'Sales Coordinator' }], scorecard: [], tasks: [task] });
      D.saveTask = (i) => Object.assign({}, task, i);
      D.getCustomValues = (form, ids) => (form === 'task' ? { T1: { outcome: 'Will send PO' } } : {});
    });
    await go('formfields');
    await go('tasks');
    ok('a task’s list column', await page.$eval('[data-tk-row="T1"]', (r) => r.lastElementChild.textContent) === 'Will send PO' &&
      await page.$eval('#tk-body thead tr', (r) => r.lastElementChild.textContent) === 'Outcome');
    await page.click('[data-tk-open="T1"]');
    await page.waitForTimeout(400);
    await page.fill('#xf-task-outcome', 'PO promised for Monday');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#btn-tk-save');
    await page.waitForTimeout(400);
    ok('saved with the task, nothing else changed', (await calls('saveTask')).length === 0 &&
      JSON.stringify(await lastCall('saveCustomValues')) === JSON.stringify(['task', 'T1', { outcome: 'PO promised for Monday' }]), await lastCall('saveCustomValues'));

    console.log('\nON THE BOARD');
    await page.evaluate(() => { window.__data.getCustomValues = (form, ids) => (form === 'enquiry' ? { E1: { warranty_ends: '2027-03-31' } } : {}); });
    await go('enquiries');
    await page.waitForTimeout(300);
    ok('a card carries its list fields', await page.$eval('[data-eb-card="SE:E1"] .xf-line', (l) => l.textContent) === 'Warranty ends: 31-03-2027');
    ok('only where there is a value', await page.$eval('[data-eb-card="SE:E2"] .xf-line', (l) => l.style.display) === 'none');
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
