/**
 * The Tender Desk (Tenders.gs), against a real Postgres: who is on it and as what, a tender from
 * its document (read by AI) to the result through its nine gates, approval and assigning with
 * their tasks, the client's PO with its items moved to delivery, LD worked out from the dates,
 * invoices, payments, SD / PBG and closing, tasks on the main Tasks list, voice notes, the
 * masters and the rules, and the ERP dashboard's switch.
 *
 * People, customers, tenders and POs are invented.
 *
 *   DATABASE_URL=postgres://... node tests/tenders-sql-test.js
 */
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { syncSchema } = require(path.join(__dirname, '..', 'server', 'schema-sync.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 700) : ''));
};
const refuses = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re.test(String(e.message)) || String(e.message); }
};

const TENANT = 'tenders-test';
const TABLES = ['users', 'audit_log', 'sessions', 'customers', 'tenders', 'tender_pos', 'tender_events', 'tender_masters', 'documents', 'tasks'];

const files = {};
let fileN = 0;
const drive = {
  getFoldersByName: () => ({ hasNext: () => false }),
  createFolder: () => ({ createFile: (blob) => { const id = 'F' + (++fileN); files[id] = { blob, trashed: false }; return { getId: () => id, getUrl: () => 'https://files.invalid/' + id }; } }),
  getFileById: (id) => ({ setTrashed: (v) => { if (files[id]) files[id].trashed = v; } })
};
let aiAsked = null;
let aiAnswer = null;
const ai = { enabled: true, reason: '', propose: async (req) => { aiAsked = req; return typeof aiAnswer === 'function' ? aiAnswer(req) : aiAnswer; } };

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => { for (const t of TABLES) { try { await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]); } catch (e) { /* no table */ } } };
  await clean();
  const person = (id, username, name, role, extra) => db.appendRow('Users', Object.assign({ id, username, email: username + '@pie.invalid', name, role,
    businessStream: 'All', active: 'TRUE' }, extra || {}));
  await person('U-ADMIN', 'office', 'Office Admin', 'ERP Admin');
  await person('U-MGMT', 'vikram', 'Vikram Joshi', 'Management');
  await person('U-COORD', 'isha', 'Isha Kulkarni', 'Sales Coordinator', { tenderDesk: 'TRUE' });
  await person('U-ENG', 'rohan', 'Rohan Patil', 'Sales Engineer', { tenderDesk: 'TRUE' });
  await person('U-ENG2', 'amol', 'Amol Shinde', 'Sales Engineer');
  await person('U-ACC', 'neha', 'Neha Rao', 'Accounts');
  await person('U-SVC', 'kiran', 'Kiran Pawar', 'Service Engineer', { tenderDesk: 'TRUE' });
  await person('U-SVCC', 'meera', 'Meera Das', 'Service Coordinator', { tenderDesk: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-GEN', customerCode: 'TG1', name: 'Test State Power Generation Co Ltd', active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-OTHER', customerCode: 'TO1', name: 'Another Test Mills', active: 'TRUE' });

  const p = loadPortal(db, 'office@pie.invalid', { quiet: true, properties: {}, drive, ai });
  const as = async (id) => {
    const r = (await p.readTable_('Users')).find((u) => u.id === id);
    p.CURRENT_USER_ = await p.userFromRow_(r);
    return p.CURRENT_USER_;
  };
  const pdf = { name: 'NIT.pdf', dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 invented tender').toString('base64') };
  const inDays = (n) => { const d = new Date(Date.now() + 5.5 * 3600e3); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  console.log('WHO IS ON THE TENDER DESK, AND AS WHAT');
  await as('U-ADMIN');
  let st = await p.getTenderApp();
  const roleOf = (s, email) => (s.members.find((m) => m.id === email) || {}).role;
  ok('the ERP admin starts as Shortlisting & Admin and may keep the team', st.me.role === 'shortlist' && st.me.team === true && st.me.masters === true, st.me);
  ok('Management, Accounts and the ticked users are members, each as their ERP role starts them',
    roleOf(st, 'vikram@pie.invalid') === 'mgmt' && roleOf(st, 'neha@pie.invalid') === 'accounts' && roleOf(st, 'isha@pie.invalid') === 'shortlist' &&
    roleOf(st, 'rohan@pie.invalid') === 'exec' && roleOf(st, 'kiran@pie.invalid') === 'fp' && roleOf(st, 'meera@pie.invalid') === 'items', st.members);
  ok('the unticked engineer is not on it, and is offered to add', !roleOf(st, 'amol@pie.invalid') && st.others.some((o) => o.id === 'amol@pie.invalid'));
  await as('U-ENG2');
  ok('nor can he open it', await refuses(() => p.getTenderApp(), /not open to your account/));
  await as('U-MGMT');
  st = (await p.saveTenderMember('amol@pie.invalid', 'exec', true)).state;
  ok('Management adds him, as a Tender Executive', roleOf(st, 'amol@pie.invalid') === 'exec');
  ok('Accounts cannot be taken off', await refuses(() => p.saveTenderMember('neha@pie.invalid', null, false), /always has the Tender Desk/));
  await as('U-COORD');
  ok('a coordinator cannot change the team', await refuses(() => p.saveTenderMember('amol@pie.invalid', 'fp', null), /Management or the ERP Admin/));
  ok('the defaults are there before anybody keeps a master', st.portals.length === 5 && st.checklist.length === 10 && st.uoms.some((u) => u.name === 'Nos') && st.cfg.alertDays === 7);

  console.log('A TENDER FROM ITS DOCUMENT');
  aiAnswer = { no: 'TG/KTPS/2026/1187', title: 'Supply of screw air compressors for ash handling', clientName: 'Test State Power Generation', plant: 'Unit 8',
    portalName: 'Mahatenders portal', category: 'Goods Supply', publishedDate: inDays(-2), lastDate: inDays(10), dueTime: '15:00', estCost: 'Rs. 24,50,000/-',
    tenderFee: '5900', emd: '49,000', emdType: 'Online', bgOk: 'yes', subType: 'Online', payTerms: '100% within 60 days', sdReq: '', sdPct: '3', pbgReq: 'No', pbgPct: '',
    deliveryPeriod: '90 days', ldClause: '0.5% per week, max 10%', eligibility: ['OEM or authorised dealer', ''], items: [{ desc: 'Screw air compressor 160 cfm', qty: '2', uom: 'nos', spec: 'IS 5456' }, { desc: '', qty: '', uom: '', spec: '' }],
    unsure: ['emd'] };
  await as('U-ENG');
  ok('an executive cannot enter a tender', await refuses(() => p.readTenderDocument(pdf), /Shortlisting & Admin/));
  await as('U-COORD');
  const read = await p.readTenderDocument(pdf);
  ok('the PDF goes to Claude as a document, before the instruction', aiAsked && aiAsked.content[0].type === 'document' && aiAsked.content[0].source.media_type === 'application/pdf' && aiAsked.content[1].type === 'text');
  ok('what it read comes back as the form: money as numbers, lists matched, Yes/No made', read.data.no === 'TG/KTPS/2026/1187' && read.data.estCost === 2450000 && read.data.emd === 49000 &&
    read.data.portal === 'TDM-portal-2' && read.data.category === 'TDM-category-1' && read.data.bgOk === 'Yes' && read.data.sdReq === 'Yes' && read.data.pbgReq === 'No' &&
    read.data.items.length === 1 && read.data.items[0].uom === 'Nos' && read.data.items[0].qty === 2 && read.data.eligText === 'OEM or authorised dealer', read.data);
  ok('the client is matched in Customers, and what it was unsure of is marked', read.data.client === 'CU-GEN' && read.matches[0].id === 'CU-GEN' && read.conf.emd === 0.5, read);
  let res = await p.saveTenderFromDocument(Object.assign({}, read.data, { dueTime: '' }), read.documentId, true);
  const tid = res.id;
  let t = res.state.tenders.find((x) => x.id === tid);
  ok('saved and sent: still a draft, because the due time is missing', t.stage === 'draft' && /fill the fields marked in red/.test(res.message) &&
    t.gate.reqs.some((r) => !r.ok && /Due time/.test(r.t)), res.message);
  ok('the document is filed against it', t.docs.length === 1 && t.aiRead === 'TRUE');
  res = await p.saveTenderField(tid, 'dueTime', '15:00');
  ok('a bad time is refused', await refuses(() => p.saveTenderField(tid, 'dueTime', '3pm'), /hours and minutes/));
  ok('a field that does not exist is refused', await refuses(() => p.saveTenderField(tid, 'stage', 'won'), /cannot be changed here/));
  ok('the client must be in Customers', await refuses(() => p.saveTenderField(tid, 'client', 'CU-NOPE'), /not in Customers/));

  console.log('APPROVAL AND ASSIGNING');
  await as('U-ENG');
  ok('an executive cannot change a tender not assigned to him', await refuses(() => p.saveTenderField(tid, 'title', 'x'), /look at this tender but not change/));
  await as('U-COORD');
  res = await p.advanceTender(tid);
  t = res.state.tenders.find((x) => x.id === tid);
  ok('sent for approval', t.stage === 'approval' && t.approval.status === 'pending', t.stage);
  ok('Management gets a task to approve, on the main Tasks list', res.state.tasks.some((k) => k.link === 't:' + tid && /^Approve participation/.test(k.title) && k.assignee === 'vikram@pie.invalid'));
  const erpTasks = await p.readTable_('Tasks');
  ok('the task is an ERP task linked to the tender', erpTasks.some((k) => k.linkKind === 'tender' && k.linkId === tid && k.module === 'tender' && k.source === 'auto'));
  ok('only Management approves', await refuses(() => p.approveTender(tid, ''), /Management/));
  await as('U-MGMT');
  res = await p.approveTender(tid, 'Repeat client – quote sharp');
  t = res.state.tenders.find((x) => x.id === tid);
  ok('approved, and moved on; the approval task is done', t.stage === 'approved' && t.approval.by === 'vikram@pie.invalid' &&
    res.state.tasks.find((k) => /^Approve participation/.test(k.title)).status === 'Done');
  await as('U-COORD');
  ok('the assignee must be on the Tender Desk', await refuses(() => p.saveTenderField(tid, 'assignee', 'kiran@nowhere.invalid'), /on the Tender Desk/));
  await p.saveTenderField(tid, 'assignee', 'kiran@pie.invalid');
  st = await p.getTenderApp();
  ok('a fulfilment person is not an executive: the gate says so', st.tenders.find((x) => x.id === tid).gate.reqs.some((r) => !r.ok && /Tender Executive role/.test(r.t)));
  await p.saveTenderField(tid, 'assignee', 'rohan@pie.invalid');
  res = await p.advanceTender(tid);
  t = res.state.tenders.find((x) => x.id === tid);
  ok('assigned, with a task carrying the checklist', t.stage === 'assigned' && res.state.tasks.some((k) => k.assignee === 'rohan@pie.invalid' && /^Prepare & submit bid/.test(k.title) && k.checklist.length === 10));

  console.log('PREPARATION, THE CHECKLIST AND SUBMISSION');
  await as('U-ENG2');
  ok('another executive cannot take his step', await refuses(() => p.advanceTender(tid), /can do this step/));
  await as('U-ENG');
  await p.advanceTender(tid);
  for (const [k, v] of [['enquiryDate', inDays(-1)], ['offersPerSpec', 'Yes'], ['tcAccepted', 'Yes'], ['min3', 'Yes'], ['compChart', 'Yes'], ['docsRecv', 'NA'], ['nego', 'Yes']]) {
    await p.saveTenderField(tid, 'prep.' + k, v);
  }
  await as('U-ADMIN');
  st = (await p.saveTenderMaster('supplier', { name: 'Invented Motors Pvt Ltd', city: 'Nagpur', rating: 'A' })).state;
  const supId = st.suppliers.find((s) => s.name === 'Invented Motors Pvt Ltd').id;
  await as('U-ENG');
  await p.saveTenderField(tid, 'prep.finalVendor', supId);
  st = await p.getTenderApp();
  ok('preparation waits on Accounts for the EMD balance', st.tenders.find((x) => x.id === tid).gate.reqs.filter((r) => !r.ok).map((r) => r.t).join() === 'Tender account EMD balance sufficient');
  await as('U-ACC');
  ok('Accounts cannot change the tender itself', await refuses(() => p.saveTenderField(tid, 'title', 'x'), /not change it/));
  await p.saveTenderField(tid, 'prep.emdBal', 'Yes');
  await as('U-ENG');
  res = await p.advanceTender(tid);
  ok('ready to submit', res.state.tenders.find((x) => x.id === tid).stage === 'ready');
  const cps = res.state.checklist;
  for (const c of cps) await p.saveTenderField(tid, 'checklist.' + c.id, 'Yes');
  res = await p.saveTenderField(tid, 'checklist.' + cps[2].id, 'No');
  ok('a checkpoint going back is on the record', res.state.tenders.find((x) => x.id === tid).log.some((e) => /Checklist went back: EMD arranged/.test(e.text)));
  await p.saveTenderField(tid, 'checklist.' + cps[2].id, 'NA');
  for (const [k, v] of [['date', inDays(0)], ['ack', 'MT-2026-1187-55410'], ['value', '2310000'], ['quote', 'Quote']]) await p.saveTenderField(tid, 'submission.' + k, v);
  res = await p.advanceTender(tid);
  t = res.state.tenders.find((x) => x.id === tid);
  ok('submitted; the preparation task is done', t.stage === 'submitted' && t.ck[0] === 10 && res.state.tasks.find((k) => /^Prepare & submit bid/.test(k.title)).status === 'Done');
  await p.saveTenderField(tid, 'postbid.technoDate', inDays(0));
  await p.saveTenderField(tid, 'postbid.participants', '5');
  await p.advanceTender(tid);
  await p.saveTenderField(tid, 'postbid.result', 'won');
  st = await p.getTenderApp();
  ok('a win needs the L1 value', st.tenders.find((x) => x.id === tid).gate.reqs.some((r) => !r.ok && /L1/.test(r.t)));
  await p.saveTenderField(tid, 'postbid.l1', '2310000');
  res = await p.advanceTender(tid);
  t = res.state.tenders.find((x) => x.id === tid);
  ok('won, with the next step said', t.stage === 'result' && t.result === 'won' && /upload the client’s PO/.test(res.message));
  await as('U-SVCC');
  ok('and Items Entry is asked for the PO', (await p.getTenderApp()).alerts.some((a) => /Won but PO not entered/.test(a.t)));
  await as('U-ENG');

  console.log('NOT PARTICIPATING');
  await as('U-COORD');
  res = await p.newTender();
  const t2 = res.id;
  ok('a draft entered by hand', res.state.tenders.find((x) => x.id === t2).stage === 'draft');
  res = await p.declineTender(t2, 'decline', 'Value too low', 'below our minimum');
  ok('marked not participating, with the reason', res.state.tenders.find((x) => x.id === t2).result === 'declined' && /Value too low – below our minimum/.test(res.state.tenders.find((x) => x.id === t2).postbid.reason));

  console.log('THE CLIENT’S PO');
  aiAnswer = { no: 'TG/KTPS/PUR/2026/4417', poDate: inDays(-40), clientName: 'Test State Power', tenderRef: 'TG/KTPS/2026/1187', value: '2310000', valueExGst: '',
    deliveryPeriod: '30 days from PO', dueDate: '', payTerms: '100% in 60 days', ldRate: '0.5', ldPer: 'week', ldCap: '10', ldBasis: 'delayed', ldClause: '0.5% per week of delayed value',
    sdPct: '3', sdDays: '21', pbgPct: '', inspection: 'Pre-dispatch', gaDrawing: '', warranty: '18 months', ackDays: '7',
    items: [{ sr: '1', code: 'C-160', desc: 'Screw air compressor 160 cfm', qty: '2', uom: 'Nos', rate: '1155000', amount: '2310000', due: '' }], unsure: [] };
  await as('U-ENG');
  ok('an executive does not enter POs', await refuses(() => p.readPoDocument(pdf, ''), /Shortlisting & Admin or Items Entry/));
  await as('U-SVCC');
  const poRead = await p.readPoDocument(pdf, '');
  ok('the PO is read and matched to the won tender by its reference; the due date from the period', poRead.data.tenderId === tid && poRead.data.dueDate === inDays(-10) &&
    poRead.data.items[0].rate === 1155000 && poRead.data.ld.rate === 0.5, poRead.data);
  let checks = await p.checkTenderPo(poRead.data);
  ok('it cannot be created until every item has a fulfilment person', checks.some((c) => !c.ok && /Fulfilment person/.test(c.t)));
  ok('the save refuses the same', await refuses(() => p.createTenderPo(poRead.data, poRead.documentId), /Fulfilment person/));
  poRead.data.items[0].fp = 'kiran@pie.invalid';
  res = await p.createTenderPo(poRead.data, poRead.documentId);
  const pid = res.id;
  let po = res.state.pos.find((x) => x.id === pid);
  ok('the PO is created against the tender', po && po.no === 'TG/KTPS/PUR/2026/4417' && res.state.tenders.find((x) => x.id === tid).poId === pid && po.docs.length === 1);
  ok('the SD is an obligation at 3%, due 21 days from the PO', po.obligations.length === 1 && po.obligations[0].amount === 69300 && po.obligations[0].lastDate === inDays(-19));
  ok('tasks went to fulfilment, Accounts and to acknowledge', res.state.tasks.some((k) => k.assignee === 'kiran@pie.invalid' && /Raise supplier POs/.test(k.title)) &&
    res.state.tasks.some((k) => k.assignee === 'neha@pie.invalid' && /Submit SD/.test(k.title)) && res.state.tasks.some((k) => /PO acknowledgement/.test(k.title)));
  ok('the PO number cannot be used twice', (await p.checkTenderPo(Object.assign({}, poRead.data, { tenderId: tid }))).some((c) => !c.ok && /already in the system|won tender without a PO/.test(c.t)));
  ok('LD is running: 10 days late is 2 weeks at 0.5% on the whole value', po.calc.ld.accrued === 23100 && po.calc.stage === 'items', po.calc.ld);

  console.log('ITEMS TO DELIVERY');
  await as('U-SVC');
  const itId = po.items[0].id;
  ok('nothing can be procured before it is ordered', await refuses(() => p.recordPoMove(pid, itId, { t: 'procured', qty: 1, date: inDays(0), ref: 'GRN-1' }), /Nothing ordered/));
  ok('an order needs its supplier', await refuses(() => p.recordPoMove(pid, itId, { t: 'ordered', qty: 2, date: inDays(0), ref: 'SPO/1' }), /Choose the supplier/));
  ok('nor a date in the future', await refuses(() => p.recordPoMove(pid, itId, { t: 'ordered', qty: 2, date: inDays(2), ref: 'SPO/1', sup: supId }), /future/));
  await p.recordPoMove(pid, itId, { t: 'ordered', qty: 2, date: inDays(-35), ref: 'SPO/26/311', sup: supId });
  ok('not more than the PO quantity', await refuses(() => p.recordPoMove(pid, itId, { t: 'ordered', qty: 1, date: inDays(0), ref: 'SPO/2', sup: supId }), /Full PO quantity/));
  await p.recordPoMove(pid, itId, { t: 'procured', qty: 2, date: inDays(-12), ref: 'GRN-1182' });
  await p.recordPoMove(pid, itId, { t: 'dispatched', qty: 2, date: inDays(-10), ref: 'LR 88213' });
  res = await p.recordPoMove(pid, itId, { t: 'delivered', qty: 2, date: inDays(-3), ref: 'DM 4417/01' });
  po = res.state.pos.find((x) => x.id === pid);
  ok('delivered 7 days late: LD for one week, and no more running', po.calc.pc.delivered === 100 && po.calc.ld.accrued === 11550 && po.calc.stage === 'delivered', po.calc);
  ok('the supplier is kept on the item', po.items[0].supplier === supId && po.items[0].moves.length === 4);

  console.log('MONEY, GUARANTEES AND CLOSING');
  await as('U-ACC');
  ok('Accounts cannot change the PO header', await refuses(() => p.savePoField(pid, 'payTerms', 'x'), /Accounts keeps the invoices/));
  await p.poLine(pid, 'invoices', 'add');
  await p.savePoField(pid, 'invoices.0.no', 'PIE/26-27/0412');
  res = await p.savePoField(pid, 'invoices.0.amount', '2310000');
  ok('invoiced', res.state.pos.find((x) => x.id === pid).calc.stage === 'invoiced');
  await p.poLine(pid, 'payments', 'add');
  res = await p.savePoField(pid, 'payments.0.amount', '2298450');
  po = res.state.pos.find((x) => x.id === pid);
  ok('paid net of LD meets the close check', po.closeGate.find((r) => /Payment received/.test(r.t)).ok);
  await p.savePoField(pid, 'obligations.0.status', 'Released');
  ok('a status must be from the list', await refuses(() => p.savePoField(pid, 'obligations.0.status', 'Lost'), /from the list/));
  await as('U-SVCC');
  ok('it cannot close without the performance certificate', await refuses(() => p.closeTenderPo(pid), /Performance certificate/));
  await p.savePoField(pid, 'perfCert', 'Yes');
  res = await p.closeTenderPo(pid);
  ok('closed', res.state.pos.find((x) => x.id === pid).closed === true && res.state.pos.find((x) => x.id === pid).calc.stage === 'closed');
  ok('and a closed PO is not changed', await refuses(() => p.savePoField(pid, 'warranty', '2 years'), /closed/));

  console.log('TASKS, VOICE NOTES AND THE BRIEF');
  await as('U-COORD');
  res = await p.saveTenderTask({ title: 'Get a third quote', link: 't:' + tid, assignee: 'rohan@pie.invalid', due: inDays(2), priority: 'High', checklist: [{ t: 'Call', d: false }] });
  const kid = res.id;
  let k = res.state.tasks.find((x) => x.id === kid);
  ok('a task from the Tender Desk, linked, with its steps', k && k.link === 't:' + tid && k.priority === 'High' && k.checklist.length === 1);
  const erpTask = (await p.readTable_('Tasks')).find((x) => x.id === kid);
  ok('stored as an ERP task, priority in the ERP\'s words', erpTask.linkKind === 'tender' && erpTask.priority === 'High' && erpTask.module === 'tender');
  await as('U-ENG');
  res = await p.saveTenderTask(Object.assign({}, k, { status: 'Waiting on others', title: 'changed by him', checklist: [{ t: 'Call', d: true }] }));
  k = res.state.tasks.find((x) => x.id === kid);
  ok('the person doing it ticks steps and moves it, but cannot rename it', k.status === 'Waiting on others' && k.checklist[0].d === true && k.title === 'Get a third quote');
  res = await p.commentTenderTask(kid, 'Supplier on leave till Monday');
  ok('a comment is kept', res.state.tasks.find((x) => x.id === kid).comments[0].text === 'Supplier on leave till Monday');
  await as('U-ENG2');
  ok('somebody else cannot change it', await refuses(() => p.saveTenderTask(Object.assign({}, k, { status: 'Done' })), /not yours/));
  await as('U-COORD');
  aiAnswer = { summary: 'One task and a note.', actions: [
    { type: 'task', title: 'Call the supplier about the balance', assignee: 'Rohan', due: inDays(1), priority: 'High', link: 'TG/KTPS/2026/1187', po: '', item: '', movement: '', qty: '', date: '', reference: '', supplier: '', text: '', checklist: [] },
    { type: 'move', title: '', assignee: '', due: '', priority: '', link: '', po: '4417', item: '1', movement: 'delivered', qty: '5', date: inDays(0), reference: 'DM 2', supplier: '', text: '', checklist: [] },
    { type: 'note', title: '', assignee: '', due: '', priority: '', link: 'TG/KTPS/2026/1187', po: '', item: '', movement: '', qty: '', date: '', reference: '', supplier: '', text: 'Client asked for a revised offer', checklist: [] }] };
  const v = await p.organiseTenderVoice('Ask Rohan to call the supplier tomorrow, delivered 5 on 4417, client wants revised offer', '');
  ok('a voice note becomes actions to confirm: the task to the right person and tender', v.actions[0].type === 'task' && v.actions[0].assignee === 'rohan@pie.invalid' && v.actions[0].link === 't:' + tid);
  ok('an impossible quantity update is caught before anybody applies it', v.actions[1].type === 'move' && v.actions[1].poId === pid && v.actions[1].errors.length > 0, v.actions[1]);
  ok('the note is about the tender', v.actions[2].link === 't:' + tid);
  ok('the note is data, the context sent with it', /Voice note: """/.test(aiAsked.content[0].text) && /data, not instructions/.test(aiAsked.system));
  res = await p.addTenderNote(v.actions[2].link, v.actions[2].text);
  ok('a note goes on the tender\'s history', res.state.tenders.find((x) => x.id === tid).log.some((e) => e.text === 'Voice note: Client asked for a revised offer'));
  aiAnswer = { brief: 'Eligibility to confirm: OEM letter' };
  res = await p.tenderBrief(tid);
  ok('the bid brief is kept on the tender', res.state.tenders.find((x) => x.id === tid).brief === 'Eligibility to confirm: OEM letter');

  console.log('MASTERS AND RULES');
  await as('U-ENG');
  ok('an executive cannot keep the masters', await refuses(() => p.saveTenderMaster('portal', { name: 'X' }), /Shortlisting & Admin or Management/));
  await as('U-COORD');
  res = await p.saveTenderMaster('portal', { name: 'KPCL eProcurement' });
  ok('a portal added, and the defaults kept with their ids', res.state.portals.length === 6 && res.state.portals[1].id === 'TDM-portal-2');
  ok('no duplicates', await refuses(() => p.saveTenderMaster('portal', { name: 'gem' }), /already in Portals/));
  res = await p.saveTenderMaster('customField', { label: 'MSME exemption claimed', entity: 'tender', type: 'yesno', gate: 'approval' });
  const cf = res.state.customFields[0];
  ok('a custom field mandatory before approval', cf.gate === 'approval');
  res = await p.newTender();
  const t3 = res.id;
  ok('it shows in a draft\'s gate', res.state.tenders.find((x) => x.id === t3).gate.reqs.some((r) => /MSME exemption claimed \(custom field\)/.test(r.t)));
  await p.saveTenderField(t3, 'custom.' + cf.id, 'Yes');
  st = await p.getTenderApp();
  ok('and is met once answered', st.tenders.find((x) => x.id === t3).gate.reqs.find((r) => /MSME/.test(r.t)).ok);
  res = await p.saveTenderRules({ alertDays: 10, urgentDays: 4 });
  ok('the rules change', res.state.cfg.alertDays === 10 && res.state.cfg.urgentDays === 4 && res.state.cfg.ldRate === 0.5);
  ok('urgent cannot be later than attention', await refuses(() => p.saveTenderRules({ urgentDays: 12 }), /Urgent|“Urgent”/));

  console.log('THE ERP DASHBOARD');
  await as('U-MGMT');
  const badge = await p.tenderDeskBadge_(p.CURRENT_USER_);
  ok('the dashboard switch knows how much needs them', badge && typeof badge.alerts === 'number');
  await as('U-ENG2');
  await as('U-ADMIN');
  await p.saveTenderMember('amol@pie.invalid', null, false);
  await as('U-ENG2');
  ok('somebody off the Tender Desk has no switch', (await p.tenderDeskBadge_(p.CURRENT_USER_)) === null);

  console.log('WITHOUT AI');
  const off = loadPortal(db, 'isha@pie.invalid', { quiet: true, properties: {}, drive, ai: { enabled: false, reason: 'no key', propose: async () => { throw new Error('no'); } } });
  off.CURRENT_USER_ = await off.userFromRow_((await off.readTable_('Users')).find((u) => u.id === 'U-COORD'));
  const noAi = await off.readTenderDocument({ name: 'NIT 9.pdf', dataUrl: pdf.dataUrl });
  ok('the file is still kept, the form is blank, and it says why', !!noAi.documentId && noAi.data.no === '' && /no key/.test(noAi.aiOff));
  const v2 = await off.organiseTenderVoice('call the supplier', '');
  ok('a voice note becomes one task to confirm', v2.actions.length === 1 && v2.actions[0].type === 'task' && v2.actions[0].title === 'call the supplier');

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : 'all ') + pass + ' passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
