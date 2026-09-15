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
 * Deactivating a part (the normal case) does not consult this at all. A deactivated row stays
 * in the sheet precisely so those references keep resolving.
 */

/** Tables keyed by itemType + itemId — the shared shape used across quoting, stock and billing. */
var TYPED_ITEM_REFERENCES_ = [
  { tab: 'QuotationItems', label: 'quotation line', parent: 'quotationId' },
  { tab: 'SalesOrderItems', label: 'order line', parent: 'salesOrderId' },
  { tab: 'StockMovements', label: 'stock movement', parent: '' },
  { tab: 'StockReservations', label: 'stock reservation', parent: 'salesOrderId' },
  { tab: 'GRNItems', label: 'goods receipt line', parent: 'grnId' },
  { tab: 'DispatchItems', label: 'dispatch line', parent: 'dispatchId' },
  { tab: 'InvoiceItems', label: 'invoice line', parent: 'invoiceId' }
];

/** Tables that name one kind of item directly, without an itemType column to filter on. */
var DIRECT_ITEM_REFERENCES_ = {
  Spare: [
    { tab: 'SpareEnquiryItems', field: 'spareId', label: 'enquiry line', parent: 'spareEnquiryId' },
    { tab: 'SpareAlternates', field: 'alternateSpareId', label: 'substitute listed against another part', parent: 'spareId' }
  ],
  Product: [
    { tab: 'SerialNumbers', field: 'productId', label: 'serial number', parent: 'serialNo' },
    { tab: 'InstalledBase', field: 'productId', label: 'installed machine', parent: 'serialNo' },
    { tab: 'CompressorSelections', field: 'productId', label: 'compressor selection', parent: 'opportunityId' },
    { tab: 'SpareCompatibility', field: 'productId', label: 'spare compatibility entry', parent: 'spareId' }
  ]
};

/**
 * Lists what refers to the given items, as readable phrases.
 *
 * `ids` is a map of id → code, so one pass over each table covers a whole catalogue as
 * cheaply as it covers a single row. Returns [] when nothing points at any of them.
 */
function itemReferences_(itemType, ids) {
  var found = [];

  var note = function (ref, row) {
    var owner = ref.parent ? row[ref.parent] : '';
    found.push(ref.label + (owner ? ' ' + owner : ''));
  };

  var scan = function (list, matches) {
    list.forEach(function (ref) {
      readTable_(ref.tab).forEach(function (row) {
        if (matches(ref, row)) note(ref, row);
      });
    });
  };

  scan(TYPED_ITEM_REFERENCES_, function (ref, row) {
    return row.itemType === itemType && ids.hasOwnProperty(String(row.itemId));
  });
  scan(DIRECT_ITEM_REFERENCES_[itemType] || [], function (ref, row) {
    return ids.hasOwnProperty(String(row[ref.field]));
  });

  return found;
}

/**
 * Throws with what is in the way, or returns quietly.
 *
 * The message names examples rather than a count alone, because "3 records" sends someone
 * hunting while "quotation line Q-2026-0041" does not.
 */
function assertItemUnreferenced_(itemType, ids, what) {
  var refs = itemReferences_(itemType, ids);
  if (!refs.length) return;
  throw new Error(what + ' already used by ' + refs.length + ' record(s) — for example ' +
    refs.slice(0, 3).join(', ') +
    '. Deactivate instead: the row stays in the sheet so those documents still resolve, ' +
    'and it stops appearing anywhere new work is entered.');
}
