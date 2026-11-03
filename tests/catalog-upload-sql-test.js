/**
 * The catalogue upload, end to end on the server: preview, commit, and the offer it feeds.
 *
 * Two things were broken here and neither was caught, because the existing tests call the
 * query that writes the rows and never the upload that calls it:
 *
 *   - the commit died with "LOCK_WAIT_BULK_MS is not defined" — a constant that lives in
 *     SheetService.gs, which the server does not load — after its own preview had reported a
 *     clean file. Every spares and compressor upload on the server failed at the last step.
 *   - motorKw and weightKg were NUMERIC, so "22 kW, 30 hp" and "700 kg" were turned into null
 *     on the way in, silently, and the compressor offer printed an empty motor and weight row.
 *
 * The models here are invented. The real ELGi figures stay out of the repository.
 *
 *   DATABASE_URL=postgres://... node tests/catalog-upload-sql-test.js
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
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const TENANT = 'upload-test';
const BOSS = { email: 'boss@pie.in', name: 'Anil Shah', role: 'ERP Admin' };
const TABLES = ['users', 'customers', 'customer_addresses', 'products', 'price_list',
  'quotations', 'quotation_items', 'audit_log'];

const HEADER = 'productCode,hsnCode,model,family,series,description,category,hpRating,fad,' +
  'workingPressure,capacityCfm,maxPressure,motorKw,starterType,dimensionsMm,weightKg,gstPct,' +
  'piePrice,elgiPrice,warrantyMonths,leadTimeDays,uom,notes';
const CSV = '﻿' + [HEADER,
  'TX20-7.5,,TX 20-7.5 DM,Lubricated screw,TX,"Test compressor, 20 kW",Screw,27,100 cfm,' +
    '7 bar.g,100 cfm (2.83 m³/min),7.5 bar.g,"20 kW, 27 hp",Automatic star delta,' +
    '1400 x 800 x 1200 mm (L x W x H),650 kg (dry),,,,,,Nos,"Spec sheet TEST rev R01, outlet 1"" BSP."',
  'TX20-10,,TX 20-10 DM,Lubricated screw,TX,"Test compressor, 20 kW",Screw,27,82 cfm,' +
    '9.5 bar.g,82 cfm (2.32 m³/min),10 bar.g,"20 kW, 27 hp",Automatic star delta,' +
    '1400 x 800 x 1200 mm (L x W x H),650 kg (dry),,,,,,Nos,Spec sheet TEST rev R01'
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
  // Already on file: a price, a GST rate and an HSN code that the upload leaves blank and so
  // must leave alone.
  await db.appendRow('Products', { id: 'PR-OLD', productCode: 'TX20-7.5', model: 'TX 20', gstPct: 18,
    hsnCode: '84148011', active: 'TRUE' });
  await db.appendRow('PriceList', { id: 'PRC-1', itemType: 'Product', itemId: 'PR-OLD', itemCode: 'TX20-7.5',
    priceLevel: 'ELGI', price: 345678, effectiveFrom: '2026-01-01', active: 'TRUE', currency: 'INR' });

  const p = loadPortal(db, BOSS.email, { quiet: true });
  p.CURRENT_USER_ = BOSS;

  console.log('THE PREVIEW READS THE FILE');
  const pre = await p.previewCatalogImport('Product', CSV);
  ok('two rows, one new and one already on file', pre.totalRows === 2 && pre.newCount === 1 &&
    pre.updateCount === 1, pre);
  ok('nothing skipped, and no price changes from blank price columns',
    pre.skippedCount === 0 && pre.priceChangeCount === 0, pre);

  console.log('\nTHE COMMIT FINISHES');
  let res = null, err = null;
  try { res = await p.commitCatalogImport('Product', CSV); } catch (e) { err = e.message; }
  ok('it does not die at the last step', err === null, err);
  const rows = (await db.q('SELECT * FROM products WHERE tenant_id = $1 ORDER BY product_code', [TENANT])).rows;
  ok('both models are on file', rows.length === 2, rows.length);

  console.log('\nTHE WORDS AN OFFER PRINTS SURVIVE, UNITS AND ALL');
  const old = rows.find((r) => r.product_code === 'TX20-7.5');
  ok('motor rating as written', old.motor_kw === '20 kW, 27 hp', old.motor_kw);
  ok('weight as written', old.weight_kg === '650 kg (dry)', old.weight_kg);
  ok('capacity, with the cubic metre sign', old.capacity_cfm === '100 cfm (2.83 m³/min)', old.capacity_cfm);
  ok('a quoted inch mark in a note survives', /1" BSP/.test(old.notes), old.notes);

  console.log('\nWHAT THE FILE LEFT BLANK IS LEFT ALONE');
  ok('the GST rate', Number(old.gst_pct) === 18, old.gst_pct);
  ok('the HSN code', old.hsn_code === '84148011', old.hsn_code);
  const price = (await db.q("SELECT price FROM price_list WHERE tenant_id = $1 AND item_id = 'PR-OLD'", [TENANT])).rows;
  ok('and the price', price.length === 1 && Number(price[0].price) === 345678, price);
  ok('what it did fill in replaced the old', old.model === 'TX 20-7.5 DM', old.model);

  console.log('\nAND THE OFFER PRINTS EVERY SPECIFICATION ROW');
  const q = await p.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales' });
  await p.saveQuotationItem({ quotationId: q.id, itemType: 'Product', itemId: 'PR-OLD', qty: 1 });
  const full = await p.getQuotation(q.id);
  ok('nothing missing from the specification', full.specGaps.length === 0, full.specGaps);
  const html = await p.buildQuotationHtml(q.id);
  for (const v of ['TX 20-7.5 DM', '100 cfm (2.83 m³/min)', '7.5 bar.g', '7 bar.g', '20 kW, 27 hp',
    'Automatic star delta', '1400 x 800 x 1200 mm (L x W x H)', '650 kg (dry)']) {
    ok('the printed table has ' + v, html.indexOf(v) !== -1);
  }

  console.log('\nA NEW CODE FOR A COMPRESSOR ALREADY ON FILE');
  // PIE's compressors moved to ELGi's TPL codes: previousProductCode names the code a product
  // has now, so the product keeps its id, price and offers and takes the new code.
  const renameRow = (code, model, prev) => [code, '', model].concat(Array(20).fill('')).concat([prev]).join(',');
  const RENAME = '\uFEFF' + [HEADER + ',previousProductCode',
    renameRow('T0000001', 'TX 20-7.5 DM', 'TX20-7.5'),     // the one on file from the start
    renameRow('T0000002', 'TX 20-10 DM', 'TX20-10'),       // the one the upload above added
    renameRow('T0000003', 'TX 30-7.5 DM', 'TX30-7.5'),     // no such code on file: a new product
    renameRow('T0000004', 'TX 20-7.5 DM', 'TX20-7.5')      // a second line onto the first product
  ].join('\r\n') + '\r\n';
  const rp = await p.previewCatalogImport('Product', RENAME);
  ok('the preview: two take a new code, one is new, a second line onto one product is refused',
    rp.newCount === 1 && rp.updateCount === 2 && rp.renamedCount === 2 && rp.skippedCount === 1 &&
    /line 2 already updates the same product/.test(rp.skipped[0].reason), rp);
  ok('each named old code → new', rp.sample.some((x) => x.code === 'T0000001' && x.renamedFrom === 'TX20-7.5'), rp.sample);
  const rc = await p.commitCatalogImport('Product', RENAME);
  ok('the commit says the same', rc.newCount === 1 && rc.updateCount === 2 && rc.renamedCount === 2, rc);
  const after = await db.readTable('Products');
  const byId = (id) => after.find((x) => x.id === id) || {};
  ok('the same product, with the new code', byId('PR-OLD').productCode === 'T0000001' &&
    !after.some((x) => x.productCode === 'TX20-7.5') && after.filter((x) => x.productCode === 'T0000002').length === 1, after.map((x) => x.id + ':' + x.productCode));
  ok('and nothing added for the two it renamed', after.length === 3, after.length);
  const prices = await p.priceMapFor_('Product');
  ok('its price still in force', prices['PR-OLD'] && prices['PR-OLD'].ELGI && prices['PR-OLD'].ELGI.price === 345678, prices['PR-OLD']);
  const lines = await db.readTable('QuotationItems');
  ok('an offer already made keeps the code it was made with', lines.some((l) => l.itemId === 'PR-OLD' && l.itemCode === 'TX20-7.5'), lines.map((l) => l.itemCode));
  const again = await p.previewCatalogImport('Product', RENAME.split('\r\n').slice(0, 4).join('\r\n'));
  ok('the same file again: updates by the new codes, nothing renamed', again.newCount === 0 && again.updateCount === 3 && again.renamedCount === 0, again);
  const logged = (await db.q("SELECT new_value FROM audit_log WHERE tenant_id = $1 AND record_id = '(bulk import)' ORDER BY timestamp DESC LIMIT 1", [TENANT])).rows[0] || {};
  ok('and the audit says how many took a new code', /2 with a new code/.test(String(logged.new_value || '')), logged);

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
