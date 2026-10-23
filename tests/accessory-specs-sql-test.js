/**
 * Compressor offers: the accessories' specification tables, and the scope of supply chosen by
 * series. Both off PIE's own EG 26 offer, which the website's version of it got wrong:
 *
 *   - the dryer, filters and receiver sold with the machine each had a table on PIE's offer
 *     and none on ours, because a part had nowhere to keep one;
 *   - every offer printed the EQ's scope of supply, an EG included — a different controller,
 *     no discharge moisture separator, the wrong options.
 *
 * Models and parts here are invented, like every other test's; the real ELGi figures stay in
 * imports/, out of the repository.
 *
 *   DATABASE_URL=postgres://... node tests/accessory-specs-sql-test.js
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
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

const TENANT = 'accessory-test';
const BOSS = { email: 'boss@pie.in', name: 'Anil Shah', role: 'ERP Admin' };
const TABLES = ['users', 'customers', 'customer_addresses', 'products', 'spares', 'price_list',
  'quotations', 'quotation_items', 'quote_templates', 'audit_log'];

/** The table printed under a heading: from the heading to the end of its table. */
const tableAfter = (html, title) => {
  const at = html.indexOf('<div class="spec-title">' + title + '</div>');
  if (at === -1) return '';
  return html.slice(at, html.indexOf('</table>', at));
};
/** From a scope heading to the start of the next top-level heading. */
const scopeAfter = (html, heading) => {
  const at = html.indexOf('<div class="h1">' + heading + '</div>');
  if (at === -1) return '';
  const next = html.indexOf('<div class="h1">', at + 10);
  return html.slice(at, next === -1 ? undefined : next);
};

