/**
 * The customer's own paperwork, held rather than referred to.
 *
 * A purchase order was a text box asking for a Drive link, which meant it was almost always
 * empty: the PO arrives as an email attachment, and nobody uploads it to Drive and copies a
 * link on the way past. A tax invoice had nowhere to go at all — twenty-five columns on
 * Invoices and not one for the document.
 *
 * The division of labour is the point. A few fields stay on the order and the invoice,
 * because the system has to act on them: dispatch refuses without a PO number, the variance
 * check compares the PO's value against what was quoted, receivables age from the invoice
 * date. Everything else is evidence, and evidence belongs in the document, not retyped out
 * of it. So: key in what is checked, attach the rest.
 */

var DOC_FOLDER = 'ERP Documents';
var DOC_MAX_BYTES = 10 * 1024 * 1024;

/**
 * What kind of paper this is, and what it may hang off.
 *
 * Declared rather than free text so the screen can offer the right few and a typo cannot
 * quietly create a category nobody will ever search for.
 */
var DOC_TYPES = {
  SalesOrder: ['Purchase Order', 'PO Amendment', 'Customer Correspondence', 'Other'],
  Invoice: ['Tax Invoice', 'E-Way Bill', 'Delivery Challan', 'Customer Correspondence', 'Other']
};

/** The roles that may attach or remove a document — the same ones that own the record. */
var DOC_EDITORS = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/**
 * Writes one uploaded file to Drive and returns a row pointing at it.
 *
 * Shared with the delivery and service proofs, which do the same thing for photographs: one
 * place that knows how a data URL becomes a Drive file, so a limit or a rule changed here
 * applies to every attachment in the system.
 */
function storeDriveFile_(options) {
  var dataUrl = String((options.input && options.input.dataUrl) || '');
  var match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error(options.rejectMessage || 'That file could not be read.');

  var mimeType = match[1];
  var allowed = options.allow || ['image/', 'application/pdf'];
  var fits = allowed.some(function (a) {
    return a.slice(-1) === '/' ? mimeType.indexOf(a) === 0 : mimeType === a;
  });
  if (!fits) throw new Error(options.typeMessage || 'That kind of file cannot be attached here.');

  var bytes = Utilities.base64Decode(match[2]);
  var max = options.maxBytes || DOC_MAX_BYTES;
  if (bytes.length > max) {
    throw new Error('That file is ' + Math.round(bytes.length / 1024 / 1024 * 10) / 10 +
      ' MB, and the limit is ' + Math.round(max / 1024 / 1024) + ' MB.');
  }

  // A slash in a file name makes a folder on some systems and a broken name on others.
  var name = String((options.input && options.input.name) || 'document')
    .replace(/[\/\\:*?"<>|]/g, '-');
  var stamped = options.label + ' ' + todayIso_() + ' ' + name;
  var blob = Utilities.newBlob(bytes, mimeType, stamped);

  var folders = DriveApp.getFoldersByName(options.folder);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(options.folder);
  var file = folder.createFile(blob);

  return {
    fileId: file.getId(),
    fileName: stamped,
    fileUrl: file.getUrl(),
    mimeType: mimeType,
    sizeBytes: bytes.length
  };
}

/** The record a document is being attached to, refused if it is not one we know. */
function documentOwner_(recordType, recordId) {
  var tab = { SalesOrder: 'SalesOrders', Invoice: 'Invoices' }[recordType];
  if (!tab) throw new Error('Documents cannot be attached to a ' + recordType + '.');
  var row = findRowById_(tab, recordId);
  if (!row) throw new Error('That record is no longer there.');
  return { tab: tab, row: row };
}

/** Attaches a purchase order, a tax invoice or whatever else arrived, to a record. */
function saveDocument(input) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Documents');
  requireRole_(user, DOC_EDITORS);

  var recordType = String((input && input.recordType) || '');
  var recordId = String((input && input.recordId) || '');
  var owner = documentOwner_(recordType, recordId);
  requireStream_(user, owner.row.businessStream, 'This record');

  var docType = String((input && input.docType) || '').trim();
  var known = DOC_TYPES[recordType] || [];
  if (known.indexOf(docType) === -1) {
    throw new Error('Pick what this document is: ' + known.join(', ') + '.');
  }

  var label = docType + ' ' +
    String(owner.row.orderNo || owner.row.invoiceNo || recordId);
  var stored = storeDriveFile_({
    input: input,
    folder: DOC_FOLDER,
    label: label,
    maxBytes: DOC_MAX_BYTES,
    typeMessage: 'Attach a PDF or a photograph of the document.'
  });

  var row = {
    id: generateId_('DOC-'),
    recordType: recordType,
    recordId: recordId,
    docType: docType,
    fileId: stored.fileId,
    fileName: stored.fileName,
    fileUrl: stored.fileUrl,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    caption: String((input && input.caption) || '').trim(),
    uploadedBy: user.email,
    uploadedAt: new Date().toISOString()
  };
  appendRow_('Documents', row, docType + ' attached');

  // The old text box is where anything already pasted lives, and a link there while a file
  // sits here reads as two versions of the same thing. The upload wins.
  if (recordType === 'SalesOrder' && docType === 'Purchase Order') {
    updateRowById_('SalesOrders', 'id', recordId, { poAttachmentUrl: stored.fileUrl },
      'Purchase order attached');
  }
  return stripRow_(row);
}

/** Everything attached to one record, oldest first. */
function listDocuments(recordType, recordId) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Documents');
  // Missing on a Sheet set up before this build; nothing attached is the honest answer.
  var rows;
  try {
    rows = findRowsByColumn_('Documents', 'recordId', [String(recordId)]);
  } catch (err) {
    return [];
  }
  return rows
    .filter(function (d) { return String(d.recordType) === String(recordType); })
    .map(stripRow_)
    .sort(function (a, b) { return String(a.uploadedAt).localeCompare(String(b.uploadedAt)); });
}

/** Removes a document. The Drive file goes to the bin rather than being destroyed. */
function deleteDocument(documentId) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Documents');
  requireRole_(user, DOC_EDITORS);

  var doc = findRowById_('Documents', documentId);
  if (!doc) throw new Error('That document is no longer there.');
  var owner = documentOwner_(doc.recordType, doc.recordId);
  requireStream_(user, owner.row.businessStream, 'This record');

  try {
    DriveApp.getFileById(doc.fileId).setTrashed(true);
  } catch (err) {
    // The row goes either way: a link to a file somebody already deleted is worse than none.
  }
  deleteRowById_('Documents', 'id', documentId, doc.docType + ' removed');

  // Only clear the order's link if it was this file's.
  if (doc.recordType === 'SalesOrder' && String(owner.row.poAttachmentUrl) === String(doc.fileUrl)) {
    updateRowById_('SalesOrders', 'id', doc.recordId, { poAttachmentUrl: '' },
      'Purchase order removed');
  }
  return { deleted: String(documentId) };
}

/** The document types the screen may offer for a record. */
function documentTypesFor(recordType) {
  getCurrentUser();
  return (DOC_TYPES[recordType] || []).slice();
}
