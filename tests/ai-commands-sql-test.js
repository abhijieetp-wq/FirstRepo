/**
 * ERP 2.0's AI commands, on the server, with Claude replaced by a stand-in that answers what
 * it is told to: off without the service; what each role may ask for; what is sent (the
 * words, who and when, the ERP's lists — never the customer list); names matched to staff and
 * customers here, and what stops an action; the ticked actions done through each form's own
 * save, one failing without stopping the rest, and nothing a role could not do by hand.
 *
 * Customers and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/ai-commands-sql-test.js
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
const { aiService } = require(path.join(__dirname, '..', 'server', 'ai.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
};
const refused = async (fn, re) => {
  try { await fn(); return 'not refused'; } catch (e) { return re.test(e.message) ? true : e.message; }
};

const TENANT = 'ai-commands-test';
const ANIL = { email: 'anil@pie.in', name: 'Anil Rao', role: 'Management', businessStream: 'All' };
const NEHA = { email: 'neha@pie.in', name: 'Neha Joshi', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const ROHAN = { email: 'rohan@pie.in', name: 'Rohan Kale', role: 'Sales Engineer', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej Pawar', role: 'Service Engineer', businessStream: 'All' };
const TEJAS = { email: 'tejas@pie.in', name: 'Tejas More', role: 'Service Coordinator', businessStream: 'All' };
const TABLES = ['users', 'customers', 'customer_contacts', 'spare_enquiries', 'leads', 'lead_requirements', 'service_jobs', 'tasks', 'sales_visits',
  'config_lists', 'audit_log'];
const blank = { title: '', person: '', company: '', date: '', area: '', purpose: '', details: '', contactName: '', phone: '', model: '', type: '', priority: '', screen: '' };
const act = (kind, extra) => Object.assign({ kind }, blank, extra || {});

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [ANIL, NEHA, ROHAN, TEJ, TEJAS]) {
    await db.appendRow('Users', { id: 'U-' + u.email, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Agro Foods', active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-2', customerCode: 'C2', name: 'Kalyani Forgings', active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-3', customerCode: 'C3', name: 'Kalyani Castings', active: 'TRUE' });

  // Claude, stood in for: answers with whatever the test sets, and keeps what it was asked.
  const asked = [];
  let answer = { reply: '', actions: [] };
  const stand = { enabled: true, reason: '', propose: async (req) => { asked.push(req); return JSON.parse(JSON.stringify(answer)); } };
  const as = (who, ai) => { const p = loadPortal(db, who.email, { quiet: true, ai }); p.CURRENT_USER_ = who; return p; };
  const anil = as(ANIL, stand);
  const neha = as(NEHA, stand);
  const rohan = as(ROHAN, stand);
  const tej = as(TEJ, stand);
  const today = anil.todayIso_();
  const day = (n) => anil.addDays_(today, n);
  const dmy = (iso) => iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);

  console.log('OFF WITHOUT THE SERVICE');
  // As the server makes it with no ANTHROPIC_API_KEY in its environment.
  const bare = as(ANIL, aiService({ env: {} }));
  let s = await bare.getAiStatus();
  ok('says it is off, and why', s.enabled === false && /ANTHROPIC_API_KEY/.test(s.reason), s);
  ok('and reads nothing', await refused(() => bare.proposeAiCommand('Remind Neha'), /ANTHROPIC_API_KEY/));
  ok('bootstrap tells the screen', (await bare.bootstrap()).aiCommands === false && (await anil.bootstrap()).aiCommands === true);
  ok('a portal handed no service at all is off too', (await as(ANIL).getAiStatus()).enabled === false);

  console.log('\nWHAT EACH MAY ASK FOR');
  s = await anil.getAiStatus();
  ok('Management: everything', s.enabled && s.kinds.join() === 'task,visit,lead,enquiry,service,open' && s.examples.length === 6);
  ok('the spares coordinator: no compressor leads', (await neha.getAiStatus()).kinds.join() === 'task,visit,enquiry,service,open');
  ok('a service engineer: tasks, service calls, screens', (await tej.getAiStatus()).kinds.join() === 'task,service,open');
  ok('a sales engineer: no service calls', (await rohan.getAiStatus()).kinds.join() === 'task,visit,lead,enquiry,open');
  ok('words needed', await refused(() => anil.proposeAiCommand('  '), /Say what you want done/));
  ok('and not an essay', await refused(() => anil.proposeAiCommand('x'.repeat(1001)), /under 1,000 characters/));

  console.log('\nWHAT IS SENT');
  answer = { reply: 'A task for Rohan.', actions: [act('task', { title: 'Send the revised offer', person: 'Rohan', date: day(2), priority: 'High' })] };
  let p = await neha.proposeAiCommand('Remind Rohan to send the revised offer to Testwell by ' + day(2) + ', high priority');
  const req = asked[asked.length - 1];
  ok('the words, who is asking and today', /Request: Remind Rohan/.test(req.text) && req.text.indexOf('Today is ') === 0 &&
    req.text.indexOf(today) !== -1 && /I am Neha Joshi \(Sales Coordinator\)/.test(req.text), req.text);
  ok('only what this person may ask for', req.schema.properties.actions.items.properties.kind.enum.join() === 'task,visit,enquiry,service,open' &&
    !/- lead:/.test(req.system) && /- enquiry:/.test(req.system));
  ok('the ERP’s lists', /Breakdown, AMC visit/.test(req.system) && /Wardha/.test(req.system) && /Air audit \/ energy study/.test(req.system));
  ok('never the customer list', JSON.stringify(req).indexOf('Kalyani') === -1 && JSON.stringify(req).indexOf('CU-1') === -1);
  ok('the schema holds every field to a string', req.schema.properties.actions.items.additionalProperties === false &&
    req.schema.properties.actions.items.required.length === 14);
  ok('the reply passed on', p.reply === 'A task for Rohan.');
  const t1 = p.actions[0];
  ok('a task, matched to Rohan by first name', t1.kind === 'task' && t1.label === 'Task: Send the revised offer' && t1.problem === '' &&
    t1.input.assigneeEmail === 'rohan@pie.in' && t1.input.dueDate === day(2) && t1.input.priority === 'High', t1);
  ok('shown in words', JSON.stringify(t1.lines) === JSON.stringify([['For', 'Rohan Kale'], ['Due', dmy(day(2))], ['Priority', 'High']]), t1.lines);

  console.log('\nNAMES MATCHED HERE, AND WHAT STOPS AN ACTION');
  answer = { reply: '', actions: [
    act('task', { title: 'Check the stock', person: 'me' }),
    act('task', { title: 'Call back', person: 'Sunil' }),
    act('task', { title: 'Visit plant', person: 'Tej' }),
    act('enquiry', { company: 'testwell', details: 'Air filter and separator', model: 'EG 99', phone: '9800000001' }),
    act('enquiry', { company: 'Kalyani', details: 'Oil filter' }),
    act('enquiry', { company: 'Brightline Mills', details: 'Belts' }),
    act('lead', { company: 'Sunrise Agro', details: '37 kW screw' }),
    act('open', { screen: 'servicedue' })
  ] };
  p = await neha.proposeAiCommand('several things');
  const [me, nobody, twoTejs, enq, twoKalyanis, unknown, lead, open] = p.actions;
  ok('"me" is the speaker, due tomorrow unless said', me.input.assigneeEmail === 'neha@pie.in' && me.input.dueDate === day(1), me);
  ok('a name nobody has', nobody.input === null && /Nobody called Sunil/.test(nobody.problem));
  ok('a first name exactly, not one that starts with it', twoTejs.input && twoTejs.input.assigneeEmail === 'tej@pie.in', twoTejs);
  ok('a customer by the start of the name, any case', enq.input && enq.input.customerId === 'CU-1' && enq.input.customerName === 'Testwell Agro Foods' &&
    enq.input.enquiryType === 'Spares' && enq.input.productModel === 'EG 99' && enq.label === 'Spare enquiry: Testwell Agro Foods', enq);
  ok('two customers that match is said, not guessed', twoKalyanis.input === null && /More than one customer matches Kalyani/.test(twoKalyanis.problem));
  ok('a spare enquiry needs a customer on the list', unknown.input === null && /No customer called Brightline Mills.*add them first/.test(unknown.problem));
  ok('nothing this role could not do by hand', lead.input === null && /cannot do that by hand/.test(lead.problem));
  ok('a screen', open.input && open.input.view === 'servicedue' && open.label === 'Open SDR');
  answer = { reply: '', actions: [act('visit', { company: 'Brightline Mills', date: day(3), area: 'Atlantis', purpose: 'air audit / energy study', person: 'Rohan' }),
    act('service', { company: 'Kalyani Forgings', type: 'Breakdown', details: 'Tripping on high temperature', priority: 'Urgent', area: 'Wardha', contactName: 'Mr Shah' }),
    act('task', { title: 'Old', date: day(-1) }), act('open', { screen: 'payroll' })].concat(Array(8).fill(act('open', { screen: 'tasks' }))) };
  p = await anil.proposeAiCommand('a visit and a breakdown');
  const [visit, svc, past, noScreen] = p.actions;
  ok('a visit for someone else, by one who may plan for others', visit.input.engineerEmail === 'rohan@pie.in' && visit.input.customerId === '' &&
    visit.input.purpose === 'Air audit / energy study', visit);
  ok('an area not on the list is left out, and said', visit.input.area === '' && visit.lines.some((l) => l[0] === 'Area' && /not on the area list/.test(l[1])));
  ok('a service call', svc.input.customerId === 'CU-2' && svc.input.jobType === 'Breakdown' && svc.input.urgency === 'Urgent' && svc.input.area === 'Wardha' &&
    svc.label === 'Breakdown: Kalyani Forgings', svc);
  ok('a task due before today', past.input === null && /before today/.test(past.problem));
  ok('a screen there is not', noScreen.input === null && /no screen called that/.test(noScreen.problem));
  ok('eight at most', p.actions.length === 8);

  console.log('\nDOING WHAT WAS TICKED');
  answer = { reply: '', actions: [
    act('task', { title: 'Send the revised offer', person: 'Rohan', date: day(2) }),
    act('enquiry', { company: 'Testwell', details: 'Air filter and separator', model: 'EG 99', contactName: 'Mr Pathak', phone: '9800000001' }),
    act('service', { company: 'Kalyani Forgings', details: 'Tripping on high temperature', type: 'Breakdown', priority: 'Urgent' }),
    act('visit', { company: 'Brightline Mills', date: day(3), area: 'Wardha', purpose: 'Air audit / energy study' }),
    act('open', { screen: 'tasks' })
  ] };
  p = await neha.proposeAiCommand('do it all');
  let r = await neha.applyAiActions(p.actions.map((a) => ({ kind: a.kind, input: a.input })));
  ok('each done, each said', r.length === 5 && r.every((x) => x.ok) && /^Task given to Rohan Kale\.$/.test(r[0].text) && /^Enquiry .* logged for Testwell Agro Foods\.$/.test(r[1].text) &&
    /logged as Breakdown\.$/.test(r[2].text) && /^Visit to Brightline Mills planned for /.test(r[3].text) && r[4].view === 'tasks', r);
  const task = (await db.q('SELECT * FROM tasks WHERE tenant_id=$1', [TENANT])).rows[0];
  ok('the task through the task save, given by the speaker', task && task.assignee_email === 'rohan@pie.in' && task.created_by === 'neha@pie.in' && task.title === 'Send the revised offer');
  const se = (await db.q('SELECT * FROM spare_enquiries WHERE tenant_id=$1', [TENANT])).rows[0];
  ok('the enquiry through the enquiry save', se && se.customer_id === 'CU-1' && se.product_model === 'EG 99' && se.status === 'New' && se.enquiry_type === 'Spares', se);
  const job = (await db.q('SELECT * FROM service_jobs WHERE tenant_id=$1', [TENANT])).rows[0];
  ok('the call through the service save', job && job.customer_id === 'CU-2' && job.job_type === 'Breakdown' && job.urgency === 'Urgent' && job.status === 'Unassigned');
  const v = (await db.q('SELECT * FROM sales_visits WHERE tenant_id=$1', [TENANT])).rows[0];
  ok('the visit through the visit save, planned', v && v.engineer_email === 'neha@pie.in' && v.area === 'Wardha' && v.status === 'Planned');

  answer = { reply: '', actions: [act('lead', { company: 'Sunrise Agro', details: '37 kW screw', contactName: 'Mr Rao', date: day(4), area: 'Pune' })] };
  p = await rohan.proposeAiCommand('a lead');
  r = await rohan.applyAiActions([{ kind: 'lead', input: p.actions[0].input }, { kind: 'task', input: { title: 'x', assigneeEmail: 'rohan@pie.in', dueDate: day(-3) } }]);
  const ld = (await db.q('SELECT * FROM leads WHERE tenant_id=$1', [TENANT])).rows[0];
  ok('a lead through ERP 1’s own lead save', r[0].ok && ld && ld.customer_name === 'Sunrise Agro' && ld.sales_engineer_email === 'rohan@pie.in' && ld.area === 'Pune', ld);
  ok('one failing says why and stops nothing', r.length === 2 && r[1].ok === false && /cannot be due before today/.test(r[1].text));
  r = await tej.applyAiActions([{ kind: 'enquiry', input: { customerId: 'CU-1', requirementText: 'x' } }, { kind: 'payroll', input: {} }]);
  ok('a role keeps to what it may do by hand', r.every((x) => !x.ok && /role cannot do that/.test(x.text)));
  ok('something to do is needed', await refused(() => tej.applyAiActions([]), /Tick at least one/));

  console.log('\nA LIMIT ON THE BILL');
  answer = { reply: '', actions: [] };
  const busy = as(TEJ, stand);
  const before = asked.length;
  for (let i = 0; i < 40; i++) await busy.proposeAiCommand('open tasks');
  ok('forty an hour', asked.length - before === 40);
  ok('then it says so, and asks nothing', await refused(() => busy.proposeAiCommand('open tasks'), /40 requests this hour/) && asked.length - before === 40);
  ok('a refused request costs nothing', await refused(() => as(ROHAN, stand).proposeAiCommand(''), /Say what you want done/) && asked.length - before === 40);

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 8).join('\n'));
  process.exit(1);
});