// Only the spec columns and the codes, descriptions left blank — the shape of the file PIE
// loads, which must fill in the tables without touching anything else on the parts.
const SPEC_CSV = '﻿' + [
  'partNo,description,specTitle,specModel,specCapacity,specMaxPressure,specWorkingPressure,specDimensions,specWeight',
  'TST-DRY,,TX Air Dryer 300,TXD 0300 A2,300 cfm,16 bar,7 bar,600 x 450 x 1500 mm,110 kg',
  'TST-RCV,,Air Receiver 900L,TXR 900L 7,900 L,,7 bar,,280 kg',
  'TST-FLT,,TX Pre Filter 0150,"TXF 0150-1 1/4"" BSP",150 cfm,20 bar,7 bar,,4.5 kg',
  'TST-NOWHERE,,Not in the catalogue,X,1 cfm,,,,'
].join('\r\n') + '\r\n';

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  await db.appendRow('Users', { id: 'U-1', email: BOSS.email, name: BOSS.name, role: BOSS.role, active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Test Customer', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', addressType: 'Billing',
    line1: 'Plot 1', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: 'TRUE' });

  const machine = (id, code, model, series) => db.appendRow('Products', {
    id, productCode: code, model, series, family: 'Lubricated screw', gstPct: 18,
    hsnCode: '84148011', capacityCfm: '150 cfm', maxPressure: '7.5 bar', workingPressure: '7 bar',
    motorKw: '22 kW, 30 hp', starterType: 'Automatic star delta', dimensionsMm: '1500 x 800 x 1300 mm',
    weightKg: '700 kg', active: 'TRUE' });
  await machine('PR-EG', 'EG-TEST-7.5', 'EG 26-7.5 DM', 'EG');
  await machine('PR-EQ', 'EQ-TEST-7.5', 'EQ 22-7.5 DM', 'EQ');
  // No series on file: the model says what it is.
  await machine('PR-EN', 'EN-TEST-8', 'EN11-8', '');

  const part = (id, partNo, description) => db.appendRow('Spares', {
    id, partNo, description, productGroup: 'Dryer /OWS /HRS/Tank', uom: 'Nos', gstPct: 18,
    hsnCode: '84193900', active: 'TRUE' });
  await part('SP-DRY', 'TST-DRY', 'TXD 0300N A2');
  await part('SP-RCV', 'TST-RCV', 'TXR 900L-7.0');
  await part('SP-FLT', 'TST-FLT', 'TXF 0150P-1 1/4" BSP');
  await part('SP-HOSE', 'TST-HOSE', 'Drain hose 1/2"');

  const p = loadPortal(db, BOSS.email, { quiet: true });
  p.CURRENT_USER_ = BOSS;
  await p.installMissingQuoteTemplates_('test');

  console.log('THE SPECIFICATIONS LOAD FROM A FILE THAT CARRIES ONLY THEM');
  const pre = await p.previewCatalogImport('Spare', SPEC_CSV);
  ok('three parts updated, none created', pre.updateCount === 3 && pre.newCount === 0, pre);
  ok('the code not in the catalogue is skipped — a new part still needs a description',
    pre.skippedCount === 1, pre);
  await p.commitCatalogImport('Spare', SPEC_CSV);
  const spares = (await db.q('SELECT * FROM spares WHERE tenant_id = $1', [TENANT])).rows;
  const dry = spares.find((s) => s.id === 'SP-DRY');
  ok('the dryer has its table', dry.spec_title === 'TX Air Dryer 300' && dry.spec_capacity === '300 cfm' &&
    dry.spec_dimensions === '600 x 450 x 1500 mm', dry);
  ok('its description is as it was', dry.description === 'TXD 0300N A2', dry.description);
  ok('and so are its group and HSN code', dry.product_group === 'Dryer /OWS /HRS/Tank' &&
    dry.hsn_code === '84193900', dry);
  ok('the filter’s inch mark survives', spares.find((s) => s.id === 'SP-FLT').spec_model ===
    'TXF 0150-1 1/4" BSP');
  ok('nothing was created for the unknown code', !spares.some((s) => s.part_no === 'TST-NOWHERE'));

  console.log('\nTHE CATALOGUE SCREEN GETS THEM, AND ONLY WHERE THERE ARE ANY');
  const listed = await p.listSpares();
  const lDry = listed.find((s) => s.id === 'SP-DRY');
  const lHose = listed.find((s) => s.id === 'SP-HOSE');
  ok('the dryer carries its fields', lDry.specTitle === 'TX Air Dryer 300' && lDry.specWeight === '110 kg', lDry);
  ok('the hose carries none at all', !Object.keys(lHose).some((k) => /^spec/.test(k)), lHose);

  console.log('\nSAVING A PART FROM SOMEWHERE THAT DOES NOT SEND THEM KEEPS THEM');
  await p.saveSpare({ id: 'SP-DRY', partNo: 'TST-DRY', description: 'TXD 0300N A2', uom: 'Nos' });
  let row = (await db.q("SELECT spec_title, spec_weight FROM spares WHERE tenant_id = $1 AND id = 'SP-DRY'", [TENANT])).rows[0];
  ok('the table is still there', row.spec_title === 'TX Air Dryer 300' && row.spec_weight === '110 kg', row);
  await p.saveSpare({ id: 'SP-HOSE', partNo: 'TST-HOSE', description: 'Drain hose 1/2"', uom: 'Nos',
    specTitle: 'Drain hose', specModel: '', specWeight: ' 0.2 kg ' });
  row = (await db.q("SELECT spec_title, spec_weight FROM spares WHERE tenant_id = $1 AND id = 'SP-HOSE'", [TENANT])).rows[0];
  ok('and the part form can set them', row.spec_title === 'Drain hose' && row.spec_weight === '0.2 kg', row);
  await p.saveSpare({ id: 'SP-HOSE', partNo: 'TST-HOSE', description: 'Drain hose 1/2"', uom: 'Nos',
    specTitle: '', specModel: '', specCapacity: '', specMaxPressure: '', specWorkingPressure: '',
    specDimensions: '', specWeight: '' });
  row = (await db.q("SELECT spec_title, spec_weight FROM spares WHERE tenant_id = $1 AND id = 'SP-HOSE'", [TENANT])).rows[0];
  ok('or clear them', !row.spec_title && !row.spec_weight, row);

  const offer = async (lines, stream) => {
    const q = await p.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales' });
    for (const [itemType, itemId] of lines) await p.saveQuotationItem({ quotationId: q.id, itemType, itemId, qty: 1 });
    // A spares offer starts from an enquiry on the website; the stream is all this needs.
    if (stream) {
      await db.q('UPDATE quotations SET business_stream = $3 WHERE tenant_id = $1 AND id = $2',
        [TENANT, q.id, stream]);
    }
    return p.buildQuotationHtml(q.id);
  };

  console.log('\nAN EG OFFER WITH ITS ACCESSORIES');
  let html = await offer([['Product', 'PR-EG'], ['Spare', 'SP-RCV'], ['Spare', 'SP-DRY'],
    ['Spare', 'SP-FLT'], ['Spare', 'SP-HOSE']]);
  const dryer = tableAfter(html, 'TX Air Dryer 300');
  ok('the dryer prints its table', dryer !== '', html.slice(0, 200));
  for (const v of ['TXD 0300 A2', '300 cfm', '16 bar', '7 bar', '600 x 450 x 1500 mm', '110 kg']) {
    ok('  with ' + v, dryer.indexOf(v) !== -1);
  }
  const receiver = tableAfter(html, 'Air Receiver 900L');
  ok('the receiver prints its table', receiver.indexOf('900 L') !== -1 && receiver.indexOf('280 kg') !== -1, receiver);
  ok('without the rows it has no figure for — no maximum pressure, no dimensions',
    receiver.indexOf('Maximum pressure') === -1 && receiver.indexOf('Dimensions') === -1 &&
    receiver.indexOf('spec-blank') === -1, receiver);
  ok('the filter prints its table, inch mark escaped',
    tableAfter(html, 'TX Pre Filter 0150').indexOf('TXF 0150-1 1/4&quot; BSP') !== -1);
  ok('the hose, with no table on file, prints none', html.indexOf('Drain hose 1/2') === -1 ||
    html.indexOf('<div class="spec-title">Drain hose') === -1);
  const order = ['EG 26-7.5 DM', 'Air Receiver 900L', 'TX Air Dryer 300', 'TX Pre Filter 0150']
    .map((t) => html.indexOf('<div class="spec-title">' + t + '</div>'));
  ok('in the order the lines are on the offer, the machine first',
    order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1])), order);
  ok('the machine’s own table still keeps every row', tableAfter(html, 'EG 26-7.5 DM')
    .indexOf('Main motor nominal rating') !== -1);

  console.log('\nTHE EG GETS THE EG’S SCOPE OF SUPPLY');
  let scope = scopeAfter(html, 'Scope of supply');
  ok('one scope, headed plainly', scope !== '' && html.indexOf('Scope of supply —') === -1);
  ok('with the Neuron IV controller', scope.indexOf('Neuron IV controller') !== -1);
  ok('the discharge moisture separator', scope.indexOf('Discharge System:') !== -1);
  ok('Air Alert above EG 18', scope.indexOf('In-built Air~Alert (above EG 18):') !== -1);
  ok('and the EG’s options', scope.indexOf('Integrated VFD, heat recovery system') !== -1);
  ok('not the EQ’s controller', scope.indexOf('Neuron XT controller') === -1);
  ok('nor its capacity-control line', scope.indexOf('EQ 11 to EQ 45') === -1);

  console.log('\nAN EQ STILL GETS THE ONE IT HAD');
  html = await offer([['Product', 'PR-EQ']]);
  scope = scopeAfter(html, 'Scope of supply');
  ok('the XT controller', scope.indexOf('Neuron XT controller') !== -1, scope.slice(0, 200));
  ok('and nothing of the EG’s', scope.indexOf('Neuron IV controller') === -1 && scope.indexOf('EG 55') === -1);

  console.log('\nA SERIES WITH NO TEXT OF ITS OWN, AND NO SERIES ON FILE');
  html = await offer([['Product', 'PR-EN']]);
  scope = scopeAfter(html, 'Scope of supply');
  ok('gets the general text, not the EG’s', scope.indexOf('Neuron XT controller') !== -1 &&
    scope.indexOf('Neuron IV controller') === -1, scope.slice(0, 200));

  console.log('\nAN OFFER FOR BOTH SERIES PRINTS BOTH, EACH NAMED');
  html = await offer([['Product', 'PR-EG'], ['Product', 'PR-EQ']]);
  const eg = scopeAfter(html, 'Scope of supply — EG series');
  const eq = scopeAfter(html, 'Scope of supply — EQ series');
  ok('the EG’s', eg.indexOf('Neuron IV controller') !== -1, html.indexOf('EG series'));
  ok('and the EQ’s', eq.indexOf('Neuron XT controller') !== -1, html.indexOf('EQ series'));
  ok('in line order', html.indexOf('EG series') < html.indexOf('EQ series'));
  html = await offer([['Product', 'PR-EQ'], ['Product', 'PR-EN']]);
  ok('two series that come to the same text print it once, headed plainly',
    scopeAfter(html, 'Scope of supply').indexOf('Neuron XT controller') !== -1 &&
    html.split('Neuron XT controller').length === 2 && html.indexOf('Scope of supply —') === -1,
    html.indexOf('series'));

  console.log('\nA SPARES OFFER FOR THE SAME DRYER');
  html = await offer([['Spare', 'SP-DRY']], 'Spare Sales');
  ok('prints no specification table', html.indexOf('TX Air Dryer 300') === -1);
  ok('and no compressor scope of supply', html.indexOf('Neuron IV controller') === -1 &&
    html.indexOf('Neuron XT controller') === -1);

  console.log('\nTHE SERIES SURVIVES AN EDIT OF THE TEXT');
  const tpl = (await p.listQuoteTemplates({ includeInactive: true })).find((t) => t.id === 'QTPL-COMP-SCOPE-EG');
  ok('the EG scope ships for the EG', tpl && tpl.appliesTo === 'EG', tpl && tpl.appliesTo);
  // A page still open from before the field existed sends no appliesTo at all.
  await p.saveQuoteTemplate({ id: tpl.id, section: tpl.section, businessStream: tpl.businessStream,
    sortOrder: 2, title: tpl.title, body: tpl.body + '\nTyped by hand', active: true });
  let after = (await p.listQuoteTemplates({ includeInactive: true })).find((t) => t.id === tpl.id);
  ok('an edit that does not mention the series keeps it', after.appliesTo === 'EG', after.appliesTo);
  await p.saveQuoteTemplate({ id: tpl.id, section: tpl.section, businessStream: tpl.businessStream,
    sortOrder: 2, title: tpl.title, body: tpl.body, appliesTo: 'eg, en', active: true });
  after = (await p.listQuoteTemplates({ includeInactive: true })).find((t) => t.id === tpl.id);
  ok('one that does sets it, in capitals', after.appliesTo === 'EG, EN', after.appliesTo);
  html = await offer([['Product', 'PR-EN']]);
  ok('and the EN now gets that text', scopeAfter(html, 'Scope of supply').indexOf('Neuron IV controller') !== -1);
  const added = await p.saveQuoteTemplate({ section: 'WhyBrand', businessStream: 'Compressor Sales',
    title: 'Why the EQ?', body: 'Because', active: true });
  ok('a new section with no series is for every series',
    added.find((t) => t.title === 'Why the EQ?').appliesTo === '');

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
