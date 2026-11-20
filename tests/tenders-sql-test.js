/**
 * The Tender Desk, phase 1 (Tenders.gs): who sees it, entering a tender (by hand and from its
 * document, read by AI), the nine steps and what each needs, approval, assigning with its task,
 * preparation, the checklist, submission, the opening and the result, withdrawing, the lists,
 * and the notices on a person's dashboard.
 *
 * People, customers and tenders are invented.
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
const TABLES = ['users', 'audit_log', 'sessions', 'customers', 'customer_addresses', 'tenders', 'tender_items', 'tender_events',
  'tender_lists', 'documents', 'tasks'];

// A file store and an AI that only remember what they were given.
const files = {};
let fileN = 0;
const drive = {
  getFoldersByName: () => ({ hasNext: () => false }),
  createFolder: () => ({ createFile: (blob) => { const id = 'F' + (++fileN); files[id] = { blob, trashed: false }; return { getId: () => id, getUrl: () => 'https://files.invalid/' + id }; } }),
  getFileById: (id) => ({ setTrashed: (v) => { if (files[id]) files[id].trashed = v; } })
};
let aiAsked = null;
let aiAnswer = null;
const ai = { enabled: true, reason: '', propose: async (req) => { aiAsked = req; return aiAnswer; } };

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
  await person('U-SVC', 'kiran', 'Kiran Pawar', 'Service Engineer');
  await db.appendRow('Customers', { id: 'CU-GEN', customerCode: 'TG1', name: 'Test State Power Generation Co Ltd', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-K', customerId: 'CU-GEN', addressType: 'Site', line1: 'Test Thermal Power Station', city: 'Nagpur', state: 'Maharashtra', pincode: '441111' });
  await db.appendRow('Customers', { id: 'CU-OTHER', customerCode: 'TO1', name: 'Another Test Mills', active: 'TRUE' });

  const p = loadPortal(db, 'office@pie.invalid', { quiet: true, properties: {}, drive, ai });
  const as = async (id) => {
    const r = (await p.readTable_('Users')).find((u) => u.id === id);
    p.CURRENT_USER_ = await p.userFromRow_(r);
    return p.CURRENT_USER_;
  };
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 invented tender').toString('base64');
  const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const today = inDays(0);

  console.log('WHO SEES THE TENDER DESK');
  ok('the ERP admin, Management and Accounts always', (await as('U-ADMIN')).role === 'ERP Admin' && !!(await p.getTenderDesk()) &&
    (await as('U-MGMT')) && !!(await p.getTenderDesk()) && (await as('U-ACC')) && !!(await p.getTenderDesk()));
  await as('U-ENG2');
  ok('a Sales Engineer without the tick does not', await refuses(() => p.getTenderDesk(), /not open to your account.*tick “Tender Desk”/));
  await as('U-SVC');
  ok('nor the service office', await refuses(() => p.getTenderDesk(), /not open to your account/));
  await as('U-ENG');
  const engDesk = await p.getTenderDesk();
  ok('a Sales Engineer with the tick does, but cannot enter tenders', !!engDesk && engDesk.can.create === false);
  ok('nor enter one', await refuses(() => p.saveTender({ tenderNo: 'X/1', title: 'Nothing' }), /entered by a Sales Coordinator, Management or the ERP Admin/));
  await as('U-ADMIN');
  let s = await p.getSettings();
  ok('Accounts is a role the Users screen offers', s.roles.includes('Accounts'));
  await p.saveUser({ id: 'U-ENG2', email: 'amol@pie.invalid', username: 'amol', name: 'Amol Shinde', role: 'Sales Engineer', businessStream: 'All', tenderDesk: true });
  ok('ticked on the Users screen, it is kept', (await db.q("SELECT tender_desk FROM users WHERE tenant_id = $1 AND id = 'U-ENG2'", [TENANT])).rows[0].tender_desk === 'TRUE');
  await as('U-ENG2');
  ok('and opens the Tender Desk to them', !!(await p.getTenderDesk()));

  console.log('\nENTERING A TENDER BY HAND');
  await as('U-COORD');
  let t = await p.saveTender({ tenderNo: 'TG/TTPS/2026/1187', title: 'Supply of screw air compressors for ash handling', customerId: 'CU-GEN',
    addressId: 'AD-K', portal: 'Mahatenders', category: 'Goods supply', priority: 'High', lastDate: inDays(10), dueTime: '15:00',
    estimatedValue: '24,50,000', emdAmount: 49000, emdType: 'Online',
    items: [{ description: 'Screw air compressor 160 cfm, 7.5 bar', qty: '2', uom: 'Nos', spec: 'IS 5456' }, { description: '', qty: 1 }] });
  ok('saved as a draft, with the coordinator’s name in its history', t.stage === 'draft' && t.summary.stageLabel === 'Draft' &&
    t.events.length === 1 && t.events[0].byName === 'Isha Kulkarni' && t.customerName === 'Test State Power Generation Co Ltd');
  ok('money typed with commas is a number', Number(t.estimatedValue) === 2450000);
  ok('its items, blank lines left out', t.items.length === 1 && Number(t.items[0].qty) === 2 && t.items[0].uom === 'Nos');
  ok('the plant offered from the customer’s addresses', t.addresses.length === 1 && t.addresses[0].id === 'AD-K');
  ok('a portal not on the list is refused', await refuses(() => p.saveTender({ id: t.id, portal: 'Somewhere' }), /The portal must be one of/));
  ok('a time that is not a time is refused', await refuses(() => p.saveTender({ id: t.id, dueTime: '3pm' }), /hours and minutes/));
  ok('a customer that is not one is refused', await refuses(() => p.saveTender({ id: t.id, customerId: 'CU-NONE' }), /not in Customers/));

  console.log('\nTHE FIRST STEP AND WHAT IT NEEDS');
  ok('sending for approval waits for the tender document', t.gate.next === 'approval' && t.gate.open === 1 &&
    t.gate.reqs.find((r) => !r.ok).text === 'Tender document attached' && t.gate.canAct === true, t.gate.reqs.filter((r) => !r.ok));
  ok('and says what is open when tried', await refuses(() => p.advanceTender(t.id), /1 thing is still open/));
  t = await p.attachTenderDocument({ tenderId: t.id, dataUrl: pdf, name: 'NIT 1187.pdf', docType: 'Tender document' });
  ok('the document is kept in the ERP’s files, against the tender', t.documents.length === 1 && /NIT 1187\.pdf$/.test(t.documents[0].fileName) &&
    t.documents[0].docType === 'Tender document' && Object.keys(files).length === 1);
  const dup = await p.saveTender({ tenderNo: 'tg/ttps/2026/1187 ', title: 'Same tender typed again', customerId: 'CU-GEN' });
  ok('the same tender number twice is caught before approval', dup.gate.reqs.some((r) => r.text === 'Tender number is not already on the desk' && !r.ok));
  await p.deleteTender(dup.id);
  ok('a draft entered by mistake can be removed', (await p.getTenderDesk()).tenders.every((x) => x.id !== dup.id));
  t = await p.advanceTender(t.id);
  ok('sent for approval', t.stage === 'approval' && t.approvalStatus === 'Pending' && t.events[0].text === 'Draft → Awaiting approval');

  console.log('\nMANAGEMENT’S DECISION');
  ok('nobody else can take it', await refuses(() => p.decideTender(t.id, 'approve', ''), /Management approves or declines/));
  await as('U-MGMT');
  let desk = await p.getTenderDesk();
  ok('it waits on Management’s Tender Desk', desk.kpis.awaitingApproval === 1 && desk.alerts.some((a) => a.approval && a.tenderId === t.id));
  const notices = await p.tenderDashboardNotices_(p.CURRENT_USER_);
  ok('and on their dashboard', !!notices && notices.some((a) => a.approval));
  ok('declining needs a reason', await refuses(() => p.decideTender(t.id, 'decline', ''), /Say why/));
  t = await p.decideTender(t.id, 'approve', 'Repeat client, go in sharp on price.');
  ok('approved, with the note', t.stage === 'approved' && t.approvalStatus === 'Approved' && t.approvalNote === 'Repeat client, go in sharp on price.');

  console.log('\nASSIGNING, WITH ITS TASK');
  await as('U-COORD');
  ok('Advance does not assign', await refuses(() => p.advanceTender(t.id), /Choose who prepares it/));
  ok('only to somebody with the Tender Desk', await refuses(() => p.assignTender(t.id, 'kiran@pie.invalid'), /Choose somebody who has the Tender Desk/));
  t = await p.assignTender(t.id, 'rohan@pie.invalid');
  ok('assigned', t.stage === 'assigned' && t.assigneeEmail === 'rohan@pie.invalid' && t.events[0].text === 'Assigned to Rohan Patil');
  const task = t.tasks[0] || {};
  ok('with a task on the main Tasks page, due the day before the last date, high priority', t.tasks.length === 1 &&
    task.title === 'Prepare & submit bid – TG/TTPS/2026/1187' && task.dueDate === inDays(9) && task.assigneeName === 'Rohan Patil', task);
  await as('U-ENG');
  const tasks = await p.getTasks({ period: 'month' });
  const mine = (tasks.tasks || tasks.mine || []).find((k) => /1187/.test(k.title));
  ok('which Rohan sees, linked to the tender', !!mine && mine.link && mine.link.kind === 'tender' && mine.link.id === t.id && mine.link.word === 'Tender', mine);

  console.log('\nPREPARATION');
  t = await p.advanceTender(t.id);
  ok('Rohan starts preparation', t.stage === 'prep');
  ok('the next step lists the preparation still open', t.gate.next === 'ready' && t.gate.open === 10, t.gate.reqs);
  t = await p.saveTenderSection({ id: t.id, section: 'prep', data: { enquiryDate: inDays(-1), enquiryTo: 'Three makers', offersPerSpec: 'Partial',
    tcAccepted: 'Yes', min3: 'Yes', compChart: 'Yes', docsRecv: 'NA', nego: 'Yes', finalVendor: 'Maker A' } });
  ok('saved: only the EMD questions left', t.gate.open === 2 && t.prep.offersPerSpec === 'Partial', t.gate.reqs.filter((r) => !r.ok));
  ok('an answer that is not one is refused', await refuses(() => p.saveTenderSection({ id: t.id, section: 'prep', data: { min3: 'Maybe' } }), /Yes, No/));
  await as('U-ENG2');
  ok('another engineer cannot fill it in', await refuses(() => p.saveTenderSection({ id: t.id, section: 'prep', data: { min3: 'No' } }), /Only the person it is assigned to/));
  await as('U-ACC');
  t = await p.saveTenderSection({ id: t.id, section: 'prep', data: { emdArranged: 'Yes', emdBal: 'Yes', min3: 'No' } });
  ok('Accounts answers the EMD questions, and nothing else', t.prep.emdArranged === 'Yes' && t.prep.emdBal === 'Yes' && t.prep.min3 === 'Yes');
  ok('nor can Accounts take the step', await refuses(() => p.advanceTender(t.id), /taken by the person it is assigned to/));
  await as('U-ENG');
  t = await p.advanceTender(t.id);
  ok('ready to submit', t.stage === 'ready' && t.gate.next === 'submitted');

  console.log('\nTHE SUBMISSION CHECKLIST');
  const points = t.lists.checkpoints;
  ok('ten checkpoints, from CP1 “Tender document read & saved”', points.length === 10 && t.gate.reqs[0].text === 'CP1 · Tender document read & saved', t.gate.reqs[0]);
  const all = {};
  points.forEach((c, i) => { all[c.id] = i === 2 ? 'NA' : 'Yes'; });
  t = await p.saveTenderSection({ id: t.id, section: 'checklist', data: all });
  ok('ticked, the checklist is done', t.summary.checklist[0] === 10 && t.gate.reqs.slice(0, 10).every((r) => r.ok));
  t = await p.saveTenderSection({ id: t.id, section: 'submission', data: { submittedDate: inDays(11), ackNo: 'MT-2026-1187-55410', quoteOrRegret: 'Quote', submittedValue: 2310000, submittedTime: '13:42' } });
  ok('submitting after the last date is caught', t.gate.reqs.some((r) => r.text === 'Submitted on or before the last date' && !r.ok));
  t = await p.saveTenderSection({ id: t.id, section: 'submission', data: { submittedDate: today } });
  t = await p.advanceTender(t.id);
  ok('submitted', t.stage === 'submitted' && t.can.edit === false && t.can.documents === false);
  ok('its details are then kept as submitted', await refuses(() => p.saveTender({ id: t.id, title: 'Changed' }), /kept as submitted/));

  console.log('\nTHE OPENING AND THE RESULT');
  t = await p.saveTenderSection({ id: t.id, section: 'postbid', data: { technoDate: inDays(-1), participantCount: 5 } });
  ok('an opening before the submission is caught', t.gate.reqs.some((r) => /after the submission date/.test(r.text) && !r.ok));
  t = await p.saveTenderSection({ id: t.id, section: 'postbid', data: { technoDate: today } });
  t = await p.advanceTender(t.id);
  ok('bid opened', t.stage === 'opened' && t.gate.next === 'result');
  t = await p.saveTenderSection({ id: t.id, section: 'postbid', data: { result: 'lost' } });
  ok('lost needs its reason', t.gate.reqs.some((r) => r.text === 'Loss reason given' && !r.ok));
  ok('from the list', await refuses(() => p.saveTenderSection({ id: t.id, section: 'postbid', data: { resultReason: 'Bad luck' } }), /from the list/));
  t = await p.saveTenderSection({ id: t.id, section: 'postbid', data: { result: 'won', resultReason: '', awardedValue: 2310000, ourPosition: 'L1' } });
  t = await p.advanceTender(t.id);
  ok('won, and closed', t.stage === 'result' && t.result === 'won' && t.summary.stageLabel === 'Won' && t.gate === null);
  desk = await p.getTenderDesk();
  ok('counted as won this year, at the awarded value', desk.kpis.wonFy === 1 && desk.kpis.wonFyValue === 2310000);

  console.log('\nNOT PARTICIPATING');
  await as('U-COORD');
  let t2 = await p.saveTender({ tenderNo: 'TG/OTH/77', title: 'Something PIE will not bid for', customerId: 'CU-OTHER', lastDate: inDays(2) });
  ok('withdrawing needs a reason', await refuses(() => p.withdrawTender(t2.id, ''), /Say why/));
  t2 = await p.withdrawTender(t2.id, 'Outside what we supply.');
  ok('closed as Not participating', t2.stage === 'result' && t2.result === 'declined' && t2.summary.stageLabel === 'Not participating');

  console.log('\nDEADLINES ON THE DESK');
  const t3 = await p.saveTender({ tenderNo: 'TG/DUE/3', title: 'Due soon', customerId: 'CU-GEN', lastDate: inDays(2), priority: 'Medium' });
  desk = await p.getTenderDesk();
  const due = desk.alerts.find((a) => a.tenderId === t3.id) || {};
  ok('two days left: urgent', due.sev === 'bad' && /due in 2 days/.test(due.text), due);
  await as('U-ENG2');
  ok('not on the desk of an engineer it is not assigned to', (await p.getTenderDesk()).alerts.every((a) => a.tenderId !== t3.id));

  console.log('\nTHE DASHBOARD');
  await as('U-ACC');
  const accDash = await p.getPersonDashboard({});
  ok('Accounts has a dashboard of its own: tasks and the tenders, no sales figures', accDash.kind === 'accounts' &&
    !(accDash.tiles || []).some((x) => /quot|order|enquir/i.test(String(x.label || x.title || ''))) &&
    (accDash.tenders || []).some((a) => a.tenderId === t3.id), { kind: accDash.kind, tiles: (accDash.tiles || []).map((x) => x.label || x.title), tenders: accDash.tenders });
  await as('U-COORD');
  ok('the coordinator’s dashboard carries the deadline too', ((await p.getPersonDashboard({})).tenders || []).some((a) => a.tenderId === t3.id));
  await as('U-ENG2');
  ok('an engineer it is not assigned to sees none', !(await p.getPersonDashboard({})).tenders);

  console.log('\nTHE LISTS AND THE RULES');
  await as('U-COORD');
  let st = await p.getTenderSettings();
  ok('standard lists to start with', st.lists.portal.items.length === 5 && st.lists.checkpoint.items.length === 10 && st.rules.alertDays === 7);
  const cps = st.lists.checkpoint.items;
  st = await p.saveTenderList({ list: 'checkpoint', items: cps.slice(0, 9).concat([{ name: 'Acknowledgement filed', description: 'Saved to the tender’s documents.' }]) });
  ok('changed, the kept checkpoints keep their ids, so answers still match', st.lists.checkpoint.items[0].id === cps[0].id &&
    st.lists.checkpoint.items[9].name === 'Acknowledgement filed');
  ok('the same entry twice is refused', await refuses(() => p.saveTenderList({ list: 'portal', items: [{ name: 'GeM' }, { name: 'gem' }] }), /twice/));
  st = await p.saveTenderRules({ alertDays: 10, urgentDays: 4 });
  ok('the warning days are kept', st.rules.alertDays === 10 && st.rules.urgentDays === 4);
  await as('U-ENG');
  ok('an engineer cannot change them', await refuses(() => p.saveTenderRules({ alertDays: 3, urgentDays: 1 }), /kept by a Sales Coordinator/));

  console.log('\nTHE DOCUMENT, READ BY AI');
  await as('U-COORD');
  aiAnswer = { tenderNo: 'TG/KHT/T-2026/1342', title: 'Supply of oil-free compressors for unit 5', clientName: 'Test State Power Generation Co. Ltd.',
    plant: 'Khaperkheda TPS', portalName: 'mahatenders.gov.in', category: 'Goods supply', publishedDate: inDays(-1), lastDate: inDays(9),
    dueTime: '15:00', estimatedValue: 'Rs 1,26,40,000/-', emdAmount: '126400', emdType: 'Online', tenderFeeAmount: '5900',
    deliveryPeriod: '120 days from PO', sdPct: '3', pbgPct: '10', ldClause: '0.5% per week, max 10%',
    eligibility: ['OEM or authorised dealer', 'Turnover ≥ ₹38 lakh'], unsure: ['emdType'],
    items: [{ description: 'Oil-free screw compressor 300 cfm', qty: '4', uom: 'nos', spec: 'ISO 8573 class 0' }, { description: '', qty: '', uom: '', spec: '' }] };
  const read = await p.readTenderDocument({ dataUrl: pdf, name: 'NIT 1342.pdf' });
  ok('the PDF goes to Claude as a document, before the request', aiAsked && Array.isArray(aiAsked.content) && aiAsked.content[0].type === 'document' &&
    aiAsked.content[0].source.media_type === 'application/pdf' && aiAsked.content[1].type === 'text' && aiAsked.effort === 'medium', aiAsked && aiAsked.content && aiAsked.content.map((c) => c.type));
  const f = read.fields || {};
  ok('the fields come back as the form’s own: money in rupees, the portal and units matched', f.tenderNo === 'TG/KHT/T-2026/1342' && f.estimatedValue === 12640000 &&
    f.portal === 'Mahatenders' && f.emdType === 'Online' && f.items.length === 1 && f.items[0].uom === 'Nos' && f.items[0].qty === 4 && f.sdRequired === 'Yes', f);
  ok('the eligibility as lines, and what it was unsure of', f.eligibility === 'OEM or authorised dealer\nTurnover ≥ ₹38 lakh' && f.unsure[0] === 'emdType');
  ok('the client matched to a customer, best first', read.matches[0] && read.matches[0].id === 'CU-GEN', read.matches);
  const t4 = await p.saveTender(Object.assign({}, f, { customerId: 'CU-GEN', priority: 'High', aiRead: true, documentIds: [read.documentId] }));
  ok('saved, the document is filed against the new tender', t4.documents.length === 1 && t4.documents[0].id === read.documentId && t4.aiRead === 'TRUE' &&
    /read by AI/.test(t4.events[0].text));
  ok('a picture of the pages is read too, a spreadsheet is not', await refuses(() => p.readTenderDocument({ dataUrl: 'data:application/vnd.ms-excel;base64,AAAA', name: 'x.xls' }), /PDF, or a photograph/));
  const off = loadPortal(db, 'office@pie.invalid', { quiet: true, properties: {}, drive, ai: { enabled: false, reason: 'AI commands are off: no key.' } });
  off.CURRENT_USER_ = p.CURRENT_USER_;
  const noAi = await off.readTenderDocument({ dataUrl: pdf, name: 'NIT 9.pdf' });
  ok('without AI the file is still kept, and it says why it was not read', !!noAi.documentId && !noAi.fields && /no key/.test(noAi.aiOff));

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : 'all ') + pass + ' passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
