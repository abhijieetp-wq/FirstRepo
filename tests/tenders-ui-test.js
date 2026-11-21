/**
 * The Tender Desk's own page (tender/TenderDesk.html), in a browser, against the real server
 * module: every call the page makes to /api/call is answered by Tenders.gs on a real Postgres,
 * as the person the test is playing. The dashboard, Shortlisting, the tender board, a tender's
 * page and its gate, the PO with a quantity update, Tasks, Masters, a voice note, a tender read
 * from its document, the switch back to the ERP, a phone's width and the dark look.
 *
 * Everything in it is invented.
 *
 *   DATABASE_URL=postgres://... node tests/tenders-ui-test.js [screenshot-dir]
 */
const fs = require('fs');
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) { console.log('no DATABASE_URL — skipping'); process.exit(0); }

const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));
const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { syncSchema } = require(path.join(__dirname, '..', 'server', 'schema-sync.js'));

const SHOTS = process.argv[2];
const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
};

const TENANT = 'tenders-ui-test';
const TABLES = ['users', 'audit_log', 'sessions', 'customers', 'tenders', 'tender_pos', 'tender_events', 'tender_masters', 'documents', 'tasks'];
const drive = {
  getFoldersByName: () => ({ hasNext: () => false }),
  createFolder: () => ({ createFile: () => ({ getId: () => 'F1', getUrl: () => 'https://files.invalid/F1' }) }),
  getFileById: () => ({ setTrashed: () => {} })
};
let aiAnswer = null;
const ai = { enabled: true, reason: '', propose: async () => aiAnswer };

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => { for (const t of TABLES) { try { await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]); } catch (e) { /* none */ } } };
  await clean();
  const person = (id, username, name, role, extra) => db.appendRow('Users', Object.assign({ id, username, email: username + '@pie.invalid', name, role, businessStream: 'All', active: 'TRUE' }, extra || {}));
  // An admin of the Tender Desk by a grant of its own (Users.tenderAdmin), not by being Shortlisting.
  await person('U-COORD', 'isha', 'Isha Kulkarni', 'Sales Coordinator', { tenderDesk: 'TRUE', tenderAdmin: 'TRUE' });
  await person('U-MGMT', 'vikram', 'Vikram Joshi', 'Management');
  await person('U-ENG', 'rohan', 'Rohan Patil', 'Sales Engineer', { tenderDesk: 'TRUE' });
  await person('U-ENG3', 'sneha', 'Sneha Gokhale', 'Sales Engineer', { tenderDesk: 'TRUE' });
  await person('U-SVC', 'kiran', 'Kiran Pawar', 'Service Engineer', { tenderDesk: 'TRUE' });
  await person('U-ACC', 'neha', 'Neha Rao', 'Accounts');
  // An ERP customer, to show it is not one of the Tender Desk's clients.
  await db.appendRow('Customers', { id: 'CU-ERP', customerCode: 'E1', name: 'An ERP Customer Pvt Ltd', active: 'TRUE' });
  const p = loadPortal(db, 'isha@pie.invalid', { quiet: true, properties: {}, drive, ai });
  let actor = 'U-COORD';
  const as = async (id) => { actor = id; p.CURRENT_USER_ = await p.userFromRow_((await p.readTable_('Users')).find((u) => u.id === id)); };
  const inDays = (n) => { const d = new Date(Date.now() + 5.5 * 3600e3); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  // ---- invented work, entered through the module itself
  await as('U-COORD');
  // The Tender Desk's own clients, uploaded as a CSV would be.
  const cls = (await p.importTenderClients([{ Name: 'Test State Power Generation Co Ltd', 'Short name': 'TSPGCL', City: 'Nagpur' },
    { Name: 'Sample Transmission Utility', 'Short name': 'STU', City: 'Mumbai' }, { Name: 'Demo Thermal Power Station', 'Short name': 'DTPS', City: 'Mouda' },
    { Name: 'Another Test Mills', City: 'Pune' }])).state.clients;
  const CL = (n) => cls.find((c) => c.name.indexOf(n) === 0).id;
  const sup = (await p.saveTenderMaster('supplier', { name: 'Invented Motors Pvt Ltd', city: 'Nagpur', rating: 'A' })).state.suppliers[0].id;
  await p.saveTenderMaster('supplier', { name: 'Sample Electricals', city: 'Pune', rating: 'B' });
  const mk = async (o) => {
    const id = (await p.saveTenderFromDocument(Object.assign({ portal: 'TDM-portal-2', category: 'TDM-category-1', priority: 'Medium', dueTime: '15:00', emdType: 'Online', subType: 'Online',
      items: [{ desc: o.title, qty: 4, uom: 'Nos', spec: 'IS 325' }] }, o), '', false)).id;
    await p.attachTenderFile('tender', id, { name: 'NIT ' + o.no + '.pdf', dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF').toString('base64') });
    return id;
  };
  const tA = await mk({ no: 'TG/KTPS/2026/1187', title: 'Supply of 3.3 kV HT induction motors for ID fan drives', client: CL('Test State'), priority: 'High', lastDate: inDays(2), estCost: 18450000, emd: 184500 });
  const tB = await mk({ no: 'ST/O&M/NGP/2026/88', title: 'Distribution transformers 315 kVA, 11/0.433 kV', client: CL('Sample'), priority: 'High', lastDate: inDays(12), estCost: 9800000, emd: 98000 });
  const tC = await mk({ no: 'DT/MOUDA/CS-9921', title: 'Centrifugal pumps with LT motors for raw water pump house', client: CL('Demo'), lastDate: inDays(18), estCost: 4300000, emd: 86000 });
  await mk({ no: 'AM/RTPS/MM/2026/412', title: 'Cast steel gate valves 300 NB class 600', client: CL('Another'), priority: 'Low', lastDate: inDays(21), estCost: 2700000, emd: 27000 });
  const tW = await mk({ no: 'GEM/2026/B/5210077', title: 'Mandatory spares for HT motors (bearings, RTDs, terminal kits)', client: CL('Test State'), priority: 'Low', lastDate: inDays(30), estCost: 1450000, emd: 0, emdType: 'Exempted' });
  for (const id of [tA, tB, tC, tW]) await p.advanceTender(id);
  await as('U-MGMT');
  await as('U-COORD');
  const tE = await mk({ no: 'GEM/2026/B/5531902', title: 'MS ERW pipes 200 NB & 150 NB with weld-neck flanges', client: CL('Demo'), lastDate: inDays(6), estCost: 6200000, emd: 124000 });
  await as('U-COORD'); await p.advanceTender(tE);
  await as('U-MGMT');
  await p.approveTender(tA, 'Strategic – repeat client', 'rohan@pie.invalid');
  await p.approveTender(tW, 'Strategic – repeat client', 'sneha@pie.invalid');
  await p.approveTender(tE, '', 'rohan@pie.invalid');
  const PREP = [['enquiryDate', inDays(-5)], ['offersPerSpec', 'Yes'], ['tcAccepted', 'Yes'], ['min3', 'Yes'], ['compChart', 'Yes'], ['docsRecv', 'Yes'], ['nego', 'Yes'], ['finalVendor', sup]];
  await as('U-ENG');
  for (const [k, v] of PREP) { await p.saveTenderField(tA, 'prep.' + k, v); await p.saveTenderField(tE, 'prep.' + k, v); }
  await p.saveTenderField(tA, 'submission.value', 17900000);
  await p.saveTenderField(tE, 'submission.value', 5980000);
  await as('U-ACC'); await p.saveTenderField(tE, 'prep.emdBal', 'Yes');
  await as('U-ENG'); await p.advanceTender(tE);
  // The won one, by the shortlisting admin (who can work any tender).
  await as('U-COORD');
  for (const [k, v] of PREP) await p.saveTenderField(tW, 'prep.' + k, v);
  await p.saveTenderField(tW, 'submission.value', 1388000);
  await as('U-ACC'); await p.saveTenderField(tW, 'prep.emdBal', 'Yes');
  await as('U-COORD'); await p.advanceTender(tW);
  await as('U-MGMT'); await p.approveBid(tW, '');
  await as('U-COORD');
  const st0 = await p.getTenderApp();
  for (const c of st0.checklist) await p.saveTenderField(tW, 'checklist.' + c.id, 'Yes');
  for (const [k, v] of [['date', inDays(-1)], ['ack', 'GEM-BID-5210077'], ['quote', 'Quote']]) await p.saveTenderField(tW, 'submission.' + k, v);
  await p.advanceTender(tW);
  await p.saveTenderField(tW, 'postbid.technoDate', inDays(0)); await p.saveTenderField(tW, 'postbid.participants', 4); await p.advanceTender(tW);
  await p.saveTenderField(tW, 'postbid.result', 'won'); await p.saveTenderField(tW, 'postbid.l1', 1388000); await p.advanceTender(tW);
  const po = await p.createTenderPo({ tenderId: tW, no: 'GEMC-511687702544810', poDate: inDays(-50), dueDate: inDays(-5), value: 1388000, deliveryPeriod: '45 days', inspection: 'Yes', gaDrawing: 'No',
    ld: { rate: 0.5, per: 'week', cap: 10, basis: 'delayed', clause: 'GeM GTC: 0.5% per week of delayed value, max 10%.' }, sdPct: 3, sdDays: 30,
    items: [{ sr: 1, desc: 'Bearing set 6316 C3 for 630 kW motor', qty: 20, uom: 'Set', rate: 28500, due: inDays(-5), fp: 'kiran@pie.invalid' },
      { sr: 2, desc: 'PT100 RTD duplex, 3-wire', qty: 60, uom: 'Nos', rate: 4600, due: inDays(-5), fp: 'kiran@pie.invalid' },
      { sr: 3, desc: 'HT terminal box kit 3.3 kV', qty: 12, uom: 'Set', rate: 45000, due: inDays(-5), fp: 'kiran@pie.invalid' }] }, '');
  const pid = po.id;
  const items = po.state.pos[0].items;
  await as('U-SVC');
  for (const [i, t, q, d, r] of [[0, 'ordered', 20, -44, 'SPO/26/290'], [0, 'procured', 20, -12, 'GRN-1131'], [0, 'dispatched', 20, -9, 'LR 77120'], [0, 'delivered', 20, -6, 'DM 01'],
    [1, 'ordered', 60, -44, 'SPO/26/290'], [1, 'procured', 60, -8, 'GRN-1150'], [1, 'dispatched', 40, -4, 'LR 77188'], [2, 'ordered', 12, -41, 'SPO/26/297']]) {
    await p.recordPoMove(pid, items[i].id, { t, qty: q, date: inDays(d), ref: r, sup });
  }
  await as('U-COORD');
  await p.saveTenderTask({ title: 'Update supplier master with GSTIN for new pump vendors', assignee: 'isha@pie.invalid', due: inDays(6), priority: 'Low' });

  // ---- the browser, with /api/call answered by the module as `actor`
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('pie.erp.session', 'TEST-TOKEN'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  const calls = [];
  await page.route('**/*', async (route) => {
    const u = new globalThis.URL(route.request().url());
    if (u.hostname !== 'erp.test') return route.abort();
    if (/^\/tender-desk/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'tender', 'TenderDesk.html'), 'utf8') });
    if (u.pathname.startsWith('/fonts/')) {
      try { return route.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(ROOT, 'assets', 'fonts', path.basename(u.pathname))) }); } catch (e) { return route.abort(); }
    }
    if (u.pathname === '/api/call') {
      const { fn, args } = JSON.parse(route.request().postData());
      calls.push(fn);
      await as(actor);
      try {
        if (fn.slice(-1) === '_' || typeof p[fn] !== 'function') throw new Error('Unknown action: ' + fn);
        const out = await p[fn](...(args || []));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: out === undefined ? null : out }) });
      } catch (e) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: String(e.message) }) });
      }
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>the ERP</h1>' });
  });
  const shot = async (name, full) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); } };
  const settle = () => page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 15000 });
  const B = 'http://erp.test';

  console.log('THE DASHBOARD');
  await page.goto(B + '/tender-desk');
  await page.waitForSelector('.kpis .kpi');
  ok('its own page: the rail with its seven screens, not the ERP\'s menu', (await page.$$eval('.rail .nav-btn', (b) => b.map((x) => x.textContent.trim().replace(/\d+$/, '')))).join('|') === 'Dashboard|Shortlisting|Approvals|Tender submission|PO execution|Tasks|Masters');
  ok('eight figures', (await page.$$('.kpi')).length === 8);
  ok('the switch to the ERP, with the Tender Desk lit', (await page.textContent('.top .switch')).includes('ERP') && (await page.textContent('.switch .on')).includes('Tender Desk'));
  ok('what needs attention, LD first among them', /LD running on PO GEMC-511687702544810/.test(await page.textContent('.content')) && /due in 2 days/.test(await page.textContent('.content')));
  ok('the PO completion and the funnel', !!(await page.$('.qstack')) && (await page.$$('.funnel .fr')).length === 5);
  ok('no InfinityLab, no sample data', !/InfinityLab|Sample data|Reset sample/i.test(await page.content()));
  await shot('td-dashboard');

  console.log('SHORTLISTING AND TENDERS');
  await page.click('.nav-btn:has-text("Shortlisting")'); await settle();
  ok('the address follows', new globalThis.URL(page.url()).pathname === '/tender-desk/shortlisting');
  ok('upload a tender, enter by hand, and the approval waiting', (await page.$('[data-act="extractOpen"]')) && (await page.$('[data-act="newTender"]')) && /ST\/O&M\/NGP\/2026\/88/.test(await page.textContent('.content')));
  await shot('td-shortlisting');
  await page.click('.nav-btn[data-page="tenders"]'); await settle();
  ok('the board has a column for each step', (await page.$$eval('.kan .col-h', (h) => h.map((x) => x.firstChild.textContent.trim()))).join('|') ===
    'Shortlisting|Awaiting approval|Submission prep|Bid approval|Submit on portal|Submitted|Bid opened|Won|Lost / closed');
  await shot('td-tenders');
  await page.click('[data-act="view"][data-v="list"]');
  ok('and a list', (await page.$$('table.t tbody tr')).length === 6);
  await page.click('tr:has-text("TG/KTPS/2026/1187")'); await settle();
  ok('a tender\'s page: its address, the steps, the tabs and the gate', new globalThis.URL(page.url()).pathname === '/tender-desk/tenders/' + tA &&
    (await page.$$('.stepper .step')).length === 8 && (await page.$$('.tabs .tab')).length === 7 && /Send bid for management approval/.test(await page.textContent('.gate')));
  ok('the gate shows the one thing left: Accounts\' EMD answer', /1 open/.test(await page.textContent('.gate')) && /EMD balance sufficient/.test(await page.textContent('.gate li.no')));
  await shot('td-tender');
  await page.click('.tab[data-v="details"]');
  const plantId = '#f_' + ('t:' + tA + ':plant').replace(/[^a-zA-Z0-9]/g, '_');
  await page.fill(plantId, 'Koradi, Unit 8');
  await page.press(plantId, 'Tab');
  await settle();
  ok('a field typed is saved on the server', (await p.getTenderApp()).tenders.find((t) => t.id === tA).plant === 'Koradi, Unit 8');
  await page.click('.tab[data-v="prep"]');
  await page.click(`[data-ref="t:${tA}:prep.followUp"][data-v="Yes"]`); await settle();
  ok('a Yes / No is saved', (await p.getTenderApp()).tenders.find((t) => t.id === tA).prep.followUp === 'Yes');

  console.log('APPROVAL, AS MANAGEMENT');
  actor = 'U-MGMT';
  await page.goto(B + '/tender-desk'); await page.waitForSelector('.kpis');
  ok('Management sees what waits for it on the dashboard', /Waiting for your approval/.test(await page.textContent('.content')) && /GEM\/2026\/B\/5531902/.test(await page.textContent('.content')));
  ok('and Approvals in the menu, with the count, marked for them', (await page.textContent('.nav-btn[data-page="approvals"] .ct.hot')).trim() === '3');
  await page.click('.nav-btn[data-page="approvals"]'); await settle();
  ok('the approvals screen: each tender with its buttons, to bid for and bids to approve', (await page.$$('.appr button[data-act="approve"]')).length === 2 && (await page.$$('.appr button[data-act="bidApprove"]')).length === 1 &&
    (await page.$$('.appr button[data-act="bidReturn"]')).length === 1 && (await page.textContent('.appr button[data-act="approve"]')).includes('Approve'));
  await shot('td-approvals');
  await page.click(`[data-act="approve"][data-id="${tB}"]`);
  await page.selectOption('#f_n_owner', 'sneha@pie.invalid');
  await page.fill('#f_n_note', 'Go – BEE level 2 only');
  await page.click('[data-act="approveSave"]'); await settle();
  const b1 = (await p.getTenderApp()).tenders.find((t) => t.id === tB);
  ok('approved through the page: straight to the submission team, with its owner', b1.stage === 'prep' && b1.assignee === 'sneha@pie.invalid', b1.stage);
  await page.click(`[data-act="bidReturn"][data-id="${tE}"]`);
  ok('sending a bid back needs a reason', await page.$eval('[data-act="bidSave"]', (b) => b.disabled));
  await page.click('[data-act="closeModal"]');
  await page.click(`[data-act="bidApprove"][data-id="${tE}"]`);
  await page.click('[data-act="bidSave"]'); await settle();
  ok('a bid approved through the page: on to the portal', (await p.getTenderApp()).tenders.find((t) => t.id === tE).stage === 'ready');
  ok('and it shows under recently decided', /Bid approved: GEM\/2026\/B\/5531902/.test(await page.textContent('.content')));

  actor = 'U-COORD';
  await page.goto(B + '/tender-desk/approvals'); await page.waitForSelector('.appr');
  ok('somebody who is not an approver sees who it waits for, not buttons', !(await page.$('.appr button[data-act="approve"]')) && /Waiting for Vikram Joshi/.test(await page.textContent('.content')));

  console.log('THE PO');
  actor = 'U-SVC';
  await page.goto(B + '/tender-desk/po/' + pid); await page.waitForSelector('.ld-box');
  ok('its figures, the LD box and the items', (await page.$$('.kpis .kpi')).length === 5 && /Liquidated damages/.test(await page.textContent('.ld-box')) && (await page.$$('table.t tbody tr')).length === 3);
  await shot('td-po');
  await page.click(`[data-act="move"][data-it="${items[1].id}"]`);
  ok('the update opens on the first step still short for that item', await page.$eval('.modal .seg button.on', (b) => b.dataset.v) === 'dispatched');
  await page.click('[data-act="moveType"][data-v="delivered"]');
  await page.fill('#f_n_qty', '30');
  await page.fill('#f_n_ref', 'DM GeM/02'); await page.press('#f_n_ref', 'Tab');
  await page.click('[data-act="moveSave"]'); await settle();
  const after = (await p.getTenderApp()).pos.find((x) => x.id === pid).items[1].moves.slice(-1)[0];
  ok('recorded on the server, by him', after.t === 'delivered' && after.qty === 30 && after.by === 'kiran@pie.invalid');
  await page.click('.tab[data-v="terms"]');
  ok('inspection and GA drawing are Yes/No questions', (await page.$$('[data-act="seg"][data-ref$=":inspection"]')).length === 2 &&
    (await page.$$('[data-act="seg"][data-ref$=":gaDrawing"]')).length === 2 && !(await page.$('[data-act="attach"][data-kind="ga"]')));
  await page.click('[data-act="seg"][data-ref$=":gaDrawing"][data-v="Yes"]'); await settle();
  ok('GA drawing Yes asks for the drawing', !!(await page.$('[data-act="attach"][data-kind="ga"]')) && (await p.getTenderApp()).pos.find((x) => x.id === pid).gaDrawing === 'Yes');
  const ga = path.join(require('os').tmpdir(), 'td-ui-ga.pdf');
  fs.writeFileSync(ga, '%PDF-1.4 invented GA');
  await page.click('[data-act="attach"][data-kind="ga"]');
  await page.setInputFiles('#filepick', ga);
  await page.waitForFunction(() => /td-ui-ga\.pdf/.test(document.querySelector('.content').textContent), null, { timeout: 15000 }); await settle();
  ok('attached under GA drawing, apart from the PO document', (await p.getTenderApp()).pos.find((x) => x.id === pid).docs.some((d) => d.type === 'GA drawing' && /td-ui-ga/.test(d.name)));
  await shot('td-po-terms');
  await page.click('.tab[data-v="money"]');
  ok('invoices and payments: he only looks', /kept by Accounts/.test(await page.textContent('.content')) && !(await page.$('[data-act="addRow"][data-list="invoices"]')) &&
    await page.$eval('[data-act="addRow"][data-list="payments"]', () => false).catch(() => true));
  actor = 'U-ACC';
  await page.reload(); await page.waitForSelector('.ld-box');
  await page.click('.tab[data-v="money"]');
  ok('Accounts keeps them', !!(await page.$('[data-act="addRow"][data-list="invoices"]')) && !/kept by Accounts/.test(await page.textContent('.content')));
  await shot('td-po-money');
  actor = 'U-SVC';
  await page.reload(); await page.waitForSelector('.ld-box');
  await page.click('[data-act="go"][data-page="pos"]'); await settle();
  await shot('td-pos');

  console.log('TASKS AND MASTERS');
  actor = 'U-COORD';
  await page.goto(B + '/tender-desk/tasks'); await page.waitForSelector('.kan');
  ok('four columns, the ERP\'s statuses', (await page.$$eval('.kan .col-h', (h) => h.map((x) => x.firstChild.textContent.trim()))).join('|') === 'To do|In progress|Waiting on others|Done');
  await page.click('[data-act="newTask"]');
  await page.fill('#f_k_title', 'Get the revised offer from the supplier');
  await page.selectOption('#f_k_assignee', 'rohan@pie.invalid');
  await page.click('[data-act="kSave"]'); await settle();
  ok('a task given from the page', (await p.readTable_('Tasks')).some((k) => k.title === 'Get the revised offer from the supplier' && k.assigneeEmail === 'rohan@pie.invalid'));
  await page.click('.seg button[data-v="all"]');
  await shot('td-tasks');
  await page.goto(B + '/tender-desk/masters'); await page.waitForSelector('.tabs');
  const mtabs = await page.$$eval('.tabs .tab', (t) => t.map((x) => x.firstChild.textContent.trim()));
  ok('the masters as in the design, with Clients and Task statuses', ['Team members', 'Products', 'Clients', 'Suppliers', 'Portals', 'Tender categories', 'Units (UOM)', 'Loss / regret reasons', 'Submission checklist', 'Custom fields', 'Task statuses', 'Rules & alerts'].every((x) => mtabs.includes(x)), mtabs);
  await shot('td-masters');
  await page.click('.tab[data-v="clients"]');
  ok('clients are the Tender Desk\'s own: its list, not the ERP\'s Customers', (await page.inputValue('#m_clients_' + CL('Test State') + '_name')) === 'Test State Power Generation Co Ltd' &&
    !/An ERP Customer/.test(await page.content()));
  ok('with a CSV upload and its template', !!(await page.$('[data-act="clientCsv"]')) && !!(await page.$('[data-act="clientTemplate"]')));
  const csv = path.join(require('os').tmpdir(), 'td-ui-clients.csv');
  fs.writeFileSync(csv, '\uFEFFName,Short name,City,State,GSTIN\r\n"Coastal Power Co, Unit 2",CPC,Ratnagiri,Maharashtra,\r\nTest State Power Generation Co Ltd,,Koradi,,\r\n,,,,\r\nBad GST Co,,,,12\r\n');
  await page.setInputFiles('#csvpick', csv);
  // The file is read in the browser before the call starts, so wait for its answer, not for quiet.
  await page.waitForFunction(() => /\d+ added, \d+ updated/.test((document.querySelector('.content') || {}).textContent || ''), null, { timeout: 15000 }); await settle();
  ok('a CSV uploaded from the page: added, updated, the bad line said', /1 added, 1 updated, 1 skipped: line 5/.test(await page.textContent('.content')) &&
    (await p.getTenderApp()).clients.some((c) => c.name === 'Coastal Power Co, Unit 2' && c.city === 'Ratnagiri'), [await page.textContent('.note'), (await p.getTenderApp()).clients.map((c) => c.name + '/' + c.city)]);
  await shot('td-clients');
  await page.click('.tab[data-v="members"]');
  ok('the team can be given the combined role', (await page.$$eval('select[data-member] option', (o) => o.map((x) => x.textContent))).includes('Shortlisting & Executive'));
  ok('and PO Execution', (await page.$$eval('select[data-member] option', (o) => o.map((x) => x.textContent))).includes('PO Execution'));
  // Admin is a tick of its own on the team list, given by a fellow admin.
  ok('the team shows who is an admin', (await page.$$eval('input[data-admin]', (b) => b.filter((x) => x.checked).length)) === 1 &&
    await page.$eval('input[data-admin="isha@pie.invalid"]', (b) => b.disabled));
  page.once('dialog', (d) => d.accept());
  await page.check('input[data-admin="rohan@pie.invalid"]'); await settle();
  ok('an admin makes a colleague an admin from the list', (await p.readTable_('Users')).find((u) => u.id === 'U-ENG').tenderAdmin === 'TRUE');
  page.once('dialog', (d) => d.accept());
  await page.uncheck('input[data-admin="rohan@pie.invalid"]'); await settle();
  ok('and takes it away again', (await p.readTable_('Users')).find((u) => u.id === 'U-ENG').tenderAdmin !== 'TRUE');
  actor = 'U-MGMT';
  await page.reload(); await page.waitForSelector('.tabs');
  await page.click('.tab[data-v="members"]');
  ok('Management that is not an admin only looks at the team', !(await page.$('[data-act="memberNew"]')) && /View only/.test(await page.textContent('.content')));
  actor = 'U-COORD';
  await page.reload(); await page.waitForSelector('.tabs');
  await page.click('.tab[data-v="members"]');
  await page.click('[data-act="memberNew"]');
  ok('a new member: a Tender Desk only account, its first password made ready', /Tender Desk only/.test(await page.textContent('.modal')) && (await page.inputValue('#f_n_password')).length >= 10);
  await page.fill('#f_n_name', 'Pooja Wankhede');
  await page.fill('#f_n_username', 'pooja'); await page.press('#f_n_username', 'Tab');
  await page.selectOption('#f_n_role', 'exec');
  const firstPw = await page.inputValue('#f_n_password');
  await shot('td-new-member');
  await page.click('[data-act="memberSave"]'); await settle();
  const prow = (await p.readTable_('Users')).find((u) => u.username === 'pooja');
  ok('the account is opened, and how to sign in is shown once', prow && prow.role === 'Tender Desk only' && prow.tenderRole === 'exec' &&
    (await page.textContent('.note.ok')).includes('pooja') && (await page.textContent('.note.ok')).includes(firstPw));
  ok('on the team, marked Tender Desk only, with its password and close buttons', /Tender Desk only/.test(await page.textContent('table.t')) && !!(await page.$('[data-act="memberPw"]')) && !!(await page.$('[data-act="memberClose"]')));
  await shot('td-team');
  actor = prow.id;
  await page.goto(B + '/tender-desk'); await page.waitForSelector('.kpis');
  ok('she sees the Tender Desk with Sign out, and no way to the ERP', !(await page.$('.switch')) && !!(await page.$('[data-act="signOut"]')) && !(await page.$('a[href="/dashboard"]')));
  actor = 'U-COORD';
  await page.goto(B + '/tender-desk/masters'); await page.waitForSelector('.tabs');
  await page.click('.tab[data-v="portals"]');
  await page.click('[data-act="mAdd"]');
  await page.fill('#m_portals_new_name', 'KPCL eProcurement'); await page.press('#m_portals_new_name', 'Tab'); await settle();
  ok('a portal added from the page', (await p.getTenderApp()).portals.some((x) => x.name === 'KPCL eProcurement'));

  console.log('A VOICE NOTE, AND A TENDER FROM ITS DOCUMENT');
  aiAnswer = { summary: 'One task.', actions: [{ type: 'task', title: 'Call Invented Motors about the balance', assignee: 'Rohan', due: inDays(1), priority: 'High', link: 'TG/KTPS/2026/1187', po: '', item: '', movement: '', qty: '', date: '', reference: '', supplier: '', text: '', checklist: [] }] };
  await page.click('[data-act="voice"]');
  await page.fill('#f_v_text', 'Ask Rohan to call Invented Motors tomorrow about the balance');
  await page.click('[data-act="vProcess"]');
  await page.waitForSelector('[data-act="vApply"]');
  await shot('td-voice');
  await page.click('[data-act="vApply"]'); await settle();
  ok('the task it made is created', (await p.readTable_('Tasks')).some((k) => k.title === 'Call Invented Motors about the balance' && k.source === 'voice'));
  await page.click('[data-act="closeModal"]');
  aiAnswer = { no: 'TG/KHT/2026/1342', title: 'Oil-free compressors for unit 5', clientName: 'Demo Thermal Power', plant: 'Unit 5', portalName: 'GeM', category: 'Goods Supply',
    publishedDate: inDays(-1), lastDate: inDays(9), dueTime: '15:00', estCost: '12640000', tenderFee: '5900', emd: '126400', emdType: 'Online', bgOk: 'Yes', subType: 'Online',
    payTerms: '100% in 60 days', sdReq: 'Yes', sdPct: '3', pbgReq: 'Yes', pbgPct: '10', deliveryPeriod: '120 days', ldClause: '0.5% per week, max 10%', eligibility: ['OEM or authorised dealer'],
    items: [{ desc: 'Oil-free screw compressor 500 cfm', qty: '2', uom: 'Nos', spec: 'ISO 8573 class 0' }], unsure: ['emd'] };
  await page.goto(B + '/tender-desk/shortlisting'); await page.waitForSelector('.hero');
  await page.click('[data-act="extractOpen"]');
  const tmp = path.join(require('os').tmpdir(), 'td-ui-nit.pdf');
  fs.writeFileSync(tmp, '%PDF-1.4 invented');
  await page.setInputFiles('#filepick', tmp);
  await page.waitForSelector('[data-act="xSave"]', { timeout: 15000 });
  ok('read into the form, the unsure field marked', (await page.inputValue('#f_x_no')) === 'TG/KHT/2026/1342' && !!(await page.$('#f_x_emd.lowc')));
  ok('the client suggested from the client list', (await page.inputValue('#f_x_client')) === 'Demo Thermal Power Station');
  await shot('td-new-tender');
  await page.click('[data-act="xSave"][data-send="1"]'); await settle();
  const nt = (await p.getTenderApp()).tenders.find((t) => t.no === 'TG/KHT/2026/1342');
  ok('saved and sent for approval in one go', nt && nt.stage === 'approval' && nt.client === CL('Demo'), nt && nt.stage);
  ok('and the page opened it', new globalThis.URL(page.url()).pathname === '/tender-desk/tenders/' + nt.id);

  // A client added by hand, from the tender's own client field.
  await page.click('.tab[data-v="details"]').catch(() => {});
  await page.click('[data-act="newClient"]');
  await page.fill('#f_n_name', 'Brand New Utility');
  await page.fill('#f_n_city', 'Chandrapur'); await page.press('#f_n_city', 'Tab');
  await shot('td-new-client');
  await page.click('[data-act="clientSave"]'); await settle();
  const fresh = (await p.getTenderApp());
  const bn = fresh.clients.find((c) => c.name === 'Brand New Utility');
  ok('a new client added by hand from the tender, and chosen for it', bn && bn.city === 'Chandrapur' && fresh.tenders.find((t) => t.id === nt.id).client === bn.id);

  console.log('THE SWITCH, A PHONE, THE DARK LOOK');
  await page.goto(B + '/tender-desk'); await page.waitForSelector('.switch');
  ok('the switch links to the ERP\'s dashboard', await page.getAttribute('.switch a', 'href') === '/dashboard');
  await page.click('[data-act="theme"]');
  ok('dark, remembered as the ERP keeps it', await page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' && localStorage.getItem('erp.theme') === 'dark'));
  await shot('td-dashboard-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload(); await page.waitForSelector('.kpis');
  ok('no sideways scroll on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot('td-phone');
  ok('no script errors', errors.length === 0, errors);
  ok('and nothing it called was refused as unknown', !calls.some((c) => /Unknown/.test(c)));

  await browser.close();
  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : 'all ') + pass + ' passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
