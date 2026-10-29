/**
 * ERP 2.0's sales visit plans, on the server: planning a visit, who sees and plans whose,
 * the visit report, the Local and Outstation areas, copying last week's plan, a visit made into
 * a compressor lead through ERP 1's own lead save, and the dashboard tile.
 *
 * Customers and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/visit-plans-sql-test.js
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
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
};
const refused = async (fn, re) => {
  try { await fn(); return 'not refused'; } catch (e) { return re.test(e.message) ? true : e.message; }
};

const TENANT = 'visit-plans-test';
const ROHAN = { email: 'rohan@pie.in', name: 'Rohan', role: 'Sales Engineer', businessStream: 'All' };
const RAVI = { email: 'ravi@pie.in', name: 'Ravi', role: 'Sales Engineer', businessStream: 'All' };
const PRIYA = { email: 'priya@pie.in', name: 'Priya', role: 'Sales Coordinator', businessStream: 'All' };
const NEHA = { email: 'neha@pie.in', name: 'Neha', role: 'Sales Coordinator', businessStream: 'Compressor Sales' };
const MONA = { email: 'mona@pie.in', name: 'Mona', role: 'Management', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const TABLES = ['users', 'customers', 'sales_visits', 'leads', 'lead_requirements', 'config_lists', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [ROHAN, RAVI, PRIYA, NEHA, MONA, TEJ]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const rohan = as(ROHAN);
  const neha = as(NEHA);
  const mona = as(MONA);
  const tej = as(TEJ);
  const today = rohan.todayIso_();
  const day = (n) => rohan.addDays_(today, n);
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const monday = day(-dow);
  const range = { from: day(-14), to: day(14) };

  console.log('PLANNING A VISIT');
  const v1 = await rohan.saveVisit({ engineerEmail: RAVI.email, visitDate: today, customerName: 'testwell foods', area: 'Butibori MIDC' });
  ok('planned, for themselves whoever they name', v1.engineerName === 'Rohan' && v1.status === 'Planned' && v1.visitDate === today, v1);
  ok('a company typed as a customer is that customer', v1.customerId === 'CU-1' && v1.customerName === 'testwell foods');
  ok('the purpose defaults to the first on ERP 2’s list', v1.purpose === 'New customer – prospecting');
  ok('the area with its kind', v1.area === 'Butibori MIDC' && v1.areaType === 'Local');
  const v2 = await rohan.saveVisit({ visitDate: day(2), customerName: 'Brightline Mills', area: 'Wardha', purpose: 'Air audit / energy study' });
  ok('a prospect by name, outstation', v2.customerId === '' && v2.areaType === 'Outstation');
  const v3 = await neha.saveVisit({ engineerEmail: RAVI.email, visitDate: day(1), customerName: 'Testwell Foods' });
  ok('a coordinator plans for an engineer', v3.engineerName === 'Ravi');
  ok('it needs a company', await refused(() => rohan.saveVisit({ visitDate: today, customerName: ' ' }), /Name the company/));
  ok('and a date', await refused(() => rohan.saveVisit({ visitDate: '', customerName: 'X' }), /date of the visit/));
  ok('an area from the list', await refused(() => rohan.saveVisit({ visitDate: today, customerName: 'X', area: 'Atlantis' }), /area from the list/));
  ok('a real status', await refused(() => rohan.saveVisit({ visitDate: today, customerName: 'X', status: 'Maybe' }), /Planned, Visited/));
  ok('not visited before the day', await refused(() => rohan.saveVisit({ visitDate: day(3), customerName: 'X', status: 'Visited' }), /cannot be marked visited yet/));
  ok('interest is hot, warm or cold', await refused(() => rohan.saveVisit({ visitDate: today, customerName: 'X', interest: 'Lukewarm' }), /Hot, Warm or Cold/));
  ok('a potential in rupees', await refused(() => rohan.saveVisit({ visitDate: today, customerName: 'X', potentialValue: -5 }), /potential value/));
  ok('a coordinator names somebody real', await refused(() => neha.saveVisit({ engineerEmail: 'nobody@pie.in', visitDate: today, customerName: 'X' }), /Pick the sales engineer/));
  ok('service plans no sales visits', await refused(() => tej.saveVisit({ visitDate: today, customerName: 'X' }), /.+/) &&
    await refused(() => tej.getVisitPlans(range), /.+/));

  console.log('\nWHO SEES WHOSE');
  let plan = await rohan.getVisitPlans(Object.assign({ engineer: RAVI.email }, range));
  ok('an engineer sees their own, whoever they ask for', plan.visits.map((v) => v.customerName).join() === 'testwell foods,Brightline Mills' &&
    plan.seeAll === false && plan.engineer === ROHAN.email, plan.visits.map((v) => v.customerName));
  plan = await neha.getVisitPlans(range);
  ok('a coordinator sees everybody’s, in date order', plan.visits.length === 3 && plan.visits[1].engineerName === 'Ravi' && plan.seeAll === true);
  ok('or one engineer’s', (await neha.getVisitPlans(Object.assign({ engineer: RAVI.email }, range))).visits.length === 1);
  ok('the people who make visits', plan.people.map((p) => p.name).join() === 'Neha,Priya,Ravi,Rohan', plan.people);
  ok('ERP 2’s areas, Local and Outstation, until Management sets its own', plan.areas.length === 17 && plan.areas[0].name === 'Nagpur City' &&
    plan.areas[0].type === 'Local' && plan.areas.filter((a) => a.type === 'Outstation').length === 12);
  ok('ERP 2’s lists', plan.lists.compTypes.length === 7 && plan.lists.brands[0] === 'ELGI' && plan.lists.timelines.length === 6 && plan.lists.purposes.length === 6);
  await db.appendRow('ConfigLists', { id: 'CL-I1', category: 'Industry', code: 'TEXTILE', label: 'Textile', sortOrder: 1, active: 'TRUE' });
  ok('and ERP 1’s own industry list where it has one', (await neha.getVisitPlans(range)).lists.industries.join() === 'Textile');
  ok('at most two months at a time', await refused(() => neha.getVisitPlans({ from: day(0), to: day(80) }), /two months/) &&
    await refused(() => neha.getVisitPlans({ from: day(5), to: day(1) }), /ends before it starts/));

  console.log('\nWHAT THE VISIT FOUND');
  let r = await rohan.saveVisit({ id: v1.id, status: 'Visited', contactMet: 'Mr Rao', phone: '9800000001', industry: 'Textile',
    discussion: 'Two old machines, air leaks', compType: 'Screw – oil-lubricated, fixed speed', brand: 'Atlas Copco', capacity: '2 × 22 kW',
    ageYears: '9', considering: 'ELGI', interest: 'Hot', requirement: '37 kW VFD screw', timeline: '1–3 months', potentialValue: 450000,
    nextAction: 'Send the offer', nextDate: day(3) });
  ok('the report saved, the visit visited', r.status === 'Visited' && r.contactMet === 'Mr Rao' && r.interest === 'Hot' && r.potentialValue === 450000 &&
    r.nextDate === day(3) && r.compType === 'Screw – oil-lubricated, fixed speed', r);
  r = await rohan.saveVisit({ id: v1.id, discussion: 'Two old machines, air leaks; wants a quote this week' });
  ok('a change keeps what it does not send', r.contactMet === 'Mr Rao' && r.brand === 'Atlas Copco' && r.area === 'Butibori MIDC' &&
    r.discussion === 'Two old machines, air leaks; wants a quote this week');
  ok('an engineer cannot touch another’s visit', await refused(() => rohan.saveVisit({ id: v3.id, discussion: 'mine now' }), /no longer there/));

  console.log('\nA VISIT MADE INTO AN ENQUIRY');
  ok('not before the visit', await refused(() => rohan.createVisitEnquiry(v2.id), /once the visit has happened/));
  const v4 = await rohan.saveVisit({ visitDate: today, customerName: 'Brightline Mills', area: 'Wardha', requirement: 'Dryer' });
  ok('not without the next action date ERP 1 needs', await refused(() => rohan.createVisitEnquiry(v4.id), /next action date/));
  const made = await rohan.createVisitEnquiry(v1.id);
  const lead = (await db.q('SELECT * FROM leads WHERE tenant_id=$1 AND id=$2', [TENANT, made.leadId])).rows[0];
  ok('a compressor lead, numbered by ERP 1', /^LD\d{4}-\d{3}$/.test(made.leadNo) && lead.lead_no === made.leadNo && lead.business_stream === 'Compressor Sales', made);
  ok('from the field visit, with the company, contact and area', lead.source === 'Field Visit' && lead.customer_id === 'CU-1' &&
    lead.customer_name === 'testwell foods' && lead.contact_name === 'Mr Rao' && lead.contact_phone === '9800000001' && lead.prospect_city === 'Butibori MIDC', lead);
  ok('what they want and what they run', lead.requirement_summary === '37 kW VFD screw (in use: Atlas Copco · Screw – oil-lubricated, fixed speed · 2 × 22 kW)' &&
    Number(lead.budget) === 450000 && lead.industry === 'Textile', lead.requirement_summary);
  ok('found by the engineer, run by a compressor coordinator, qualified, with its next action', lead.sales_engineer_email === ROHAN.email &&
    lead.owner_email === NEHA.email && lead.status === 'Qualified' && String(lead.next_action_date).slice(0, 10) === day(3), [lead.owner_email, lead.status]);
  ok('the visit keeps it', made.visit.leadId === made.leadId && made.visit.leadNo === made.leadNo && made.visit.leadStatus === 'Qualified');
  ok('once', await refused(() => rohan.createVisitEnquiry(v1.id), /already made an enquiry/));
  await rohan.saveVisit({ id: v4.id, nextDate: day(5) });
  const made4 = await rohan.createVisitEnquiry(v4.id);
  ok('a planned visit made into an enquiry has been visited', made4.visit.status === 'Visited');

  console.log('\nLAST WEEK’S PLAN');
  const old = (id, who, d, extra) => db.appendRow('SalesVisits', Object.assign({ id, engineerEmail: who.email, visitDate: d, customerName: 'Co ' + id,
    area: 'Kamptee', purpose: 'Payment follow-up', status: 'Visited', active: 'TRUE', createdBy: who.email }, extra || {}));
  await old('W1', ROHAN, rohan.addDays_(monday, -7));
  await old('W2', ROHAN, rohan.addDays_(monday, -5));
  await old('W3', RAVI, rohan.addDays_(monday, -6));
  ok('a week to copy into', await refused(() => rohan.copyLastWeekVisits({}), /which week/));
  let c = await rohan.copyLastWeekVisits({ weekStart: monday, engineer: RAVI.email });
  ok('an engineer copies their own week forward', c.copied === 2 && c.skipped === 0, c);
  const copies = (await db.q("SELECT visit_date, status, area, purpose FROM sales_visits WHERE tenant_id=$1 AND customer_name='Co W1' ORDER BY visit_date", [TENANT])).rows;
  ok('a week later, planned, same area and purpose', copies.length === 2 && String(copies[1].visit_date).slice(0, 10) === monday && copies[1].status === 'Planned' &&
    copies[1].area === 'Kamptee' && copies[1].purpose === 'Payment follow-up', copies);
  c = await rohan.copyLastWeekVisits({ weekStart: monday });
  ok('not twice', c.copied === 0 && c.skipped === 2);
  c = await neha.copyLastWeekVisits({ weekStart: monday });
  ok('a coordinator copies everybody’s', c.copied === 1 && c.skipped === 2);
  ok('nothing last week, nothing to copy', await refused(() => rohan.copyLastWeekVisits({ weekStart: day(70) }), /Nothing was planned last week/));

  console.log('\nTHE AREAS');
  ok('Management sets them', await refused(() => rohan.saveVisitAreas([{ name: 'Pune', type: 'Local' }]), /.+/));
  ok('each Local or Outstation, named once', await refused(() => mona.saveVisitAreas([{ name: 'Pune', type: 'Far' }]), /Local or Outstation/) &&
    await refused(() => mona.saveVisitAreas([{ name: 'Pune', type: 'Local' }, { name: 'pune', type: 'Local' }]), /twice/) &&
    await refused(() => mona.saveVisitAreas([]), /at least one/));
  let areas = await mona.saveVisitAreas([{ name: 'Pune', type: 'Local' }, { name: 'Nashik', type: 'Outstation' }]);
  ok('PIE’s own list replaces ERP 2’s', areas.map((a) => a.name + ':' + a.type).join() === 'Pune:Local,Nashik:Outstation');
  areas = await mona.saveVisitAreas([{ name: 'Pune', type: 'Local' }]);
  ok('an area taken off leaves the list', areas.length === 1 && (await neha.getVisitPlans(range)).areas.length === 1);
  ok('and a visit to it reads as Outstation, as in ERP 2', (await neha.getVisitPlans(range)).visits.find((v) => v.id === v1.id).areaType === 'Outstation');

  console.log('\nTAKEN OFF THE PLAN');
  await rohan.deleteVisit(v2.id);
  ok('it leaves the plan but stays on record', !(await rohan.getVisitPlans(range)).visits.some((v) => v.id === v2.id) &&
    (await db.q('SELECT active FROM sales_visits WHERE tenant_id=$1 AND id=$2', [TENANT, v2.id])).rows[0].active === false);
  ok('only one’s own', await refused(() => rohan.deleteVisit(v3.id), /no longer there/));

  console.log('\nON THE DASHBOARD');
  const tile = (d) => d.tiles.find((t) => t.key === 'visits');
  const rd = tile(await rohan.getPersonDashboard({}));
  ok('the engineer’s week, visited of planned', rd && rd.label === 'Visits this week' && /^\d+ of \d+$/.test(rd.value) && /planned today · \d+ enquir/.test(rd.sub) &&
    rd.go === 'visits', rd);
  const md = tile(await mona.getPersonDashboard({}));
  ok('Management, the team’s', md && md.label === 'Team visits this week' && /^\d+ of \d+$/.test(md.value), md);

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
