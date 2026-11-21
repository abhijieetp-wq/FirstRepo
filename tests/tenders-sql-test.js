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
  await person('U-POX', 'sanjay', 'Sanjay More', 'Service Coordinator', { tenderDesk: 'TRUE', tenderRole: 'po' });
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
  ok('the ERP admin starts as Shortlisting, and is a Tender Desk admin always', st.me.role === 'shortlist' && st.roles.shortlist === 'Shortlisting' && st.me.admin === true &&
    st.me.team === true && st.me.masters === true && st.members.find((m) => m.id === 'office@pie.invalid').adminAlways === true, st.me);
  ok('Management, Accounts and the ticked users are members, each as their ERP role starts them',
    roleOf(st, 'vikram@pie.invalid') === 'mgmt' && roleOf(st, 'neha@pie.invalid') === 'accounts' && roleOf(st, 'isha@pie.invalid') === 'shortlist' &&
    roleOf(st, 'rohan@pie.invalid') === 'exec' && roleOf(st, 'kiran@pie.invalid') === 'fp' && roleOf(st, 'meera@pie.invalid') === 'items', st.members);
  ok('the unticked engineer is not on it, and is offered to add', !roleOf(st, 'amol@pie.invalid') && st.others.some((o) => o.id === 'amol@pie.invalid'));
  await as('U-ENG2');
  ok('nor can he open it', await refuses(() => p.getTenderApp(), /not open to your account/));
  console.log('ADMIN IS A GRANT OF ITS OWN');
  await as('U-MGMT');
  st = await p.getTenderApp();
  ok('Management is not an admin by being Management', st.me.admin === false && st.me.team === false && st.me.approver === true);
  ok('so cannot change the team', await refuses(() => p.saveTenderMember('amol@pie.invalid', 'exec', true), /Tender Desk admins/));
  await as('U-COORD');
  st = await p.getTenderApp();
  ok('nor is Shortlisting an admin', st.me.role === 'shortlist' && st.me.admin === false && st.me.masters === false && st.me.addClients === true);
  ok('a coordinator cannot change the team', await refuses(() => p.saveTenderMember('amol@pie.invalid', 'fp', null), /Tender Desk admins/));
  ok('nor keep the masters', await refuses(() => p.saveTenderMaster('portal', { name: 'Some portal' }), /Tender Desk admins/));
  ok('nor make herself an admin', await refuses(() => p.saveTenderMember('isha@pie.invalid', null, null, true), /Tender Desk admins/));
  await as('U-ADMIN');
  st = (await p.saveTenderMember('amol@pie.invalid', 'exec', true)).state;
  ok('an admin adds him, as a Tender Executive', roleOf(st, 'amol@pie.invalid') === 'exec');
  ok('Accounts cannot be taken off', await refuses(() => p.saveTenderMember('neha@pie.invalid', null, false), /always has the Tender Desk/));
  ok('the ERP Admin cannot be unmade', await refuses(() => p.saveTenderMember('office@pie.invalid', null, null, false), /always a Tender Desk admin/));
  ok('nobody is made admin before they are on the Tender Desk', await refuses(() => p.saveTenderMember('kiran2@pie.invalid', null, null, true), /nobody active/));
  st = (await p.saveTenderMember('isha@pie.invalid', null, null, true)).state;
  ok('an admin makes the coordinator an admin too', st.members.find((m) => m.id === 'isha@pie.invalid').admin === true);
  await as('U-COORD');
  st = await p.getTenderApp();
  ok('and now she keeps the team and the masters', st.me.admin === true && st.me.team === true && st.me.masters === true && st.me.accounts === true);
  ok('but cannot take away her own', await refuses(() => p.saveTenderMember('isha@pie.invalid', null, null, false), /your own admin/));
  await as('U-ADMIN');
  await p.saveTenderMember('vikram@pie.invalid', null, null, true);
  await p.saveTenderMember('vikram@pie.invalid', null, null, false);
  ok('and an admin can be taken away by a fellow admin', (await p.getTenderApp()).members.find((m) => m.id === 'vikram@pie.invalid').admin === false);
  await as('U-COORD');
  ok('the defaults are there before anybody keeps a master', st.portals.length === 5 && st.checklist.length === 10 && st.uoms.some((u) => u.name === 'Nos') && st.cfg.alertDays === 7);

  console.log('A TENDER DESK ONLY ACCOUNT');
  await as('U-COORD');
  ok('somebody who is not an admin cannot open accounts', await (async () => { await as('U-ENG'); const r = await refuses(() => p.createTenderMember({ name: 'X Y', password: 'cedar-teak-42' }), /Tender Desk admins/); await as('U-COORD'); return r; })());
  await as('U-ADMIN');
  ok('the ERP Admin may open them', (await p.getTenderApp()).me.accounts === true);
  ok('a weak first password is refused', await refuses(() => p.createTenderMember({ name: 'Pooja Wankhede', password: 'abc' }), /at least/));
  let res = await p.createTenderMember({ name: 'Pooja Wankhede', username: 'pooja', designation: 'Tender Executive', role: 'exec', password: 'cedar-teak-42' });
  const pooja = res.state.members.find((m) => m.username === 'pooja');
  ok('a new member, made here: on the team, as its role, marked Tender Desk only', pooja && pooja.role === 'exec' && pooja.tenderOnly === true && /sign in as “pooja”/.test(res.message), pooja);
  const prow = (await p.readTable_('Users')).find((u) => u.username === 'pooja');
  ok('an account of the ERP\'s own kind, which must choose its own password first', prow.role === 'Tender Desk only' && String(prow.mustChangePassword).toUpperCase() === 'TRUE' && /@pie\.invalid$/.test(prow.email));
  ok('the username must be free', await refuses(() => p.createTenderMember({ name: 'Another Pooja', username: 'pooja', password: 'cedar-teak-42' }), /taken|already|use/i));
  const signedIn = await p.login('pooja', 'cedar-teak-42', '');
  ok('she signs in with it', !!(signedIn && signedIn.token) && signedIn.user.role === 'Tender Desk only');
  const asPooja = await p.call(signedIn.token, 'getTenderApp', []);
  ok('and opens the Tender Desk', asPooja && asPooja.me.tenderOnly === true && asPooja.me.role === 'exec');
  ok('but nothing in the ERP', await refuses(() => p.call(signedIn.token, 'listCustomers', []), /Tender Desk only/) &&
    await refuses(() => p.call(signedIn.token, 'getPersonDashboard', [{}]), /Tender Desk only/));
  await as('U-ADMIN');
  res = await p.setTenderMemberPassword(pooja.id, 'walnut-zephyr-17');
  ok('a new password is set from the team list, to be changed again', /walnut|sign in as “pooja”/.test(res.message));
  ok('the old one stops working', await refuses(() => p.login('pooja', 'cedar-teak-42', ''), /./));
  ok('the password of an ERP account is not set here', await refuses(() => p.setTenderMemberPassword('isha@pie.invalid', 'walnut-zephyr-17'), /set in the ERP/));
  res = await p.saveTenderMember(pooja.id, null, false);
  ok('closing the account', /account is closed/.test(res.message) && !res.state.members.some((m) => m.username === 'pooja'));
  ok('and she can no longer sign in', await refuses(() => p.login('pooja', 'walnut-zephyr-17', ''), /./));

  console.log('THE TENDER DESK\'S OWN CLIENTS');
  ok('no clients to start with: the ERP\'s Customers are not its clients', st.clients.length === 0, st.clients);
  await as('U-ENG');
  ok('an executive cannot add clients', await refuses(() => p.saveTenderMaster('client', { name: 'X' }), /Tender Desk admins/));
  await as('U-COORD');
  st = (await p.saveTenderMaster('client', { name: 'Test State Power Generation Co Ltd', short: 'TSPGCL', city: 'Nagpur', state: 'Maharashtra', gstin: '27aaacT1234a1z5' })).state;
  const gen = st.clients.find((c) => c.name === 'Test State Power Generation Co Ltd');
  ok('one added by hand, its GSTIN made upper case', gen && gen.short === 'TSPGCL' && gen.gstin === '27AAACT1234A1Z5', gen);
  ok('a GSTIN of the wrong shape is refused', await refuses(() => p.saveTenderMaster('client', { name: 'Bad GST Ltd', gstin: '1234' }), /15 letters and digits/));
  ok('and the same client twice', await refuses(() => p.saveTenderMaster('client', { name: 'test state power generation co ltd' }), /already in Clients/));
  res = await p.importTenderClients([
    { Name: 'Sample Transmission Utility', 'Short name': 'STU', City: 'Mumbai', State: 'Maharashtra', GSTIN: '', 'Contact person': 'Store officer', Phone: '0712 000000', 'E-mail': 'stores@stu.invalid' },
    { Name: 'Test State Power Generation Co Ltd', City: 'Koradi', GSTIN: '' },
    { Name: 'Demo Thermal Power Station', 'Short name': '', City: 'Mouda' },
    { Name: '', City: 'Nowhere' },
    { Name: 'Broken GST Co', GSTIN: '99' },
    { Name: 'Sample Transmission Utility', City: 'again' }]);
  ok('a CSV upload: new ones added, an existing one updated, the bad lines reported by line', res.imported.added === 2 && res.imported.updated === 1 && res.imported.skipped.length === 3 &&
    res.imported.skipped.map((x) => x.line).join() === '5,6,7', res.imported);
  ok('the update keeps what the file did not give', res.state.clients.find((c) => c.id === gen.id).city === 'Koradi' && res.state.clients.find((c) => c.id === gen.id).short === 'TSPGCL');
  ok('and the uploaded client has its details, a short name made when none was given', res.state.clients.find((c) => c.name === 'Sample Transmission Utility').email === 'stores@stu.invalid' &&
    res.state.clients.find((c) => c.name === 'Demo Thermal Power Station').short === 'Demo');
  ok('headings are matched however they are written', (await p.importTenderClients([{ 'client name': 'Heading Test Mills', 'GST No': '' }])).imported.added === 1);
  ok('an empty file is refused', await refuses(() => p.importTenderClients([]), /no clients/));

  console.log('A TENDER FROM ITS DOCUMENT');
  aiAnswer = { no: 'TG/KTPS/2026/1187', title: 'Supply of screw air compressors for ash handling', clientName: 'Test State Power Generation', plant: 'Unit 8',
    portalName: 'Mahatenders portal', category: 'Goods Supply', publishedDate: inDays(-2), lastDate: inDays(10), dueTime: '15:00', estCost: 'Rs. 24,50,000/-',
    tenderFee: '5900', emd: '49,000', emdType: 'Online', bgOk: 'yes', subType: 'Online', payTerms: '100% within 60 days', sdReq: '', sdPct: '3', pbgReq: 'No', pbgPct: '',
    deliveryPeriod: '90 days', ldClause: '0.5% per week, max 10%', eligibility: ['OEM or authorised dealer', ''], items: [{ desc: 'Screw air compressor 160 cfm', qty: '2', uom: 'nos', spec: 'IS 5456' }, { desc: '', qty: '', uom: '', spec: '' }],
    unsure: ['emd'] };
  await as('U-ENG');
  ok('an executive cannot enter a tender', await refuses(() => p.readTenderDocument(pdf), /Shortlisting/));
  await as('U-COORD');
  const read = await p.readTenderDocument(pdf);
  ok('the PDF goes to Claude as a document, before the instruction', aiAsked && aiAsked.content[0].type === 'document' && aiAsked.content[0].source.media_type === 'application/pdf' && aiAsked.content[1].type === 'text');
  ok('what it read comes back as the form: money as numbers, lists matched, Yes/No made', read.data.no === 'TG/KTPS/2026/1187' && read.data.estCost === 2450000 && read.data.emd === 49000 &&
    read.data.portal === 'TDM-portal-2' && read.data.category === 'TDM-category-1' && read.data.bgOk === 'Yes' && read.data.sdReq === 'Yes' && read.data.pbgReq === 'No' &&
    read.data.items.length === 1 && read.data.items[0].uom === 'Nos' && read.data.items[0].qty === 2 && read.data.eligText === 'OEM or authorised dealer', read.data);
  ok('the client is matched in the client list, and what it was unsure of is marked', read.data.client === gen.id && read.matches[0].id === gen.id && read.conf.emd === 0.5, read);
  res = await p.saveTenderFromDocument(Object.assign({}, read.data, { dueTime: '' }), read.documentId, true);
  const tid = res.id;
  let t = res.state.tenders.find((x) => x.id === tid);
  ok('saved and sent: still a draft, because the due time is missing', t.stage === 'draft' && /fill the fields marked in red/.test(res.message) &&
    t.gate.reqs.some((r) => !r.ok && /Due time/.test(r.t)), res.message);
  ok('the document is filed against it', t.docs.length === 1 && t.aiRead === 'TRUE');
  res = await p.saveTenderField(tid, 'dueTime', '15:00');
  ok('a bad time is refused', await refuses(() => p.saveTenderField(tid, 'dueTime', '3pm'), /hours and minutes/));
  ok('a field that does not exist is refused', await refuses(() => p.saveTenderField(tid, 'stage', 'won'), /cannot be changed here/));
  ok('the client must be in the client list — an ERP customer is not', await refuses(() => p.saveTenderField(tid, 'client', 'CU-OTHER'), /not in the client list/));
  ok('a client on a tender cannot be deleted', await refuses(() => p.deleteTenderMaster('client', gen.id), /stays/));

  console.log('SHORTLISTING, THEN MANAGEMENT');
  await as('U-ENG');
  ok('an executive cannot touch a tender still being shortlisted', await refuses(() => p.saveTenderField(tid, 'title', 'x'), /look at this tender but not change/));
  await as('U-COORD');
  res = await p.advanceTender(tid);
  t = res.state.tenders.find((x) => x.id === tid);
  ok('sent for approval', t.stage === 'approval' && t.approval.status === 'pending', t.stage);
  ok('the steps are the way PIE works', res.state.stages.map((x) => x.l).join(' → ') === 'Shortlisting → Awaiting approval → Submission prep → Bid approval → Submit on portal → Submitted → Bid opened → Result');
  ok('Management gets a task to approve, on the main Tasks list', res.state.tasks.some((k) => k.link === 't:' + tid && /^Approve participation/.test(k.title) && k.assignee === 'vikram@pie.invalid'));
  const erpTasks = await p.readTable_('Tasks');
  ok('the task is an ERP task linked to the tender', erpTasks.some((k) => k.linkKind === 'tender' && k.linkId === tid && k.module === 'tender' && k.source === 'auto'));
  ok('only Management approves', await refuses(() => p.approveTender(tid, ''), /Management/));
  await as('U-MGMT');
  ok('Management sees it waiting, in its alerts', (await p.getTenderApp()).alerts.some((a) => a.t === 'Approval needed: TG/KTPS/2026/1187'));
  ok('the owner, if named, must be on the submission team', await refuses(() => p.approveTender(tid, '', 'kiran@pie.invalid'), /submission team/));
  res = await p.approveTender(tid, 'Repeat client – quote sharp', 'rohan@pie.invalid');
  t = res.state.tenders.find((x) => x.id === tid);
  ok('approved: straight to the submission team, no assigning step between', t.stage === 'prep' && t.approval.by === 'vikram@pie.invalid' && t.assignee === 'rohan@pie.invalid' &&
    res.state.tasks.find((k) => /^Approve participation/.test(k.title)).status === 'Done', t.stage);
  ok('its owner gets the task with the checklist', res.state.tasks.some((k) => k.assignee === 'rohan@pie.invalid' && /^Prepare & submit bid/.test(k.title) && k.checklist.length === 10));

  console.log('SUBMISSION PREP, BID APPROVAL, SUBMISSION');
  await as('U-ENG2');
  ok('another executive cannot work a tender that has an owner', await refuses(() => p.saveTenderField(tid, 'prep.min3', 'Yes'), /not change it/));
  await as('U-ENG');
  for (const [k, v] of [['enquiryDate', inDays(-1)], ['offersPerSpec', 'Yes'], ['tcAccepted', 'Yes'], ['min3', 'Yes'], ['compChart', 'Yes'], ['docsRecv', 'NA'], ['nego', 'Yes']]) {
    await p.saveTenderField(tid, 'prep.' + k, v);
  }
  await as('U-ADMIN');
  st = (await p.saveTenderMaster('supplier', { name: 'Invented Motors Pvt Ltd', city: 'Nagpur', rating: 'A' })).state;
  const supId = st.suppliers.find((s) => s.name === 'Invented Motors Pvt Ltd').id;
  await as('U-ENG');
  await p.saveTenderField(tid, 'prep.finalVendor', supId);
  await p.saveTenderField(tid, 'submission.value', '2310000');
  st = await p.getTenderApp();
  ok('preparation waits on Accounts for the EMD balance', st.tenders.find((x) => x.id === tid).gate.reqs.filter((r) => !r.ok).map((r) => r.t).join() === 'Tender account EMD balance sufficient');
  await as('U-ACC');
  ok('Accounts cannot change the tender itself', await refuses(() => p.saveTenderField(tid, 'title', 'x'), /not change it/));
  await p.saveTenderField(tid, 'prep.emdBal', 'Yes');
  await as('U-ENG');
  res = await p.advanceTender(tid);
  t = res.state.tenders.find((x) => x.id === tid);
  ok('the bid goes to Management for approval', t.stage === 'bidcheck' && t.bid.status === 'pending' && t.bid.value === 2310000 &&
    res.state.tasks.some((k) => /^Approve bid: TG\/KTPS\/2026\/1187/.test(k.title) && k.assignee === 'vikram@pie.invalid'));
  ok('its value is locked while Management looks at it', await refuses(() => p.saveTenderField(tid, 'submission.value', '2000000'), /sends the bid back/));
  ok('the executive cannot approve it', await refuses(() => p.approveBid(tid, ''), /Management/));
  await as('U-MGMT');
  ok('Management sees the bid waiting', (await p.getTenderApp()).alerts.some((a) => /^Bid to approve: TG\/KTPS\/2026\/1187/.test(a.t)));
  ok('sending back needs a reason', await refuses(() => p.returnBid(tid, ''), /what should change/));
  res = await p.returnBid(tid, 'Take 2% off');
  t = res.state.tenders.find((x) => x.id === tid);
  ok('sent back: the team prepares again, told why', t.stage === 'prep' && t.bid.status === 'returned' && res.state.tasks.some((k) => /^Rework bid/.test(k.title) && k.assignee === 'rohan@pie.invalid'));
  await as('U-ENG');
  await p.saveTenderField(tid, 'submission.value', '2263800');
  await p.advanceTender(tid);
  await as('U-MGMT');
  res = await p.approveBid(tid, 'Go');
  t = res.state.tenders.find((x) => x.id === tid);
  ok('approved: it is to be submitted on the portal', t.stage === 'ready' && t.bid.status === 'approved' && t.bid.value === 2263800);
  await as('U-ENG');
  const cps = res.state.checklist;
  for (const c of cps) await p.saveTenderField(tid, 'checklist.' + c.id, 'Yes');
  res = await p.saveTenderField(tid, 'checklist.' + cps[2].id, 'No');
  ok('a checkpoint going back is on the record', res.state.tenders.find((x) => x.id === tid).log.some((e) => /Checklist went back: EMD arranged/.test(e.text)));
  await p.saveTenderField(tid, 'checklist.' + cps[2].id, 'NA');
  for (const [k, v] of [['date', inDays(0)], ['ack', 'MT-2026-1187-55410'], ['quote', 'Quote']]) await p.saveTenderField(tid, 'submission.' + k, v);
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

  console.log('THE WHOLE TEAM, AND SHORTLISTING & EXECUTIVE IN ONE PERSON');
  await as('U-ADMIN');
  await p.saveTenderMember('isha@pie.invalid', 'both', null);
  await as('U-COORD');
  res = await p.newTender();
  const tb = res.id;
  ok('the role is offered and named', res.state.roles.both === 'Shortlisting & Executive' && res.state.me.role === 'both');
  const cl = res.state.clients[0].id;
  for (const [k, v] of [['no', 'BOTH/2026/1'], ['title', 'Air dryers'], ['client', cl], ['portal', 'TDM-portal-1'], ['lastDate', inDays(6)], ['dueTime', '11:00'], ['estCost', 500000], ['emd', 10000], ['emdType', 'Online']]) {
    await p.saveTenderField(tb, k, v);
  }
  await p.tenderItemLine(tb, 'add');
  await p.saveTenderField(tb, 'items.0.desc', 'Refrigerated air dryer');
  await p.attachTenderFile('tender', tb, pdf);
  res = await p.advanceTender(tb);
  ok('she enters a tender and sends it, as Shortlisting', res.state.tenders.find((x) => x.id === tb).stage === 'approval');
  await as('U-MGMT'); res = await p.approveTender(tb, '');
  ok('approved with no owner: with the whole submission team', res.state.tenders.find((x) => x.id === tb).stage === 'prep' && !res.state.tenders.find((x) => x.id === tb).assignee);
  await as('U-ENG');
  ok('every executive is told about it', (await p.getTenderApp()).alerts.some((a) => /BOTH\/2026\/1/.test(a.t)));
  await p.saveTenderField(tb, 'prep.min3', 'Yes');
  ok('any executive can work it while nobody owns it', (await p.getTenderApp()).tenders.find((x) => x.id === tb).prep.min3 === 'Yes');
  ok('and can take it only for himself', await refuses(() => p.saveTenderField(tb, 'assignee', 'amol@pie.invalid'), /named by Shortlisting/));
  await as('U-COORD');
  res = await p.saveTenderField(tb, 'assignee', 'isha@pie.invalid');
  ok('she names herself the owner, and gets the task', res.state.tenders.find((x) => x.id === tb).assignee === 'isha@pie.invalid' &&
    res.state.tasks.some((k) => k.assignee === 'isha@pie.invalid' && /^Prepare & submit bid – BOTH/.test(k.title)));
  await as('U-ENG');
  ok('now another executive cannot', await refuses(() => p.saveTenderField(tb, 'prep.min3', 'No'), /not change it/));
  await as('U-COORD');
  for (const [k, v] of [['enquiryDate', inDays(-1)], ['offersPerSpec', 'Yes'], ['tcAccepted', 'Yes'], ['min3', 'Yes'], ['compChart', 'Yes'], ['docsRecv', 'NA'], ['nego', 'NA'], ['finalVendor', supId], ['emdBal', 'Yes']]) {
    await p.saveTenderField(tb, 'prep.' + k, v);
  }
  await p.saveTenderField(tb, 'submission.value', 480000);
  await p.advanceTender(tb);
  await as('U-MGMT'); await p.approveBid(tb, '');
  await as('U-COORD');
  for (const c of cps) await p.saveTenderField(tb, 'checklist.' + c.id, 'Yes');
  for (const [k, v] of [['date', inDays(0)], ['ack', 'ACK-BOTH-1'], ['quote', 'Quote']]) await p.saveTenderField(tb, 'submission.' + k, v);
  res = await p.advanceTender(tb);
  ok('and works it through to submission herself', res.state.tenders.find((x) => x.id === tb).stage === 'submitted');
  ok('and she still keeps the masters', !!(await p.saveTenderMaster('lossReason', { name: 'Specification not met' })));
  res = await p.createTenderPo({ tenderId: tb, no: 'PO-BOTH-1', poDate: inDays(0), dueDate: inDays(30), value: 480000, inspection: 'No', gaDrawing: 'No', ld: { rate: 0.5, per: 'week', cap: 10, basis: 'delayed' },
    items: [{ sr: 1, desc: 'Refrigerated air dryer', qty: 1, uom: 'Nos', rate: 480000, due: inDays(30), fp: 'kiran@pie.invalid' }] }, '');
  t = res.state.tenders.find((x) => x.id === tb);
  ok('the client\'s PO on a submitted tender: it is won, at the PO\'s value, and goes to execution', t.stage === 'result' && t.result === 'won' && t.postbid.l1 === 480000 && t.poId === res.id);

  console.log('APPROVERS, AND AN APPROVER\'S OWN TENDER');
  await as('U-COORD');
  ok('a coordinator is not an approver', (await p.getTenderApp()).me.approver === false);
  res = await p.newTender();
  const tq = res.id;
  for (const [k, v] of [['no', 'ADMIN/2026/7'], ['title', 'Air receivers'], ['client', cl], ['portal', 'TDM-portal-1'], ['lastDate', inDays(6)], ['dueTime', '11:00'], ['estCost', 300000], ['emd', 6000], ['emdType', 'Online']]) {
    await p.saveTenderField(tq, k, v);
  }
  await p.tenderItemLine(tq, 'add');
  await p.saveTenderField(tq, 'items.0.desc', 'Air receiver 2 m3');
  await p.attachTenderFile('tender', tq, pdf);
  ok('her button sends it for approval', (await p.getTenderApp()).tenders.find((x) => x.id === tq).gate.action === 'Send for management approval');
  await p.advanceTender(tq);
  await as('U-ADMIN');
  st = await p.getTenderApp();
  ok('the ERP Admin approves, as in the rest of the ERP', st.me.approver === true && st.tenders.find((x) => x.id === tq).gate.canAct === true);
  res = await p.approveTender(tq, 'Fine');
  ok('and it goes to the submission team', res.state.tenders.find((x) => x.id === tq).stage === 'prep' && res.state.tenders.find((x) => x.id === tq).approval.by === 'office@pie.invalid');
  res = await p.newTender();
  const tz = res.id;
  for (const [k, v] of [['no', 'ADMIN/2026/8'], ['title', 'Air receivers, second lot'], ['client', cl], ['portal', 'TDM-portal-1'], ['lastDate', inDays(6)], ['dueTime', '11:00'], ['estCost', 300000], ['emd', 6000], ['emdType', 'Online']]) {
    await p.saveTenderField(tz, k, v);
  }
  await p.tenderItemLine(tz, 'add');
  await p.saveTenderField(tz, 'items.0.desc', 'Air receiver 1 m3');
  await p.attachTenderFile('tender', tz, pdf);
  ok('an approver\'s own button says it approves', (await p.getTenderApp()).tenders.find((x) => x.id === tz).gate.action === 'Approve & send to the submission team');
  res = await p.advanceTender(tz);
  t = res.state.tenders.find((x) => x.id === tz);
  ok('self-approved as it is sent: straight to the submission team, no task for Management', t.stage === 'prep' && t.approval.self === true && t.approval.by === 'office@pie.invalid' &&
    !res.state.tasks.some((k) => k.link === 't:' + tz && /^Approve participation/.test(k.title)) && /Approved by you/.test(res.message), t.approval);
  for (const [k, v] of [['enquiryDate', inDays(-1)], ['offersPerSpec', 'Yes'], ['tcAccepted', 'Yes'], ['min3', 'Yes'], ['compChart', 'Yes'], ['docsRecv', 'NA'], ['nego', 'NA'], ['finalVendor', supId], ['emdBal', 'Yes']]) {
    await p.saveTenderField(tz, 'prep.' + k, v);
  }
  await p.saveTenderField(tz, 'submission.value', 290000);
  res = await p.advanceTender(tz);
  t = res.state.tenders.find((x) => x.id === tz);
  ok('and the bid, prepared by an approver, is approved as it is sent: on to the portal', t.stage === 'ready' && t.bid.status === 'approved' && t.bid.self === true && t.bid.value === 290000);
  ok('it is on the record as self-approved', t.log.some((e) => /approved by them, as an approver/.test(e.text)));

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
    sdPct: '3', sdDays: '21', pbgPct: '', inspection: 'Pre-dispatch', gaDrawing: 'Required for approval', warranty: '18 months', ackDays: '7',
    items: [{ sr: '1', code: 'C-160', desc: 'Screw air compressor 160 cfm', qty: '2', uom: 'Nos', rate: '1155000', amount: '2310000', due: '' }], unsure: [] };
  await as('U-ENG');
  ok('an executive does not enter POs', await refuses(() => p.readPoDocument(pdf, ''), /Shortlisting or PO Execution or Items Entry/));
  await as('U-SVCC');
  const poRead = await p.readPoDocument(pdf, '');
  ok('the PO is read and matched to the won tender by its reference; the due date from the period', poRead.data.tenderId === tid && poRead.data.dueDate === inDays(-10) &&
    poRead.data.items[0].rate === 1155000 && poRead.data.ld.rate === 0.5, poRead.data);
  ok('inspection and GA drawing read as Yes/No questions', poRead.data.inspection === 'Yes' && poRead.data.gaDrawing === 'Yes', [poRead.data.inspection, poRead.data.gaDrawing]);
  let checks = await p.checkTenderPo(poRead.data);
  ok('a GA drawing asked for must be attached', checks.some((c) => !c.ok && c.t === 'GA drawing attached'));
  ok('and the form cannot claim it is', await refuses(() => p.createTenderPo(Object.assign({}, poRead.data, { gaAttached: true, items: [Object.assign({}, poRead.data.items[0], { fp: 'kiran@pie.invalid' })] }), poRead.documentId), /GA drawing attached/));
  ok('Yes or No must be answered', (await p.checkTenderPo(Object.assign({}, poRead.data, { inspection: '' }))).some((c) => !c.ok && c.t === 'Inspection: Yes or No'));
  ok('it cannot be created until every item has a fulfilment person', checks.some((c) => !c.ok && /Fulfilment person/.test(c.t)));
  ok('the save refuses the same', await refuses(() => p.createTenderPo(poRead.data, poRead.documentId), /Fulfilment person/));
  poRead.data.items[0].fp = 'kiran@pie.invalid';
  res = await p.createTenderPo(poRead.data, poRead.documentId, { name: 'GA-drawing.pdf', dataUrl: pdf.dataUrl });
  const pid = res.id;
  let po = res.state.pos.find((x) => x.id === pid);
  ok('the PO is created against the tender', po && po.no === 'TG/KTPS/PUR/2026/4417' && res.state.tenders.find((x) => x.id === tid).poId === pid &&
    po.docs.filter((d) => d.type === 'Purchase order').length === 1 && po.docs.filter((d) => d.type === 'GA drawing').length === 1, po.docs);
  ok('with its answers', po.inspection === 'Yes' && po.gaDrawing === 'Yes');
  ok('which stay Yes or No', await refuses(() => p.savePoField(pid, 'inspection', 'Third party'), /Yes or No/));
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
  for (const who of ['U-COORD', 'U-SVCC', 'U-SVC', 'U-POX']) {
    await as(who);
    ok('invoices, payments and the SD / PBG are Accounts\' alone, not ' + who + '\'s', await refuses(() => p.poLine(pid, 'invoices', 'add'), /kept by Accounts/) &&
      await refuses(() => p.poLine(pid, 'payments', 'add'), /kept by Accounts/) && await refuses(() => p.poLine(pid, 'obligations', 'add'), /SD \/ PBG is kept by Accounts/) &&
      await refuses(() => p.savePoField(pid, 'obligations.0.status', 'Submitted'), /SD \/ PBG is kept by Accounts/));
  }
  await as('U-ACC');
  await p.poLine(pid, 'invoices', 'add');
  await p.savePoField(pid, 'invoices.0.no', 'PIE/26-27/0412');
  res = await p.savePoField(pid, 'invoices.0.amount', '2310000');
  ok('invoiced', res.state.pos.find((x) => x.id === pid).calc.stage === 'invoiced');
  await p.poLine(pid, 'payments', 'add');
  res = await p.savePoField(pid, 'payments.0.amount', '2298450');
  po = res.state.pos.find((x) => x.id === pid);
  ok('paid net of LD meets the close check', po.closeGate.find((r) => /Payment received/.test(r.t)).ok);
  await as('U-POX');
  ok('nor are they changed by anybody else', await refuses(() => p.savePoField(pid, 'payments.0.amount', '1'), /kept by Accounts/) &&
    await refuses(() => p.savePoField(pid, 'invoices.0.no', 'X'), /kept by Accounts/) && await refuses(() => p.poLine(pid, 'invoices', 'del', 0), /kept by Accounts/));
  await as('U-ACC');
  await p.savePoField(pid, 'obligations.0.status', 'Released');
  ok('a status must be from the list', await refuses(() => p.savePoField(pid, 'obligations.0.status', 'Lost'), /from the list/));
  await as('U-SVCC');
  ok('it cannot close without the performance certificate', await refuses(() => p.closeTenderPo(pid), /Performance certificate/));
  console.log('PO EXECUTION');
  await as('U-POX');
  st = await p.getTenderApp();
  ok('PO Execution is a Tender Desk role of its own', st.roles.po === 'PO Execution' && st.me.role === 'po');
  ok('it is told about every PO, with nothing assigned to it', st.alerts.some((a) => a.ref === 'p:' + pid));
  ok('and can be given a PO\'s items to fulfil', (await p.savePoField(pid, 'items.' + itId + '.fp', 'sanjay@pie.invalid')).state.pos.find((x) => x.id === pid).items[0].fp === 'sanjay@pie.invalid');
  await p.savePoField(pid, 'items.' + itId + '.fp', 'kiran@pie.invalid');
  await p.savePoField(pid, 'warranty', '18 months from delivery');
  ok('it keeps the PO\'s terms', (await p.getTenderApp()).pos.find((x) => x.id === pid).warranty === '18 months from delivery');
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
  ok('an executive cannot keep the masters', await refuses(() => p.saveTenderMaster('portal', { name: 'X' }), /Tender Desk admins/));
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

  console.log('TENDERS FROM BEFORE, NAMING AN ERP CUSTOMER');
  await db.appendRow('Tenders', { id: 'TN-OLD', tenderNo: 'OLD/1', title: 'Entered before clients of its own', customerId: 'CU-OTHER', stage: 'draft', priority: 'Low', dataJson: '{}', active: 'TRUE' });
  st = await p.getTenderApp();
  const adopted = st.clients.find((c) => c.id === 'CU-OTHER');
  ok('its customer becomes a Tender Desk client, same id, so the tender keeps it', adopted && adopted.name === 'Another Test Mills' && st.tenders.find((x) => x.id === 'TN-OLD').client === 'CU-OTHER');
  st = await p.getTenderApp();
  ok('once only', st.clients.filter((c) => c.id === 'CU-OTHER').length === 1);

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
