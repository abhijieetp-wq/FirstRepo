/**
 * The Tender Desk's screens (JavaScript.html; Tenders.gs behind them), in a browser against
 * the real client: the menu, the desk with its alerts and board, the list, a tender's page
 * with its steps, its next step and what that needs, the sections as far as it has got, a new
 * tender read from its document by AI, the lists, who sees it at all, and the dashboard notice.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --title="ELGi Sales ERP"
 *   node tests/tenders-ui-test.js /tmp/show-v2.html [screenshot-dir]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
const SHOTS = process.argv[3];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
};

const html = fs.readFileSync(PREVIEW, 'utf8');
const BOOT = /role: "Management", businessStream: "All",/;
if (!BOOT.test(html)) throw new Error('the showcase user is not where this test expects it');
const variant = (name, user) => {
  const file = PREVIEW.replace(/\.html$/, '') + '.td-' + name + '.html';
  fs.writeFileSync(file, html.replace(BOOT, user));
  return file;
};

// What the server answers, invented.
const MOCK = () => {
  const STAGES = [['draft', 'Draft'], ['approval', 'Awaiting approval'], ['approved', 'Approved'], ['assigned', 'Assigned'], ['prep', 'In preparation'],
    ['ready', 'Ready to submit'], ['submitted', 'Submitted'], ['opened', 'Bid opened'], ['result', 'Result']].map((s) => ({ key: s[0], label: s[1] }));
  const RESULTS = { won: 'Won', lost: 'Lost / Regret', l2: 'L2 – not awarded', cancelled: 'Cancelled by client', declined: 'Not participating' };
  const PORTALS = ['GeM', 'Mahatenders', 'CPP Portal (eprocure.gov.in)', 'NTPC eTender', 'Other'].map((n, i) => ({ id: 'TPOR-' + (i + 1), name: n, description: '' }));
  const CATS = ['Goods supply', 'Works contract', 'Service', 'AMC', 'Turnkey'].map((n, i) => ({ id: 'TCAT-' + (i + 1), name: n, description: '' }));
  const CPS = Array.from({ length: 10 }, (_, i) => ({ id: 'TCHE-' + (i + 1), name: i === 0 ? 'Tender document read & saved' : 'Checkpoint ' + (i + 1), description: 'What it means.' }));
  const summary = (o) => Object.assign({ id: 'TN-1', tenderNo: 'TG/TTPS/2026/1187', title: 'Supply of screw air compressors for ash handling', customerName: 'Sahyadri Castings Pvt Ltd',
    portal: 'Mahatenders', category: 'Goods supply', priority: 'High', stage: 'draft', stageLabel: 'Draft', result: '', lastDate: '2026-12-01', dueTime: '15:00',
    daysLeft: 2, estimatedValue: 2450000, emdAmount: 49000, assigneeName: '', checklist: [0, 10], mine: false }, o);
  const tender = (o) => {
    const s = summary(o);
    return Object.assign({ id: s.id, tenderNo: s.tenderNo, title: s.title, customerId: 'CU-1', customerName: s.customerName, addressId: '', plant: 'Unit 8', portal: s.portal,
      category: s.category, priority: s.priority, publishedDate: '2026-11-18', lastDate: s.lastDate, dueTime: s.dueTime, estimatedValue: 2450000, emdAmount: 49000,
      emdType: 'Online', tenderFeeAmount: '', deliveryPeriod: '90 days', eligibility: 'OEM or authorised dealer', sdRequired: 'Yes', sdPct: 3, pbgRequired: '', pbgPct: '',
      ldClause: '', notes: '', stage: s.stage, result: s.result, approvalStatus: '', assigneeEmail: '', aiRead: '', prep: {}, checklist: {}, summary: s,
      addresses: [{ id: 'AD-1', label: 'Billing · Plot 12 · Pune' }], items: [{ description: 'Screw air compressor 160 cfm', qty: 2, uom: 'Nos', spec: 'IS 5456' }],
      documents: [], events: [{ at: '2026-11-20T10:00:00Z', byName: 'Anil Mehta', text: 'Entered' }], tasks: [],
      gate: { next: 'approval', action: 'Send for management approval', who: 'admin', open: 1, canAct: true,
        reqs: [{ ok: true, text: 'Tender number entered' }, { ok: false, text: 'Tender document attached' }] },
      can: { edit: true, prep: false, prepAccounts: false, checklist: false, postbid: false, decide: false, assign: false, withdraw: true, documents: true, remove: true },
      lists: { stages: STAGES, results: RESULTS, priorities: ['High', 'Medium', 'Low'], emdTypes: ['Online', 'Bank guarantee', 'Demand draft', 'Exempted (MSE / NSIC)', 'Not required'],
        uoms: ['Nos', 'Set', 'Mtr', 'Lot'], subModes: ['Online', 'Offline', 'Both'], portals: PORTALS, categories: CATS, lossReasons: [{ id: 'L1', name: 'Price higher than L1' }],
        checkpoints: CPS, prep: [{ key: 'enquiryDate', label: 'Vendor enquiry sent on', type: 'date', group: 'A' }, { key: 'min3', label: 'At least 3 manufacturers / offers', type: 'yn', group: 'B' },
          { key: 'emdBal', label: 'Tender account balance enough for the EMD', type: 'yna', group: 'C', accounts: true }],
        prepGroups: { A: 'A · Vendor enquiry', B: 'B · Comparative & negotiation', C: 'C · EMD & funds' }, docTypes: ['Tender document', 'Corrigendum', 'Other'] },
      people: [{ email: 'rohan@pie.invalid', name: 'Rohan Patil', role: 'Sales Engineer' }] }, o);
  };
  window.__td = { summary, tender, STAGES, RESULTS, PORTALS, CATS, CPS };
  const D = window.__data;
  D.getTenderDesk = () => ({ today: '2026-11-29', can: { create: true, approve: true, lists: true }, lists: { stages: STAGES, results: RESULTS, priorities: ['High', 'Medium', 'Low'], portals: PORTALS, categories: CATS },
    rules: { alertDays: 7, urgentDays: 3 },
    kpis: { live: 1, dueSoon: 1, overdue: 0, awaitingApproval: 1, awaitingResult: 0, wonFy: 2, wonFyValue: 9500000, decidedFy: 3, liveValue: 2450000 },
    alerts: [{ sev: 'bad', tenderId: 'TN-1', text: 'TG/TTPS/2026/1187 — due in 2 days', sub: 'Draft · checklist 0/10' },
      { sev: 'info', tenderId: 'TN-2', text: 'Approval needed: MS/OTH/9', sub: 'Another Test Mills', approval: true }],
    tenders: [summary({}), summary({ id: 'TN-2', tenderNo: 'MS/OTH/9', title: 'Dryers for the CW system', stage: 'approval', stageLabel: 'Awaiting approval', daysLeft: 12, priority: 'Medium' }),
      summary({ id: 'TN-3', tenderNo: 'GEM/2026/B/55', title: 'Air receivers', stage: 'result', stageLabel: 'Won', result: 'won', daysLeft: null })],
    people: [] });
  window.__tender = tender({});
  D.getTender = () => window.__tender;
  ['saveTender', 'saveTenderSection', 'advanceTender', 'decideTender', 'assignTender', 'withdrawTender', 'attachTenderDocument'].forEach((fn) => { D[fn] = () => window.__tender; });
  D.getTenderSettings = () => ({ canEdit: true, rules: { alertDays: 7, urgentDays: 3 }, lists: { portal: { name: 'Portals', items: PORTALS }, category: { name: 'Tender categories', items: CATS },
    lossReason: { name: 'Loss reasons', items: [{ id: 'TLOS-1', name: 'Price higher than L1', description: '' }] }, checkpoint: { name: 'Submission checklist', items: CPS } } });
  D.saveTenderList = () => D.getTenderSettings();
  D.readTenderDocument = () => ({ documentId: 'DOC-9', fileName: 'Tender document 2026-11-29 NIT.pdf', aiOff: '', matches: [{ id: 'CU-1', name: 'Sahyadri Castings Pvt Ltd' }],
    fields: { tenderNo: 'TG/KHT/1342', title: 'Oil-free compressors for unit 5', clientName: 'Sahyadri Castings', plant: 'Unit 5', portal: 'Mahatenders', category: 'Goods supply',
      publishedDate: '2026-11-28', lastDate: '2026-12-08', dueTime: '15:00', estimatedValue: 12640000, emdAmount: 126400, emdType: 'Online', tenderFeeAmount: 5900,
      deliveryPeriod: '120 days', sdPct: 3, pbgPct: 10, sdRequired: 'Yes', pbgRequired: 'Yes', ldClause: '0.5% per week', eligibility: 'OEM\nTurnover', unsure: ['emdType'],
      items: [{ description: 'Oil-free screw compressor 300 cfm', qty: 4, uom: 'Nos', spec: 'Class 0' }] } });
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const open = async (file) => { await page.goto('file://' + file); await page.waitForTimeout(1200); await page.evaluate(MOCK); };
  const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : ''; }, sel);
  const menu = () => page.$$eval('#tabs [data-view]', (b) => b.map((x) => x.dataset.view));
  const go = async (v) => { await page.evaluate((x) => document.querySelector('#tabs [data-view="' + x + '"]').click(), v); await page.waitForTimeout(700); };
  const lastCall = (fn) => page.evaluate((f) => { const c = (window.__calls || []).filter((x) => x.fn === f); return c.length ? c[c.length - 1].args : null; }, fn);
  const shown = (sel) => page.$eval(sel, (e) => !!e.offsetParent).catch(() => false);

  console.log('THE MENU');
  await open(PREVIEW);
  const m = await menu();
  ok('Management has the Tender Desk: the desk, the list and the settings, after Quotations', ['tenderdesk', 'tenders', 'tendersettings'].every((v) => m.includes(v)) &&
    !m.includes('tender') && m.indexOf('tenderdesk') > m.indexOf('quotations'), m);

  console.log('\nTHE DESK');
  await go('tenderdesk');
  ok('five tiles: live, due, awaiting approval, awaiting the result, won this year', (await page.$$('#td-kpis .pd-tile')).length === 5 &&
    /Won this year 2 ₹95,00,000 awarded/.test(await text('#td-kpis')), await text('#td-kpis'));
  ok('what needs attention, the urgent first', /Needs attention 2/.test(await text('#td-alerts')) && /due in 2 days/.test(await text('#td-alerts .td-alert.bad')));
  const cols = await page.$$eval('#td-board .td-col-h', (h) => h.map((x) => x.textContent.replace(/\s+\d+$/, '').trim()));
  ok('a board of the eight working steps, closed ones off it', cols.length === 8 && cols[0] === 'Draft' && cols[7] === 'Bid opened', cols);
  ok('each card: number, title, client, days left, priority, value', /TG\/TTPS\/2026\/1187 Supply of screw air compressors for ash handling Sahyadri Castings Pvt Ltd 2d left High ₹24,50,000/.test(await text('#td-board .td-card')),
    await text('#td-board .td-card'));
  ok('+ New tender for whoever enters tenders', await shown('#btn-td-new'));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tender-desk.png') });

  console.log('\nTHE LIST');
  await go('tenders');
  ok('open ones by default', (await page.$$('#td-list tbody tr.td-row')).length === 2);
  await page.selectOption('#td-show', 'closed');
  await page.waitForTimeout(150);
  ok('the closed ones, with their result', (await page.$$('#td-list tbody tr.td-row')).length === 1 && /Won/.test(await text('#td-list tbody')));
  await page.selectOption('#td-show', 'live');
  await page.fill('#td-q', 'dryers');
  await page.waitForTimeout(150);
  ok('searched', (await page.$$('#td-list tbody tr.td-row')).length === 1 && /MS\/OTH\/9/.test(await text('#td-list tbody')));
  await page.fill('#td-q', '');

  console.log('\nA TENDER’S PAGE');
  await page.click('#td-list tr[data-td-open="TN-1"]');
  await page.waitForTimeout(800);
  ok('its own screen, at its own address', await page.evaluate(() => document.getElementById('view-tender').classList.contains('active')));
  ok('the nine steps, on the first', (await page.$$('.td-step')).length === 9 && (await text('.td-step.cur')) === 'Draft');
  ok('the next step, with what it needs ticked or crossed', /Next step Send for management approval 1 open/.test(await text('.td-gate')) &&
    (await page.$$('.td-reqs li.no')).length === 1 && await page.$eval('#btn-td-advance', (b) => b.disabled));
  ok('the details, the items, documents, tasks and history; nothing further yet', ['Tender details', 'Bill of quantities', 'Documents', 'Tasks on this tender', 'History'].every((h) =>
    (cols, true)) && (await page.$$eval('.td-sec h3', (h) => h.map((x) => x.textContent))).join('|') === 'Tender details|Bill of quantities|Documents|Tasks on this tender|History');
  await page.fill('#tdf-title', 'Supply of screw air compressors, revised');
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#btn-td-save');
  await page.waitForTimeout(300);
  const saved = await lastCall('saveTender');
  ok('details saved, as typed', !!saved && saved[0].id === 'TN-1' && saved[0].title === 'Supply of screw air compressors, revised' && saved[0].customerId === 'CU-1' &&
    saved[0].portal === 'Mahatenders', saved);
  await page.click('[data-td-add-item]');
  await page.waitForTimeout(200);
  await page.fill('[data-td-item="1"] [data-k="description"]', 'Refrigerated air dryer 160 cfm');
  await page.fill('[data-td-item="1"] [data-k="qty"]', '2');
  await page.click('#btn-td-save-items');
  await page.waitForTimeout(300);
  const items = await lastCall('saveTender');
  ok('an item added and the list saved', !!items && items[0].items.length === 2 && items[0].items[1].description === 'Refrigerated air dryer 160 cfm' && items[0].items[1].uom === 'Nos', items);

  console.log('\nAPPROVAL AND ASSIGNING');
  await page.evaluate(() => { window.__tender = window.__td.tender({ stage: 'approval', summary: window.__td.summary({ stage: 'approval', stageLabel: 'Awaiting approval' }),
    gate: { next: 'approved', action: 'Approve participation', who: 'approver', open: 1, canAct: true, reqs: [{ ok: false, text: 'Management has approved participation' }] },
    can: { edit: true, decide: true, withdraw: true, documents: true } }); });
  await page.click('#btn-td-back');
  await page.waitForTimeout(500);
  await page.click('#td-list tr[data-td-open="TN-1"]');
  await page.waitForTimeout(700);
  await page.click('#btn-td-decline');
  await page.waitForTimeout(200);
  ok('declining asks for the reason first', (await lastCall('decideTender')) === null || (await page.evaluate(() => (window.__calls || []).filter((c) => c.fn === 'decideTender').length)) === 0);
  await page.fill('#td-decide-note', 'Repeat client.');
  await page.click('#btn-td-approve');
  await page.waitForTimeout(300);
  ok('Management approves from the page, with the note', JSON.stringify(await lastCall('decideTender')) === JSON.stringify(['TN-1', 'approve', 'Repeat client.']));
  await page.evaluate(() => { window.__tender = window.__td.tender({ stage: 'approved', summary: window.__td.summary({ stage: 'approved', stageLabel: 'Approved' }),
    gate: { next: 'assigned', action: 'Assign', who: 'admin', open: 1, canAct: true, reqs: [{ ok: false, text: 'Somebody with the Tender Desk chosen to prepare it' }] },
    can: { edit: true, assign: true, withdraw: true, documents: true } }); });
  await page.click('#btn-td-back');
  await page.waitForTimeout(500);
  await page.click('#td-list tr[data-td-open="TN-1"]');
  await page.waitForTimeout(700);
  await page.selectOption('#td-assignee', 'rohan@pie.invalid');
  await page.click('#btn-td-assign');
  await page.waitForTimeout(300);
  ok('assigned to somebody with the Tender Desk', JSON.stringify(await lastCall('assignTender')) === JSON.stringify(['TN-1', 'rohan@pie.invalid']));

  console.log('\nPREPARATION AND THE CHECKLIST');
  await page.evaluate(() => { const T = window.__td; window.__tender = T.tender({ stage: 'prep', assigneeEmail: 'rohan@pie.invalid', prep: { min3: 'Yes' },
    summary: T.summary({ stage: 'prep', stageLabel: 'In preparation', assigneeName: 'Rohan Patil' }),
    gate: { next: 'ready', action: 'Mark ready to submit', who: 'worker', open: 2, canAct: true, reqs: [{ ok: false, text: 'Vendor enquiry sent (date)' }] },
    can: { edit: true, prep: true, prepAccounts: true, checklist: true, assign: true, withdraw: true, documents: true } }); });
  await page.click('#btn-td-back');
  await page.waitForTimeout(500);
  await page.click('#td-list tr[data-td-open="TN-1"]');
  await page.waitForTimeout(700);
  ok('now with preparation, the checklist and the submission', (await page.$$eval('.td-sec h3', (h) => h.map((x) => x.textContent))).slice(0, 5).join('|') ===
    'Tender details|Bill of quantities|Preparation|Submission checklist|Submission');
  ok('preparation in its three groups, answers kept', /A · Vendor enquiry.*B · Comparative & negotiation.*C · EMD & funds/.test(await text('.td-main')) &&
    (await page.inputValue('#tdp-min3')) === 'Yes');
  await page.fill('#tdp-enquiryDate', '2026-11-25');
  await page.click('#btn-td-save-prep');
  await page.waitForTimeout(300);
  const prep = await lastCall('saveTenderSection');
  ok('preparation saved', !!prep && prep[0].section === 'prep' && prep[0].data.enquiryDate === '2026-11-25' && prep[0].data.min3 === 'Yes', prep);
  await page.click('[data-td-cp="TCHE-1"][data-v="Yes"]');
  await page.click('[data-td-cp="TCHE-2"][data-v="NA"]');
  await page.click('#btn-td-save-cps');
  await page.waitForTimeout(300);
  const cps = await lastCall('saveTenderSection');
  ok('the checklist: each point Yes, No or NA', !!cps && cps[0].section === 'checklist' && cps[0].data['TCHE-1'] === 'Yes' && cps[0].data['TCHE-2'] === 'NA' && cps[0].data['TCHE-3'] === '', cps);
  ok('CP1 named as on the checklist', /CP1 · Tender document read & saved/.test(await text('.td-cps')));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tender-page.png'), fullPage: true });

  console.log('\nA NEW TENDER, READ FROM ITS DOCUMENT');
  await go('tenderdesk');
  await page.click('#btn-td-new');
  await page.waitForTimeout(300);
  ok('the window asks for the document, or by hand', await shown('#td-new-file') && await page.$eval('#btn-td-read', (b) => b.disabled) && await shown('#btn-td-hand'));
  await page.setInputFiles('#td-new-file', { name: 'NIT 1342.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 invented') });
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#btn-td-read');
  await page.waitForTimeout(900);
  const asked = await lastCall('readTenderDocument');
  ok('the PDF goes to be read', !!asked && /^data:application\/pdf;base64,/.test(asked[0].dataUrl) && asked[0].name === 'NIT 1342.pdf');
  ok('the form comes back filled, the client matched to a customer', (await page.inputValue('#tdn-tenderNo')) === 'TG/KHT/1342' && (await page.inputValue('#tdn-customerId')) === 'CU-1' &&
    (await page.inputValue('#tdn-estimatedValue')) === '12640000' && (await page.inputValue('#tdn-portal')) === 'Mahatenders');
  ok('what the AI was unsure of marked to check, and said so', await page.$eval('#tdn-emdType', (e) => !!e.closest('.td-unsure')) && /Read by AI from/.test(await text('#td-new-form')) &&
    /The document says: Sahyadri Castings — Unit 5/.test(await text('#td-new-form')));
  ok('its items too', (await page.inputValue('#td-new-items [data-td-item="0"] [data-k="description"]')) === 'Oil-free screw compressor 300 cfm');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tender-new.png') });
  await page.click('#btn-td-new-save');
  await page.waitForTimeout(500);
  const created = await lastCall('saveTender');
  ok('saved as a draft, with the document and the items, marked as read by AI', !!created && created[0].tenderNo === 'TG/KHT/1342' && created[0].aiRead === true &&
    JSON.stringify(created[0].documentIds) === '["DOC-9"]' && created[0].items.length === 1 && Number(created[0].items[0].qty) === 4, created);

  console.log('\nTHE LISTS');
  await go('tendersettings');
  ok('portals, categories, loss reasons and the checklist, and the warning days', /Last-date warnings/.test(await text('#td-settings')) &&
    (await page.$$('#td-settings [data-td-list]')).length === 4);
  await page.click('[data-td-list-add="portal"]');
  await page.fill('[data-td-list="portal"] .td-list-row:last-child [data-k="name"]', 'MSEDCL portal');
  await page.click('[data-td-list-save="portal"]');
  await page.waitForTimeout(300);
  const list = await lastCall('saveTenderList');
  ok('a portal added, the others kept with their ids', !!list && list[0].list === 'portal' && list[0].items.length === 6 && list[0].items[0].id === 'TPOR-1' &&
    list[0].items[5].name === 'MSEDCL portal', list);

  console.log('\nWHO SEES IT');
  await open(variant('eng', 'role: "Sales Engineer", businessStream: "All",'));
  ok('a Sales Engineer without the tick does not', !(await menu()).some((v) => /^tender/.test(v)));
  await open(variant('engtick', 'role: "Sales Engineer", businessStream: "All", tenderDesk: true,'));
  ok('with it, does', (await menu()).includes('tenderdesk'));
  await open(variant('acc', 'role: "Accounts", businessStream: "All",'));
  const acc = await menu();
  ok('Accounts: the dashboard, tasks and the Tender Desk, nothing commercial', acc.includes('tenderdesk') && acc.includes('dashboard') && acc.includes('tasks') &&
    !acc.some((v) => ['quotations', 'orders', 'customers', 'catalog', 'compressor', 'enquiries'].includes(v)), acc);

  console.log('\nTHE DASHBOARD');
  await open(PREVIEW);
  await page.evaluate(() => {
    const D = window.__data;
    const was = D.getPersonDashboard;
    D.getPersonDashboard = function () {
      const d = typeof was === 'function' ? was.apply(null, arguments) : was;
      return Object.assign({}, d, { self: true, tenders: [{ sev: 'bad', tenderId: 'TN-1', text: 'TG/TTPS/2026/1187 — due in 2 days', sub: 'In preparation · checklist 3/10' }] });
    };
  });
  await go('tasks');
  await go('dashboard');
  await page.waitForTimeout(500);
  ok('tender deadlines on the dashboard', /Tenders 1 TG\/TTPS\/2026\/1187 — due in 2 days/.test(await text('.td-dash')), await text('.td-dash'));
  await page.click('.td-dash [data-td-open="TN-1"]');
  await page.waitForTimeout(700);
  ok('and they open the tender', await page.evaluate(() => document.getElementById('view-tender').classList.contains('active')));

  console.log('\nTHE USERS SCREEN');
  ok('a Tender Desk tick on each user', !!(await page.$('#usr-tenderdesk')));

  ok('no script errors', errors.length === 0, errors);
  await browser.close();
  for (const f of ['eng', 'engtick', 'acc']) { try { fs.unlinkSync(PREVIEW.replace(/\.html$/, '') + '.td-' + f + '.html'); } catch (e) { /* gone */ } }
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : 'all ') + pass + ' passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
