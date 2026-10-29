/**
 * ERP 2.0's form builder, on the server: Management adds fields to a form (text, number, date,
 * dropdown, long text, yes / no), each can be required and a list column; a field keeps its key
 * when renamed or moved, and taking one off keeps its values. A record's values are checked
 * against their types, a required one left empty is refused, and who sees and fills them follows
 * the record.
 *
 * Customers and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/form-fields-sql-test.js
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

const TENANT = 'form-fields-test';
const ANIL = { email: 'anil@pie.in', name: 'Anil', role: 'Management', businessStream: 'All' };
const NEHA = { email: 'neha@pie.in', name: 'Neha', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const ROHAN = { email: 'rohan@pie.in', name: 'Rohan', role: 'Sales Engineer', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const TABLES = ['users', 'customers', 'spare_enquiries', 'leads', 'service_jobs', 'tasks', 'sales_visits', 'form_fields', 'form_field_values',
  'config_lists', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [ANIL, NEHA, ROHAN, TEJ]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  await db.appendRow('SpareEnquiries', { id: 'E1', enquiryNo: 'SE/1', date: '2026-10-20', customerId: 'CU-1', status: 'New', ownerEmail: NEHA.email, businessStream: 'Spare Sales' });
  await db.appendRow('Leads', { id: 'L1', leadNo: 'LD/1', customerName: 'Brightline Mills', status: 'New', businessStream: 'Compressor Sales' });
  await db.appendRow('ServiceJobs', { id: 'J1', jobNo: 'SJ/1', customerId: 'CU-1', jobType: 'Breakdown', status: 'Open' });
  await db.appendRow('Tasks', { id: 'T1', title: 'Call back', assigneeEmail: ROHAN.email, createdBy: NEHA.email, dueDate: '2026-11-02', priority: 'Normal', status: 'Open' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const anil = as(ANIL);
  const neha = as(NEHA);
  const rohan = as(ROHAN);
  const tej = as(TEJ);

  console.log('THE FORMS AND THE TYPES');
  let d = await anil.getFormFields();
  ok('seven forms, six types, none with fields yet', d.forms.length === 7 && d.types.join() === 'text,number,date,select,textarea,checkbox' &&
    Object.keys(d.fields).every((k) => d.fields[k].length === 0), d);
  ok('Management may change them', d.canEdit === true && (await neha.getFormFields()).canEdit === false);
  ok('nobody else may', await refused(() => neha.saveFormFields('enquiry', [{ label: 'Plant', type: 'text' }]), /permission/));
  ok('only the forms there are', await refused(() => anil.saveFormFields('payroll', []), /no form called that/));

  console.log('\nADDING FIELDS');
  let f = await anil.saveFormFields('enquiry', [
    { label: 'Warranty ends', type: 'date', inList: true },
    { label: 'Plant shift', type: 'select', options: 'Day, Night, Both', required: true },
    { label: 'Running hours', type: 'number' },
    { label: 'Site notes', type: 'textarea' },
    { label: 'Under AMC', type: 'checkbox', inList: true }
  ]);
  ok('in the order given, with keys from their names', f.map((x) => x.key).join() === 'warranty_ends,plant_shift,running_hours,site_notes,under_amc', f);
  ok('a dropdown keeps its choices, the ticks theirs', f[1].options.join() === 'Day,Night,Both' && f[1].required === true && f[0].inList === true && f[2].inList === false);
  ok('a label is needed', await refused(() => anil.saveFormFields('lead', [{ label: ' ', type: 'text' }]), /needs a label/));
  ok('once on a form', await refused(() => anil.saveFormFields('lead', [{ label: 'Plant', type: 'text' }, { label: 'plant', type: 'number' }]), /on the form twice/));
  ok('a dropdown needs its choices', await refused(() => anil.saveFormFields('lead', [{ label: 'Plant', type: 'select', options: '' }]), /choices for its dropdown/));
  ok('only the six types', await refused(() => anil.saveFormFields('lead', [{ label: 'Plant', type: 'file' }]), /text, a number/));
  ok('other forms are untouched', (await anil.getFormFields()).fields.lead.length === 0);

  console.log('\nA RECORD’S VALUES');
  ok('a required one left empty is refused', await refused(() => neha.saveCustomValues('enquiry', 'E1', { warranty_ends: '2027-03-31' }), /Fill in: Plant shift\./));
  ok('a number is a number', await refused(() => neha.saveCustomValues('enquiry', 'E1', { plant_shift: 'Day', running_hours: 'lots' }), /“Running hours” is a number/));
  ok('a date is a date', await refused(() => neha.saveCustomValues('enquiry', 'E1', { plant_shift: 'Day', warranty_ends: '31/03/2027' }), /is a date/));
  ok('a dropdown from its list', await refused(() => neha.saveCustomValues('enquiry', 'E1', { plant_shift: 'Evening' }), /Pick “Plant shift” from its list/));
  let v = await neha.saveCustomValues('enquiry', 'E1', { warranty_ends: '2027-03-31', plant_shift: 'Night', running_hours: '12500', under_amc: true, nope: 'x' });
  ok('saved, a tick as TRUE, fields not on the form ignored', v.warranty_ends === '2027-03-31' && v.plant_shift === 'Night' && v.running_hours === '12500' &&
    v.under_amc === 'TRUE' && v.nope === undefined && v.site_notes === undefined, v);
  ok('kept apart from the enquiry itself', Object.keys((await db.q('SELECT * FROM spare_enquiries WHERE tenant_id=$1 AND id=$2', [TENANT, 'E1'])).rows[0])
    .every((c) => !/warranty|plant_shift/.test(c)));
  const audits = async () => Number((await db.q("SELECT count(*) FROM audit_log WHERE tenant_id=$1 AND reason LIKE 'Custom field%'", [TENANT])).rows[0].count);
  const before = await audits();
  await neha.saveCustomValues('enquiry', 'E1', { warranty_ends: '2027-03-31', plant_shift: 'Night', running_hours: '12500', under_amc: 'TRUE' });
  ok('saving the same again writes nothing', (await audits()) === before, [before, await audits()]);
  v = await neha.saveCustomValues('enquiry', 'E1', { warranty_ends: '', plant_shift: 'Day', running_hours: '12500', under_amc: false });
  ok('a value can be cleared', v.warranty_ends === '' && v.under_amc === '' && v.plant_shift === 'Day', v);
  const got = await neha.getCustomValues('enquiry', ['E1', 'E-nothing']);
  ok('read back by record', got.E1.plant_shift === 'Day' && got['E-nothing'] === undefined, got);
  ok('a record no longer there', await refused(() => neha.saveCustomValues('enquiry', 'E-gone', {}), /no longer there/));

  console.log('\nCHANGING THE FORM');
  d = await anil.getFormFields();
  f = d.fields.enquiry;
  const shift = f.find((x) => x.key === 'plant_shift');
  f = await anil.saveFormFields('enquiry', [
    Object.assign({}, shift, { label: 'Shift', options: ['Day', 'Night'] }),
    f.find((x) => x.key === 'warranty_ends'),
    f.find((x) => x.key === 'running_hours')
  ]);
  ok('renamed and moved, a field keeps its key', f.map((x) => x.key).join() === 'plant_shift,warranty_ends,running_hours' && f[0].label === 'Shift', f);
  ok('the ones left out are off the form', !f.some((x) => x.key === 'site_notes' || x.key === 'under_amc'));
  ok('their rows stay, marked off', (await db.q("SELECT active FROM form_fields WHERE tenant_id=$1 AND field_key='under_amc'", [TENANT])).rows[0].active === false);
  await db.q("UPDATE form_field_values SET value='Both' WHERE tenant_id=$1 AND field_key='plant_shift'", [TENANT]);
  v = await neha.saveCustomValues('enquiry', 'E1', { plant_shift: 'Both', running_hours: '13000' });
  ok('a choice since taken off the list stays where it was', v.plant_shift === 'Both' && v.running_hours === '13000', v);
  ok('but cannot be picked afresh', await refused(() => neha.saveCustomValues('enquiry', 'E1', { plant_shift: 'Both', running_hours: '13000', warranty_ends: 'soon' }), /is a date/) &&
    (await neha.getCustomValues('enquiry', ['E1'])).E1.warranty_ends === '');
  await neha.saveCustomValues('enquiry', 'E1', { plant_shift: 'Day' });
  ok('and a new pick is checked', await refused(() => neha.saveCustomValues('enquiry', 'E1', { plant_shift: 'Both' }), /from its list/));
  await db.q("UPDATE form_field_values SET value='TRUE' WHERE tenant_id=$1 AND field_key='under_amc'", [TENANT]);
  f = await anil.saveFormFields('enquiry', f.concat([{ label: 'under amc', type: 'checkbox' }]));
  ok('added back under its name, it is the same field', f[3].key === 'under_amc' && (await neha.getCustomValues('enquiry', ['E1'])).E1.under_amc === 'TRUE', f);
  f = await anil.saveFormFields('enquiry', f.concat([{ label: 'Warranty ends 2', type: 'text' }, { label: 'Warranty-ends', type: 'text' }]));
  ok('a new name that slugs the same gets its own key', f[4].key === 'warranty_ends_2' && f[5].key === 'warranty_ends_3', f.map((x) => x.key));

  console.log('\nWHO SEES AND FILLS THEM');
  ok('service does not see an enquiry’s', JSON.stringify(await tej.getCustomValues('enquiry', ['E1'])) === '{}');
  ok('nor fills them', await refused(() => tej.saveCustomValues('enquiry', 'E1', { plant_shift: 'Day' }), /cannot change this record/));
  await anil.saveFormFields('lead', [{ label: 'Plant', type: 'text' }]);
  await rohan.saveCustomValues('lead', 'L1', { plant: 'Unit 2' });
  ok('the spares desk does not see a compressor lead’s', JSON.stringify(await neha.getCustomValues('lead', ['L1'])) === '{}' &&
    (await rohan.getCustomValues('lead', ['L1'])).L1.plant === 'Unit 2');
  await anil.saveFormFields('service', [{ label: 'Gate pass', type: 'text', required: true }]);
  v = await tej.saveCustomValues('service', 'J1', { 'gate_pass': 'GP-44' });
  ok('a service engineer fills a job’s', v.gate_pass === 'GP-44' && (await tej.getCustomValues('service', ['J1'])).J1.gate_pass === 'GP-44');
  await anil.saveFormFields('task', [{ label: 'Outcome', type: 'textarea' }]);
  await rohan.saveCustomValues('task', 'T1', { outcome: 'Called, will send PO' });
  ok('a task’s: whoever it was given to', (await rohan.getCustomValues('task', ['T1'])).T1.outcome === 'Called, will send PO');
  ok('and whoever gave it', (await neha.getCustomValues('task', ['T1'])).T1.outcome === 'Called, will send PO');
  ok('but not somebody else', JSON.stringify(await tej.getCustomValues('task', ['T1'])) === '{}' &&
    await refused(() => tej.saveCustomValues('task', 'T1', { outcome: 'x' }), /cannot change this record/));

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
