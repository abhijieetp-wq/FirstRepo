/**
 * Filling in what a catalogue row is missing, at the moment someone needs it.
 *
 * A real catalogue arrives incomplete. 4,470 of ELGi's spare rows carry the words "Will update
 * shortly" where an HSN code belongs, and the EQ compressor brochure carries no prices at all
 * — a brochure never does. Adding such a row to a quotation used to write a line at zero and
 * say nothing, which is noticed once the offer is in front of a customer.
 *
 * This was built for spares and stayed there, which was a mistake the compressor catalogue
 * made expensive: 70 of the 73 products have no price, so every one of them would have gone
 * onto a quotation at ₹0 with only a small grey badge in the picker to warn anyone.
 *
 * What is entered always reaches the quotation. Whether it also reaches the catalogue depends
 * on rights: a price typed to get one offer out should not silently become the price everyone
 * quotes, so writing back needs Management or ERP Admin, and the caller is told which
 * happened.
 */

/**
 * @param input {itemType, itemId, hsnCode, price, quoteNo}
 * @return {code, description, hsnCode, price, savedToCatalog[], canWriteMaster}
 */
function completeCatalogDetails(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var itemType = String(input.itemType || 'Spare').trim();
  var spec = catalogSpec_(itemType);

  var row = readTable_(spec.tab).filter(function (r) {
    return String(r.id) === String(input.itemId);
  })[0];
  if (!row) throw new Error('That ' + spec.label + ' no longer exists.');

  var code = row[spec.code];

  var hsn = String(input.hsnCode === undefined ? '' : input.hsnCode).trim();
  // Four digits is a valid HSN and it is what PIE's own quotations print (8414), so the rule
  // is 4, 6 or 8 — not the 6-to-8 this used to demand, which would have refused their own.
  if (hsn && !/^\d{4}$|^\d{6}$|^\d{8}$/.test(hsn)) {
    throw new Error('An HSN code is 4, 6 or 8 digits. Leave it blank rather than guessing — ' +
      'it prints on the quotation.');
  }

  var price = input.price === '' || input.price === undefined || input.price === null
    ? null : Number(input.price);
  if (price !== null && (isNaN(price) || price < 0)) {
    throw new Error('The price must be a number, zero or more.');
  }

  var canWriteMaster = MASTER_EDITORS.indexOf(user.role) !== -1;
  var written = [];

  if (canWriteMaster && hsn && hsn !== String(row.hsnCode || '').trim()) {
    updateRowById_(spec.tab, 'id', row.id, { hsnCode: hsn },
      'HSN supplied while quoting ' + (input.quoteNo || ''));
    written.push('HSN code');
  }

  if (canWriteMaster && price !== null) {
    savePrice({
      itemType: itemType, itemId: row.id, itemCode: code,
      priceLevel: SELLING_PRICE_LEVEL, price: price,
      reason: 'Supplied while quoting ' + (input.quoteNo || '')
    });
    written.push('selling price');
  }

  return {
    code: code,
    partNo: code,                       // the name the spare picker has always used
    description: row.description || row.model || '',
    hsnCode: hsn || row.hsnCode || '',
    price: price,
    savedToCatalog: written,
    canWriteMaster: canWriteMaster
  };
}
