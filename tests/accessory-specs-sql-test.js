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
const TABLES = ['users', 'customers', 'customer_addresses', 'customer_contacts', 'products', 'spares',
  'price_list', 'quotations', 'quotation_items', 'quote_templates', 'company_profile', 'audit_log'];

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

  const machine = (id, code, model, series, family) => db.appendRow('Products', {
    id, productCode: code, model, series, family: family || 'Lubricated screw', gstPct: 18,
    hsnCode: '84148011', capacityCfm: '150 cfm', maxPressure: '7.5 bar', workingPressure: '7 bar',
    motorKw: '22 kW, 30 hp', starterType: 'Automatic star delta', dimensionsMm: '1500 x 800 x 1300 mm',
    weightKg: '700 kg', active: 'TRUE' });
  await machine('PR-EG', 'EG-TEST-7.5', 'EG 26-7.5 DM', 'EG');
  await machine('PR-EQ', 'EQ-TEST-7.5', 'EQ 22-7.5 DM', 'EQ');
  // No series on file: the model says what it is.
  await machine('PR-EN', 'EN-TEST-8', 'EN11-8', '');
  // The rare series, with no scope of supply written yet.
  await machine('PR-EL', 'EL-TEST-8', 'EL 5-8', 'EL');
  // The other kinds of machine PIE sells, by family.
  await machine('PR-RECIP', 'TS-TEST', 'TS 05', '', 'Reciprocating');
  await machine('PR-DRYER', 'AD-TEST', 'AD 100', '', 'Air Dryer');

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

  console.log('THE RIGHT FILE ON THE WRONG TAB SAYS WHICH TAB');
  let wrongTab = '';
  try { await p.previewCatalogImport('Product', SPEC_CSV); } catch (e) { wrongTab = e.message; }
  ok('a spares file on the compressor tab is told to use the Spares tab',
    /spares file/.test(wrongTab) && /Open the Spares tab/.test(wrongTab), wrongTab);
  wrongTab = '';
  try {
    await p.previewCatalogImport('Spare', 'productCode,model,description\nX-1,X 1,Test\n');
  } catch (e) { wrongTab = e.message; }
  ok('and the other way round', /compressor file/.test(wrongTab) &&
    /Products \(Compressors\) tab/.test(wrongTab), wrongTab);

  console.log('\nTHE SPECIFICATIONS LOAD FROM A FILE THAT CARRIES ONLY THEM');
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
    lastQuoteId = q.id;
    return p.buildQuotationHtml(q.id);
  };
  let lastQuoteId = null;

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

  console.log('\nTHE EN SHARES THE EQ’S, EVEN WITH NO SERIES ON FILE');
  html = await offer([['Product', 'PR-EN']]);
  scope = scopeAfter(html, 'Scope of supply');
  ok('the EQ’s text, not the EG’s', scope.indexOf('Neuron XT controller') !== -1 &&
    scope.indexOf('Neuron IV controller') === -1, scope.slice(0, 200));

  console.log('\nTHE EL HAS NONE YET, SO PRINTS NONE');
  html = await offer([['Product', 'PR-EL']]);
  ok('no scope of supply at all', html.indexOf('<div class="h1">Scope of supply') === -1 &&
    html.indexOf('Neuron') === -1);
  ok('and the enclosures do not promise one', /<li>Technical specifications<\/li>/.test(html) &&
    html.indexOf('Technical specifications and scope of supply') === -1);
  html = await offer([['Product', 'PR-EG'], ['Product', 'PR-EL']]);
  ok('beside an EG, only the EG’s prints — named, so it does not read as the EL’s too',
    scopeAfter(html, 'Scope of supply \u2014 EG series').indexOf('Neuron IV controller') !== -1 &&
    html.split('<div class="h1">Scope of supply').length === 2, html.indexOf('series'));

  console.log('\nAN OFFER FOR BOTH SERIES PRINTS BOTH, EACH NAMED');
  html = await offer([['Product', 'PR-EG'], ['Product', 'PR-EQ']]);
  const eg = scopeAfter(html, 'Scope of supply — EG series');
  const eq = scopeAfter(html, 'Scope of supply — EQ series');
  ok('the EG’s', eg.indexOf('Neuron IV controller') !== -1, html.indexOf('EG series'));
  ok('and the EQ’s', eq.indexOf('Neuron XT controller') !== -1, html.indexOf('EQ series'));
  ok('in line order', html.indexOf('EG series') < html.indexOf('EQ series'));
  html = await offer([['Product', 'PR-EQ'], ['Product', 'PR-EN']]);
  ok('the EQ and EN on one offer: their shared text once, naming both',
    scopeAfter(html, 'Scope of supply \u2014 EQ, EN series').indexOf('Neuron XT controller') !== -1 &&
    html.split('Neuron XT controller').length === 2, html.indexOf('series'));

  console.log('\nA SPARES OFFER FOR THE SAME DRYER');
  html = await offer([['Spare', 'SP-DRY']], 'Spare Sales');
  ok('prints no specification table', html.indexOf('TX Air Dryer 300') === -1);
  ok('and no compressor scope of supply', html.indexOf('Neuron IV controller') === -1 &&
    html.indexOf('Neuron XT controller') === -1);

  console.log('\nTHE COMPRESSOR PRICE SCHEDULE READS LIKE PIE’S OWN');
  const price = (id, itemType, itemId, amount) => db.appendRow('PriceList', { id, itemType, itemId,
    priceLevel: 'ELGI', price: amount, effectiveFrom: '2026-01-01', active: 'TRUE', currency: 'INR' });
  await price('PRC-EG', 'Product', 'PR-EG', 1508000);
  await price('PRC-RCV', 'Spare', 'SP-RCV', 128100);
  await price('PRC-DRY', 'Spare', 'SP-DRY', 332000);
  await price('PRC-FLT', 'Spare', 'SP-FLT', 27800);
  await price('PRC-HOSE', 'Spare', 'SP-HOSE', 500);
  const schedule = (doc) => {
    const at = doc.indexOf('<table class="price pie">');
    return at === -1 ? '' : doc.slice(at, doc.indexOf('</table>', at));
  };
  const cells = (row) => (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || [])
    .map((c) => c.replace(/<[^>]+>/g, '').replace(/\u00A0/g, ' ').trim());
  const rows = (tbl) => (tbl.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []);
  const rowWith = (tbl, text) => rows(tbl).find((r) => cells(r)[0] === text);
  await offer([['Product', 'PR-EG'], ['Spare', 'SP-RCV'], ['Spare', 'SP-DRY'], ['Spare', 'SP-FLT'],
    ['Spare', 'SP-HOSE']]);
  await p.saveQuotationHeader({ id: lastQuoteId, packageDiscountPct: 40, pfAmount: 0, taxMode: 'Extra' });
  html = await p.buildQuotationHtml(lastQuoteId);
  let tbl = schedule(html);
  ok('it is PIE’s grid', tbl !== '', html.indexOf('table class="price'));
  ok('columns in their order: Description, Basic price, Qty, UNIT, HSN Code, Tax Rate',
    JSON.stringify(cells(rows(tbl)[0])) ===
    JSON.stringify(['Description', 'Basic price', 'Qty', 'UNIT', 'HSN Code', 'Tax Rate']), cells(rows(tbl)[0]));
  ok('the machine is "ELGi make Compressor" and its model, not the catalogue sentence',
    JSON.stringify(cells(rowWith(tbl, 'ELGi make Compressor EG 26-7.5 DM') || '')) ===
    JSON.stringify(['ELGi make Compressor EG 26-7.5 DM', '₹ 15,08,000.00', '1', 'Nos', '84148011', '18.00%']),
    cells(rows(tbl)[1]));
  ok('an accessory is named by its table’s heading',
    !!rowWith(tbl, 'ELGi make Air Receiver 900L') && !!rowWith(tbl, 'ELGi make TX Air Dryer 300') &&
    !!rowWith(tbl, 'ELGi make TX Pre Filter 0150'), rows(tbl).map((r) => cells(r)[0]));
  ok('a part without one by its description', !!rowWith(tbl, 'ELGi make Drain hose 1/2&quot;'),
    rows(tbl).map((r) => cells(r)[0]));
  ok('Total Package Price, at list', JSON.stringify(cells(rowWith(tbl, 'Total Package Price') || '')) ===
    JSON.stringify(['Total Package Price', '₹ 19,96,400.00']), cells(rowWith(tbl, 'Total Package Price') || ''));
  const disc = rowWith(tbl, 'Discounted Price (40% Less)') || '';
  ok('Discounted Price (40% Less), highlighted', /class="hl"/.test(disc) &&
    cells(disc)[1] === '₹ 11,97,840.00', disc);
  ok('the amounts span the columns after Basic price, as on theirs',
    /colspan="2"[^>]*>Total Package Price/.test(tbl) && /colspan="4">₹\u00A019,96,400\.00/.test(tbl.replace(/ class="num tot-val"/g, '')), tbl.slice(-900));
  ok('P&F @ 0.00', JSON.stringify(cells(rowWith(tbl, 'P&amp;F @') || '')) === JSON.stringify(['P&amp;F @', '0.00']),
    rows(tbl).map((r) => cells(r)[0]));
  ok('Freight — Extra from Ex-works Coimbatore', (cells(rowWith(tbl, 'Freight') || '')[1]) ===
    'Extra from Ex-works Coimbatore');
  ok('18% GST — EXTRA', (cells(rowWith(tbl, '18% GST') || '')[1]) === 'EXTRA');
  ok('and no total after it, as on theirs', !/Total amount/i.test(tbl) && rows(tbl).length === 11,
    rows(tbl).map((r) => cells(r)[0]));

  console.log('\nWITH GST INCLUDED, THE FIGURES COME BACK');
  await p.saveQuotationHeader({ id: lastQuoteId, taxMode: 'Included', pfAmount: 2500 });
  tbl = schedule(await p.buildQuotationHtml(lastQuoteId));
  ok('no EXTRA', tbl.indexOf('EXTRA') === -1);
  ok('the total to raise a purchase order against', !!rowWith(tbl, 'Total amount'), rows(tbl).map((r) => cells(r)[0]));
  ok('and P&F as an amount when there is one', (cells(rowWith(tbl, 'P&amp;F @') || '')[1]) === '₹ 2,500.00');

  console.log('\nTHE DISCOUNT ROW SAYS ONLY WHAT IS TRUE');
  await p.saveQuotationHeader({ id: lastQuoteId, packageDiscountPct: 0, taxMode: 'Extra' });
  tbl = schedule(await p.buildQuotationHtml(lastQuoteId));
  ok('no discount, no discounted row', !/Discounted Price/.test(tbl));
  const line = (await p.getQuotation(lastQuoteId)).items.find((i) => i.itemId === 'SP-HOSE');
  await p.saveQuotationItem({ id: line.id, quotationId: lastQuoteId, lineNo: line.lineNo, itemType: 'Spare',
    itemId: 'SP-HOSE', qty: 1, unitPrice: 500, discountPct: 10 });
  await p.saveQuotationHeader({ id: lastQuoteId, packageDiscountPct: 40 });
  tbl = schedule(await p.buildQuotationHtml(lastQuoteId));
  ok('a line discount as well: the row, without a percentage that would not add up',
    !!rowWith(tbl, 'Discounted Price') && !/% Less/.test(tbl), rows(tbl).map((r) => cells(r)[0]));

  console.log('\nA SPARES OFFER KEEPS ITS OWN SCHEDULE');
  html = await offer([['Spare', 'SP-DRY']], 'Spare Sales');
  ok('not PIE’s compressor grid', html.indexOf('class="price pie"') === -1 && html.indexOf('class="price"') !== -1);
  const spareTbl = html.slice(html.indexOf('<table class="price">'));
  ok('no "ELGi make" names', spareTbl.slice(0, spareTbl.indexOf('</table>')).indexOf('ELGi make') === -1);
  ok('and still its total amount', /Total amount/i.test(html));
  const spareRows = rows(spareTbl.slice(0, spareTbl.indexOf('</table>')));
  ok('Quantity before Price Per, at PIE’s request', JSON.stringify(cells(spareRows[0])) === JSON.stringify(
    ['Part Number', 'Description', 'HSN code', 'Unit of measurement', 'Quantity', 'Price Per', 'Total Amount']),
    cells(spareRows[0]));
  ok('and the figures moved with their headings', JSON.stringify(cells(spareRows[1]).slice(4)) ===
    JSON.stringify(['1', '₹ 3,32,000.00', '₹ 3,32,000.00']), cells(spareRows[1]));

  console.log('\nTHE PICTURE OF THE RANGE OPENS THE SPECIFICATIONS');
  const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
  html = await offer([['Product', 'PR-EG'], ['Spare', 'SP-DRY']]);
  ok('no picture until one is set', html.indexOf('<div class="offer-picture">') === -1);
  const co = await p.getCompanyProfile();
  await p.saveCompanyProfile(Object.assign({}, co, { compressorPictureUrl: PIC }));
  html = await offer([['Product', 'PR-EG'], ['Spare', 'SP-DRY']]);
  const picAt = html.indexOf('<div class="offer-picture"><img src="' + PIC + '" /></div>');
  ok('set once, it prints on a compressor offer', picAt !== -1);
  ok('after the heading and before the first table', picAt > html.indexOf('SCREW AIR COMPRESSOR</div>') &&
    picAt < html.indexOf('<div class="spec-block">'), [picAt, html.indexOf('<div class="spec-block">')]);
  ok('once', html.split('offer-picture"><img').length === 2);
  html = await offer([['Product', 'PR-EQ']]);
  ok('on every series', html.indexOf(PIC) !== -1);
  html = await offer([['Spare', 'SP-DRY']], 'Spare Sales');
  ok('never on a spares offer', html.indexOf(PIC) === -1);
  let tooBig = '';
  try { await p.saveCompanyProfile(Object.assign({}, co, { compressorPictureUrl: 'data:image/jpeg;base64,' + 'A'.repeat(60000) })); }
  catch (e) { tooBig = e.message; }
  ok('a picture too large to store is refused with a reason', /too large to store/.test(tooBig), tooBig);
  await p.saveCompanyProfile(Object.assign({}, co, { compressorPictureUrl: '' }));
  ok('and removing it removes it', (await offer([['Product', 'PR-EG']])).indexOf('<div class="offer-picture">') === -1);

  console.log('\nTHE TITLE SAYS WHAT KIND OF MACHINE IT IS');
  html = await offer([['Product', 'PR-EG']]);
  const h1s = (doc) => (doc.match(/<div class="h1">[^<]*<\/div>/g) || []).map((h) => h.replace(/<[^>]+>/g, ''));
  ok('a screw compressor: the screw title, at the top', /<div class="doc-title">ELGi ELECTRIC POWERED OIL SCREW AIR COMPRESSOR<\/div>/.test(html));
  ok('and heading its specifications, as on PIE’s offer', h1s(html)[0] === 'ELGi ELECTRIC POWERED OIL SCREW AIR COMPRESSOR', h1s(html));
  html = await offer([['Product', 'PR-RECIP']]);
  ok('a reciprocating one: the reciprocating title', /doc-title">ELGi ELECTRIC POWERED OIL RECIPROCATING AIR COMPRESSOR</.test(html) &&
    h1s(html)[0] === 'ELGi ELECTRIC POWERED OIL RECIPROCATING AIR COMPRESSOR', h1s(html));
  html = await offer([['Product', 'PR-DRYER']]);
  ok('a dryer: the dryer title', /doc-title">ELGi ELECTRIC POWERED OIL AIR DRYER</.test(html) &&
    h1s(html)[0] === 'ELGi ELECTRIC POWERED OIL AIR DRYER', h1s(html));
  html = await offer([['Spare', 'SP-DRY']], 'Spare Sales');
  ok('a spares offer keeps its own', /doc-title">ELGi GENUINE SPARE PARTS</.test(html));

  console.log('\nTHE CUSTOMER’S E-MAIL IS ON THE OFFER');
  await db.appendRow('CustomerContacts', { id: 'CC-1', customerId: 'CU-1', name: 'Kunal Shah',
    phone: '7798222271', email: '', isPrimary: 'FALSE', active: 'TRUE' });
  await db.appendRow('CustomerContacts', { id: 'CC-2', customerId: 'CU-1', name: 'Purchase Dept',
    phone: '', email: 'purchase@test-customer.in', isPrimary: 'TRUE', active: 'TRUE' });
  await offer([['Product', 'PR-EG']]);
  await p.saveQuotationHeader({ id: lastQuoteId, contactId: 'CC-1' });
  html = await p.buildQuotationHtml(lastQuoteId);
  ok('addressed to someone with none on file: the customer’s own, from their primary contact',
    /Kind Attention: Kunal Shah[\s\S]*Email Id: purchase@test-customer\.in/.test(html), html.slice(html.indexOf('class="to"'), html.indexOf('class="to"') + 400));
  let qv = await p.getQuotation(lastQuoteId);
  ok('the screen says which address will print, and has nothing to warn about',
    qv.printEmail === 'purchase@test-customer.in' && qv.emailGap === '', [qv.printEmail, qv.emailGap]);
  await db.q("UPDATE customer_contacts SET email = 'kunal@test-customer.in' WHERE tenant_id = $1 AND id = 'CC-1'", [TENANT]);
  html = await p.buildQuotationHtml(lastQuoteId);
  ok('their own address, once they have one', /Email Id: kunal@test-customer\.in/.test(html) &&
    html.indexOf('purchase@test-customer.in') === -1);
  await db.q("UPDATE customer_contacts SET email = '' WHERE tenant_id = $1", [TENANT]);
  html = await p.buildQuotationHtml(lastQuoteId);
  qv = await p.getQuotation(lastQuoteId);
  ok('none anywhere: no empty line on the offer', html.indexOf('Email Id') === -1);
  ok('and the screen says so, and where to add it', /no e-mail address on file/.test(qv.emailGap) &&
    /Customers/.test(qv.emailGap), qv.emailGap);
  await db.q("DELETE FROM customer_contacts WHERE tenant_id = $1", [TENANT]);

  console.log('\nTHE NUMBER SAYS WHICH KIND OF OFFER IT IS');
  const fy = await p.indianFinancialYear_();
  const unitNo = (await p.getQuotation(lastQuoteId)).quoteNo;
  ok('a compressor offer starts UNIT/', new RegExp('^UNIT/PIE/ELGI/QUOT/' + fy + '/\\d+$').test(unitNo), unitNo);
  await db.appendRow('Quotations', { id: 'QT-OLD', quoteNo: 'PIE/ELGI/QUOT/' + fy + '/900', revision: 'R0',
    businessStream: 'Spare Sales', customerId: 'CU-1', status: 'Draft', date: '2026-10-01' });
  await offer([['Product', 'PR-EQ']]);
  const after900 = (await p.getQuotation(lastQuoteId)).quoteNo;
  ok('the serial runs on from numbers written before the word was added',
    after900 === 'UNIT/PIE/ELGI/QUOT/' + fy + '/901', after900);
  const nextSpare = await p.nextQuoteNo_('ELGI', 'Spare Sales');
  ok('a spares offer starts SPARE/, on the same serial', nextSpare === 'SPARE/PIE/ELGI/QUOT/' + fy + '/902', nextSpare);

  console.log('\nTHE INSTALLATION PAGE, LAID OUT AS PIE’S, WITH ITS TWO DRAWINGS');
  const AIR = 'data:image/png;base64,QUlS';
  const PLACE = 'data:image/png;base64,UExBQ0U=';
  const co2 = await p.getCompanyProfile();
  await p.saveCompanyProfile(Object.assign({}, co2, { airSystemPictureUrl: AIR, placementPictureUrl: PLACE }));
  html = await offer([['Product', 'PR-EG']]);
  const inst = html.slice(html.indexOf('<div class="h1">Recommended layout</div>'));
  const at = (t) => inst.indexOf(t);
  ok('headed Recommended layout', inst !== html && at('Recommended layout') !== -1, html.indexOf('Recommended'));
  ok('the opening line, then the air system drawing', at('<p>To achieve best performance levels') !== -1 &&
    at(AIR) > at('To achieve best performance levels'));
  ok('then the placement heading and points 1 and 2', at('Recommended compressor placement') > at(AIR) &&
    at('<ol start="1">') > at('Recommended compressor placement'));
  ok('then the clearance drawing', at(PLACE) > at('figure on the left below'));
  ok('then points 3 onwards, numbered on from 2', at('<ol start="3">') > at(PLACE) &&
    at('figure on the right above') > at('<ol start="3">'));
  ok('and the note last, in bold', at('<p class="install-note">Note:') > at('wooden pallet'));
  // Text from before the drawings — one point per line — still prints, with them placed.
  const oldBody = await p.INSTALL_TEXT_BEFORE_DRAWINGS_;
  await db.q("UPDATE quote_templates SET body = $2, title = 'Recommended compressor placement' WHERE tenant_id = $1 AND id = 'QTPL-COMP-INSTALL'",
    [TENANT, oldBody]);
  html = await offer([['Product', 'PR-EG']]);
  const old = html.slice(html.indexOf('<div class="h1">Recommended compressor placement</div>'));
  ok('the old text: the system drawing first, the clearance after point 2, numbers running on',
    old.indexOf(AIR) !== -1 && old.indexOf(AIR) < old.indexOf('<ol start="1">') &&
    old.indexOf(PLACE) > old.indexOf('for safe and proper inspection') &&
    old.indexOf('<ol start="3">') > old.indexOf(PLACE), old.slice(0, 600));
  await p.saveCompanyProfile(Object.assign({}, co2, { airSystemPictureUrl: '', placementPictureUrl: '' }));
  html = await offer([['Product', 'PR-EG']]);
  ok('no drawing uploaded, none printed — and nothing in its place',
    html.indexOf(AIR) === -1 && html.indexOf('[picture') === -1);

  console.log('\nA SYSTEM SET UP BEFORE GETS THE CORRECTIONS, UNLESS PIE CHANGED THE TEXT');
  await db.q("UPDATE quote_templates SET applies_to = '' WHERE tenant_id = $1 AND id = 'QTPL-COMP-SCOPE'", [TENANT]);
  const fixed = await p.applyStandardTextFixes_('test');
  const rowOf = async (id) => (await db.q('SELECT title, body, applies_to FROM quote_templates WHERE tenant_id = $1 AND id = $2', [TENANT, id])).rows[0];
  ok('the EQ scope becomes the EQ’s and EN’s', (await rowOf('QTPL-COMP-SCOPE')).applies_to === 'EQ, EN');
  ok('the installation page gets PIE’s layout', (await rowOf('QTPL-COMP-INSTALL')).title === 'Recommended layout' &&
    /\[picture: air system\]/.test((await rowOf('QTPL-COMP-INSTALL')).body));
  ok('and says what it changed', JSON.stringify(fixed.slice().sort()) === JSON.stringify(['InstallationNotes', 'ScopeOfSupply']), fixed);
  ok('a second run changes nothing', (await p.applyStandardTextFixes_('test')).length === 0);
  await db.q("UPDATE quote_templates SET body = 'PIE’s own wording' WHERE tenant_id = $1 AND id = 'QTPL-COMP-INSTALL'", [TENANT]);
  await db.q("UPDATE quote_templates SET applies_to = 'EQ' WHERE tenant_id = $1 AND id = 'QTPL-COMP-SCOPE'", [TENANT]);
  await p.applyStandardTextFixes_('test');
  ok('wording PIE has changed is left alone', (await rowOf('QTPL-COMP-INSTALL')).body === 'PIE’s own wording' &&
    (await rowOf('QTPL-COMP-SCOPE')).applies_to === 'EQ');
  await db.q("UPDATE quote_templates SET applies_to = 'EQ, EN' WHERE tenant_id = $1 AND id = 'QTPL-COMP-SCOPE'", [TENANT]);

  console.log('\nTHE SERIES SURVIVES AN EDIT OF THE TEXT');
  const tpl = (await p.listQuoteTemplates({ includeInactive: true })).find((t) => t.id === 'QTPL-COMP-SCOPE-EG');
  ok('the EG scope ships for the EG', tpl && tpl.appliesTo === 'EG', tpl && tpl.appliesTo);
  // A page still open from before the field existed sends no appliesTo at all.
  await p.saveQuoteTemplate({ id: tpl.id, section: tpl.section, businessStream: tpl.businessStream,
    sortOrder: 2, title: tpl.title, body: tpl.body + '\nTyped by hand', active: true });
  let after = (await p.listQuoteTemplates({ includeInactive: true })).find((t) => t.id === tpl.id);
  ok('an edit that does not mention the series keeps it', after.appliesTo === 'EG', after.appliesTo);
  await p.saveQuoteTemplate({ id: tpl.id, section: tpl.section, businessStream: tpl.businessStream,
    sortOrder: 2, title: tpl.title, body: tpl.body, appliesTo: 'eg, el', active: true });
  after = (await p.listQuoteTemplates({ includeInactive: true })).find((t) => t.id === tpl.id);
  ok('one that does sets it, in capitals', after.appliesTo === 'EG, EL', after.appliesTo);
  html = await offer([['Product', 'PR-EL']]);
  ok('and the EL now gets that text', scopeAfter(html, 'Scope of supply').indexOf('Neuron IV controller') !== -1);
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
