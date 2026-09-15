/**
 * Where a catalogue item can be referred to from.
 *
 * Removing a master row that a document points at leaves that document unable to say what it
 * sold: an invoice line whose itemId resolves to nothing, a stock movement for a part that no
 * longer exists. Every hard delete in the catalogue therefore asks this module first.
 *
 * It lives on its own so there is exactly one answer to "is this part in use". The whole-
 * catalogue purge and the single-row delete used to be free to disagree, and did — the purge
 * checked two tables, one of them under a name the schema does not use, so it looked
 * thorough while actually testing nothing.
 *
 * References are reported by the number on the document, not by the row id that links to it.
 * "quotation line QT-479af6c2" is unanswerable — that id appears nowhere on screen — where
 * "quotation PIE/ELGI/QUOT/26-27/383" is something you can open.
 *
 * Deactivating a part (the normal case) does not consult this at all. A deactivated row stays
 * in the sheet precisely so those references keep resolving.
 */

/** Tables keyed by itemType + itemId — the shared shape used across quoting, stock and billing. */
var TYPED_ITEM_REFERENCES_ = [
  { tab: 'QuotationItems', label: 'quotation', parent: 'quotationId', parentTab: 'Quotations', parentField: 'quoteNo' },
  { tab: 'SalesOrderItems', label: 'order', parent: 'salesOrderId', parentTab: 'SalesOrders', parentField: 'orderNo' },
  { tab: 'StockMovements', label: 'stock movement', parent: '' },
  { tab: 'StockReservations', label: 'reservation on order', parent: 'salesOrderId', parentTab: 'SalesOrders', parentField: 'orderNo' },
  { tab: 'GRNItems', label: 'goods receipt', parent: 'grnId', parentTab: 'GRNs', parentField: 'grnNo' },
  { tab: 'DispatchItems', label: 'dispatch', parent: 'dispatchId', parentTab: 'Dispatches', parentField: 'dispatchNo' },
  { tab: 'InvoiceItems', label: 'invoice', parent: 'invoiceId', parentTab: 'Invoices', parentField: 'invoiceNo' }
];

/** Tables that name one kind of item directly, without an itemType column to filter on. */
var DIRECT_ITEM_REFERENCES_ = {
  Spare: [
    { tab: 'SpareEnquiryItems', field: 'spareId', label: 'enquiry', parent: 'spareEnquiryId', parentTab: 'SpareEnquiries', parentField: 'enquiryNo' },
    { tab: 'SpareAlternates', field: 'alternateSpareId', label: 'substitute listed against part', parent: 'spareId', parentTab: 'Spares', parentField: 'partNo' }
  ],
  Product: [
    { tab: 'SerialNumbers', field: 'productId', label: 'serial number', parent: 'serialNo' },
    { tab: 'InstalledBase', field: 'productId', label: 'installed machine', parent: 'serialNo' },
    { tab: 'CompressorSelections', field: 'productId', label: 'selection on opportunity', parent: 'opportunityId', parentTab: 'Opportunities', parentField: 'opportunityNo' },
    { tab: 'SpareCompatibility', field: 'productId', label: 'compatibility entry for part', parent: 'spareId', parentTab: 'Spares', parentField: 'partNo' }
  ]
};

/**
 * Which of `ids` are referred to, and by what.
 *
 * `ids` is a map of id → code, so one pass over each table covers a whole catalogue as
 * cheaply as it covers a single row. Returns a map of item id → readable phrases, holding
 * only the ids that something points at; each item's list is deduplicated, because two lines
 * of one quotation are one document to whoever has to go and deal with it.
 */
function itemReferenceMap_(itemType, ids) {
  var out = {};
  var lookups = {};

  // Only built for a tab that actually produced a hit, so a clean catalogue reads nothing.
  var docNumber = function (ref, row) {
    var key = row[ref.parent];
    if (key === undefined || key === '') return '';
    if (!ref.parentTab) return String(key);
    if (!lookups[ref.parentTab]) {
      var map = {};
      try {
        readTable_(ref.parentTab).forEach(function (r) { map[String(r.id)] = r[ref.parentField]; });
      } catch (e) {
        // A sheet set up before that tab existed. The reference is still real and still has
        // to block the delete — only the friendly number is unavailable, so fall back to the
        // id rather than failing the whole check over a cosmetic lookup.
        console.warn('Could not read ' + ref.parentTab + ' to name a reference: ' + e.message);
      }
      lookups[ref.parentTab] = map;
    }
    return String(lookups[ref.parentTab][String(key)] || key);
  };

  var note = function (id, ref, row) {
    var num = ref.parent ? docNumber(ref, row) : '';
    var phrase = ref.label + (num ? ' ' + num : '');
    if (!out[id]) out[id] = [];
    if (out[id].indexOf(phrase) === -1) out[id].push(phrase);
  };

  var scan = function (list, idOf) {
    list.forEach(function (ref) {
      readTable_(ref.tab).forEach(function (row) {
        var id = idOf(ref, row);
        if (id && ids.hasOwnProperty(id)) note(id, ref, row);
      });
    });
  };

  scan(TYPED_ITEM_REFERENCES_, function (ref, row) {
    return row.itemType === itemType ? String(row.itemId) : '';
  });
  scan(DIRECT_ITEM_REFERENCES_[itemType] || [], function (ref, row) {
    return String(row[ref.field]);
  });

  return out;
}

/** The same thing flattened, for callers that only need "is anything in the way, and what". */
function itemReferences_(itemType, ids) {
  var map = itemReferenceMap_(itemType, ids);
  var all = [];
  Object.keys(map).forEach(function (id) {
    map[id].forEach(function (phrase) {
      if (all.indexOf(phrase) === -1) all.push(phrase);
    });
  });
  return all;
}

/**
 * Throws with what is in the way, or returns quietly.
 *
 * The message names documents rather than a count alone, because "3 records" sends someone
 * hunting while "quotation PIE/ELGI/QUOT/26-27/383" does not.
 */
function assertItemUnreferenced_(itemType, ids, what) {
  var refs = itemReferences_(itemType, ids);
  if (!refs.length) return;
  throw new Error(what + ' referred to by ' + refs.length + ' document(s) — ' +
    refs.slice(0, 4).join(', ') + (refs.length > 4 ? ', and others' : '') +
    '. Deactivate instead: the row stays in the sheet so those documents still resolve, ' +
    'and it stops appearing anywhere new work is entered.');
}
