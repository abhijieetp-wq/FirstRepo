/**
 * The spares offer's terms and carting, as PIE's spares desk asked (Nov 2026):
 *
 *   - point 2 says carting is extra from our godown to the transporter's, and a new point 3
 *     that freight is extra, to-pay, from there to the customer's district; the old point is
 *     rewritten where it was still word for word, and left alone where it was changed;
 *   - the Delivery point prints the period chosen on the quotation;
 *   - a Carting line of its own: ₹300 when the goods come to ₹10,000 or less, ₹500 above, an
 *     amount typed by hand kept (₹500 or more above ₹10,000), blank for automatic again, taken
 *     off for good when removed, last among the lines, and only on a spares offer for spares.
 *
 * Customers and parts are invented.
 *
 *   DATABASE_URL=postgres://... node tests/spare-terms-carting-sql-test.js
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
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 600) : ''));
};
const refuses = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re.test(String(e.message)) || String(e.message); }
};

const TENANT = 'spare-terms-carting-test';
const TABLES = ['users', 'audit_log', 'customers', 'customer_addresses', 'products', 'spares', 'price_list', 'quotations',
  'quotation_items', 'quote_templates', 'company_profile', 'spare_enquiries', 'spare_enquiry_items'];
const BOSS = { email: 'office@pie.invalid', name: 'Office Admin', role: 'ERP Admin', businessStream: 'All' };

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => { for (const t of TABLES) { try { await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]); } catch (e) { /* no table */ } } };
  await clean();
  await db.appendRow('Users', { id: 'U-1', email: BOSS.email, name: BOSS.name, role: BOSS.role, businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Test Customer', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', addressType: 'Billing', line1: 'Plot 1', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: 'TRUE' });
  await db.appendRow('Spares', { id: 'SP-1', partNo: 'TST-0001', description: 'Oil filter', gstPct: 18, hsnCode: '8421', active: 'TRUE' });
  await db.appendRow('Products', { id: 'PR-1', productCode: 'S900100', model: 'EG 37-7.5', series: 'EG', gstPct: 18, hsnCode: '84148011', active: 'TRUE' });
  const p = loadPortal(db, BOSS.email, { quiet: true, properties: {} });
  p.CURRENT_USER_ = BOSS;
  await p.installMissingQuoteTemplates_('test');

  const termsOf = (h) => {
    const at = h.indexOf('Terms &amp; Conditions');
    const list = h.slice(at, h.indexOf('</ol>', at) + 5);
    return (list.match(/<li>[\s\S]*?<\/li>/g) || []).map((x) => x.replace(/<[^>]+>/g, '').trim());
  };
  const linesOf = async (id) => (await p.getQuotation(id)).items.map((i) => [i.lineNo, i.description, Number(i.unitPrice), String(i.autoCharge || '')]);
  const carting = async (id) => (await p.getQuotation(id)).items.find((i) => /^Carting/.test(i.description));
  const spareQuote = async () => p.createQuotationFromEnquiry((await p.saveSpareEnquiry({ customerId: 'CU-1', source: 'Call', requirementText: 'Parts' })).id);
  const goods = (id, qty, price) => p.saveQuotationItem({ quotationId: id, itemType: 'Spare', itemId: 'SP-1', qty, unitPrice: price });

  console.log('THE TERMS');
  let q = await spareQuote();
  await goods(q.id, 2, 1000);
  let terms = termsOf(await p.buildQuotationHtml(q.id));
  ok('point 2: carting extra from our godown up to the transporter’s', terms[1] === 'Carting extra from our godown up to transporter’s godown.', terms);
  ok('point 3: freight extra, to-pay, from the transporter’s godown to the customer’s district',
    terms[2] === 'Freight will be extra, on To-Pay basis, from the transporter’s godown up to your location (district).', terms);
  ok('the old “Carting and freight shall be extra.” is gone', !terms.some((t) => /Carting and freight shall be extra/.test(t)));
  await p.saveQuotationHeader({ id: q.id, deliveryPeriod: 'Ready stock subject to prior sale' });
  terms = termsOf(await p.buildQuotationHtml(q.id));
  ok('the Delivery point prints the period chosen', terms.includes('Delivery: Ready stock subject to prior sale.'), terms);
  await p.saveQuotationHeader({ id: q.id, deliveryPeriod: '14-16 Weeks' });
  ok('and another', termsOf(await p.buildQuotationHtml(q.id)).includes('Delivery: 14-16 Weeks.'));
  ok('no delivery basis typed, none printed', !termsOf(await p.buildQuotationHtml(q.id)).some((t) => /^Delivery basis/.test(t)));
  await p.saveQuotationHeader({ id: q.id, deliveryPeriod: '14-16 Weeks', deliveryTerms: 'FOR Destination' });
  terms = termsOf(await p.buildQuotationHtml(q.id));
  ok('the delivery basis typed on the quotation is printed, straight after Delivery',
    terms[terms.findIndex((t) => /^Delivery:/.test(t)) + 1] === 'Delivery basis: FOR Destination.', terms);
  await p.saveQuotationHeader({ id: q.id, deliveryPeriod: '14-16 Weeks' });
  ok('and kept by a save that does not send it', (await p.getQuotation(q.id)).deliveryTerms === 'FOR Destination');
  const cq = await p.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales' });
  await p.saveQuotationHeader({ id: cq.id, deliveryTerms: 'Ex-Works' });
  const ct = termsOf(await p.buildQuotationHtml(cq.id));
  ok('on a compressor offer too, after its Delivery point', ct[ct.findIndex((t) => /^Delivery:/.test(t)) + 1] === 'Delivery basis: Ex-Works.', ct);

  console.log('\nPAYMENT AND WARRANTY TERMS AS TYPED');
  ok('blank, the standing payment clause prints', termsOf(await p.buildQuotationHtml(q.id)).includes('Terms of payment: 100% advance.'));
  await p.saveQuotationHeader({ id: q.id, deliveryPeriod: '14-16 Weeks', paymentTerms: '30 days credit from invoice', warrantyTerms: '6 months on the controller' });
  terms = termsOf(await p.buildQuotationHtml(q.id));
  ok('the payment terms typed replace it', terms.includes('Terms of payment: 30 days credit from invoice.') && !terms.some((t) => /100% advance/.test(t)), terms);
  ok('and the warranty typed replaces the standing one', terms.includes('Warranty: 6 months on the controller.') && !terms.some((t) => /three-month warranty/.test(t)), terms);
  await p.saveQuotationHeader({ id: cq.id, deliveryTerms: 'Ex-Works', paymentTerms: '50% advance, 50% before dispatch', warrantyTerms: '18 months from dispatch' });
  const html = await p.buildQuotationHtml(cq.id);
  const ct2 = termsOf(html);
  ok('on a compressor offer, the payment terms', ct2.includes('Terms of payment: 50% advance, 50% before dispatch.'), ct2);
  ok('and the warranty, with the standing points under it gone', ct2.some((t) => /^Warranty: 18 months from dispatch\./.test(t)) && !ct2.some((t) => /warranted for a period of 12 months/.test(t)), ct2.filter((t) => /arrant/.test(t)));

  console.log('\nTHE TERMS ALREADY INSTALLED');
  const OLD = 'GST shall be extra on the basic value of the order.\nCarting and freight shall be extra.\nTransit insurance shall be arranged by the Purchaser.';
  await db.q("UPDATE quote_templates SET body = $2 WHERE tenant_id = $1 AND id = 'QTPL-SPARE-TERMS'", [TENANT, OLD]);
  let fixed = await p.applyStandardTextFixes_('test');
  const body = async () => (await db.q("SELECT body FROM quote_templates WHERE tenant_id = $1 AND id = 'QTPL-SPARE-TERMS'", [TENANT])).rows[0].body;
  ok('a system set up earlier has the old point rewritten as the two, in its place', fixed.includes('Terms') && (await body()) ===
    'GST shall be extra on the basic value of the order.\nCarting extra from our godown up to transporter’s godown.\n' +
    'Freight will be extra, on To-Pay basis, from the transporter’s godown up to your location (district).\nTransit insurance shall be arranged by the Purchaser.', await body());
  fixed = await p.applyStandardTextFixes_('test');
  ok('once', !fixed.includes('Terms'));
  const OWN = 'GST shall be extra.\nCarting and freight extra at actuals.';
  await db.q("UPDATE quote_templates SET body = $2 WHERE tenant_id = $1 AND id = 'QTPL-SPARE-TERMS'", [TENANT, OWN]);
  await p.applyStandardTextFixes_('test');
  ok('wording PIE changed themselves is left alone', (await body()) === OWN);

  console.log('\nCARTING, BY THE GOODS');
  q = await spareQuote();
  ok('no goods, no carting yet', (await p.getQuotation(q.id)).items.length === 0);
  await goods(q.id, 2, 1000);
  ok('goods of ₹2,000: Carting ₹300, automatic, after the part', JSON.stringify(await linesOf(q.id)) === JSON.stringify([[1, 'Oil filter', 1000, ''], [2, 'Carting', 300, 'AUTO']]), await linesOf(q.id));
  await goods(q.id, 8, 1000);
  ok('exactly ₹10,000: still ₹300', Number((await carting(q.id)).unitPrice) === 300, await linesOf(q.id));
  await goods(q.id, 1, 1);
  ok('above ₹10,000: ₹500', Number((await carting(q.id)).unitPrice) === 500, await linesOf(q.id));
  await p.saveQuotationHeader({ id: q.id, packageDiscountPct: 10 });
  ok('the goods after their discount: ₹10,001 less 10% is under ₹10,000, so ₹300', Number((await carting(q.id)).unitPrice) === 300);
  const disc = await p.getQuotation(q.id);
  ok('and the package discount is the parts’ alone: carting is not discounted', Math.abs(disc.discountAmt - 1000.1) < 0.01, disc.discountAmt);
  await p.saveQuotationHeader({ id: q.id, packageDiscountPct: 0 });
  await p.saveQuotationItem({ quotationId: q.id, itemType: 'Spare', itemId: 'SP-1', qty: 1, unitPrice: 50, description: 'Gasket' });
  const lastLine = (await linesOf(q.id)).slice(-1)[0];
  ok('carting stays the last line, with the lines numbered in order', lastLine[1] === 'Carting' &&
    (await linesOf(q.id)).every((l, i) => l[0] === i + 1), await linesOf(q.id));
  const priced = await p.getQuotation(q.id);
  ok('and it is in the totals and taxed like the goods', Math.abs(priced.subtotal - (10001 + 50 + 500)) < 0.01 && Number((await carting(q.id)).taxPct) === 18, priced.subtotal);

  console.log('\nCARTING, TYPED BY HAND');
  let cart = await carting(q.id);
  ok('above ₹10,000, less than ₹500 is refused', await refuses(() => p.saveQuotationCharge({ quotationId: q.id, id: cart.id, lineNo: cart.lineNo, description: 'Carting', amount: 400 }),
    /Carting on goods above ₹10,000 is ₹500 or more/));
  await p.saveQuotationCharge({ quotationId: q.id, id: cart.id, lineNo: cart.lineNo, description: 'Carting', amount: 750 });
  cart = await carting(q.id);
  ok('₹750 is kept, as typed', Number(cart.unitPrice) === 750 && cart.autoCharge === 'MANUAL');
  await goods(q.id, 1, 100);
  ok('and stays when the goods change', Number((await carting(q.id)).unitPrice) === 750);
  await p.saveQuotationCharge({ quotationId: q.id, id: cart.id, lineNo: cart.lineNo, description: 'Carting', amount: '' });
  cart = await carting(q.id);
  ok('cleared, it is automatic again: ₹500', Number(cart.unitPrice) === 500 && cart.autoCharge === 'AUTO');
  const small = await spareQuote();
  await goods(small.id, 1, 2000);
  let sc = await carting(small.id);
  await p.saveQuotationCharge({ quotationId: small.id, id: sc.id, lineNo: sc.lineNo, description: 'Carting', amount: 250 });
  ok('up to ₹10,000 any amount can be typed', Number((await carting(small.id)).unitPrice) === 250);
  await goods(small.id, 6, 2000);
  ok('one typed lower is raised to ₹500 when the goods pass ₹10,000', Number((await carting(small.id)).unitPrice) === 500 && (await carting(small.id)).autoCharge === 'MANUAL');
  ok('a second Carting line is refused', await refuses(() => p.saveQuotationCharge({ quotationId: small.id, description: 'Carting', amount: 100 }), /already has a Carting line/));

  console.log('\nCARTING TAKEN OFF');
  sc = await carting(small.id);
  await p.deleteQuotationItem(sc.id);
  await goods(small.id, 1, 10);
  ok('taken off, it stays off as the offer changes', !(await carting(small.id)) && (await p.getQuotation(small.id)).cartingOff === 'TRUE');
  await p.saveQuotationCharge({ quotationId: small.id, description: 'Carting', amount: '' });
  ok('put back by hand, automatic and followed again', Number((await carting(small.id)).unitPrice) === 500 && !(await p.getQuotation(small.id)).cartingOff);

  console.log('\nONLY ON A SPARES OFFER FOR SPARES');
  const unit = await p.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales' });
  await p.saveQuotationItem({ quotationId: unit.id, itemType: 'Product', itemId: 'PR-1', qty: 1, unitPrice: 500000 });
  ok('a compressor offer gets none', !(await carting(unit.id)));
  await db.appendRow('SpareEnquiries', { id: 'SE-AMC', enquiryNo: 'SE-AMC', customerId: 'CU-1', businessStream: 'Spare Sales', enquiryType: 'AMC renewal', status: 'Open' });
  const amc = await spareQuote();
  await db.q('UPDATE quotations SET spare_enquiry_id = $3 WHERE tenant_id = $1 AND id = $2', [TENANT, amc.id, 'SE-AMC']);
  await goods(amc.id, 1, 40000);
  ok('nor an AMC renewal offer', !(await carting(amc.id)));
  const other = await spareQuote();
  await goods(other.id, 1, 1000);
  await p.saveQuotationCharge({ quotationId: other.id, description: 'Packing', amount: 120 });
  ok('another charge is just a charge', (await linesOf(other.id)).some((l) => l[1] === 'Packing' && l[2] === 120 && l[3] === ''));

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : 'all ') + pass + ' passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
