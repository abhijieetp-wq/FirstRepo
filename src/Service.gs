/**
 * What happens after the lorry arrives.
 *
 * PIE's process ends in two steps the ERP could not record. The customer sends back a
 * photograph on WhatsApp — that photograph is the proof of delivery, and a reference typed
 * into a cell is not evidence of anything. And once the goods are known to have arrived, a
 * service engineer is told to go and fit them; `serviceNotified` existed on the dispatch for
 * exactly this and nothing in the system ever set it.
 *
 * So a proof is a file, kept in Drive with a row pointing at it, and the service handoff is a
 * job with a named engineer, the machine it is for, and the parts to be fitted.
 */

var POD_FOLDER = 'ERP Delivery Proofs';
var POD_MAX_BYTES = 8 * 1024 * 1024;
var SERVICE_ROLES = [ROLES.SALES_COORDINATOR, ROLES.SERVICE_COORDINATOR,
  ROLES.SERVICE_ENGINEER, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
// Allocating the engineer is the service coordinator's job. The sales coordinator's part is
// to tell them the delivery has landed — which is what confirming the delivery now does.
var SERVICE_ASSIGNERS = [ROLES.SERVICE_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/**
 * Stores one proof-of-delivery photograph against a dispatch.
 *
 * The browser has already scaled it down; this decodes it, writes it to Drive and keeps the
 * link. The file is not put in the sheet — a photograph in a cell is how a spreadsheet stops
 * opening.
 */
function savePodPhoto(dispatchId, input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = findRowById_('Dispatches', dispatchId);
  if (!dispatch) throw new Error('Dispatch not found.');

  var dataUrl = String((input && input.dataUrl) || '');
  var match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('That file could not be read as an image.');
  var mimeType = match[1];
  if (mimeType.indexOf('image/') !== 0 && mimeType !== 'application/pdf') {
    throw new Error('A proof of delivery should be a photograph or a PDF.');
  }

  var bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > POD_MAX_BYTES) {
    throw new Error('That file is too large. Send a photograph rather than a full-resolution scan.');
  }

  var name = String((input && input.name) || 'proof').replace(/[\/\\:*?"<>|]/g, '-');
  var stamped = String(dispatch.dispatchNo || dispatchId) + ' ' + todayIso_() + ' ' + name;
  var blob = Utilities.newBlob(bytes, mimeType, stamped);

  var folders = DriveApp.getFoldersByName(POD_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(POD_FOLDER);
  var file = folder.createFile(blob);

  var row = {
    id: generateId_('POD-'),
    dispatchId: String(dispatchId),
    fileId: file.getId(),
    fileName: stamped,
    fileUrl: file.getUrl(),
    mimeType: mimeType,
    sizeBytes: bytes.length,
    caption: String((input && input.caption) || '').trim(),
    uploadedBy: user.email,
    uploadedAt: new Date().toISOString()
  };
  appendRow_('DeliveryProofs', row, 'Proof of delivery stored');
  return row;
}

/** The proofs held against a dispatch, oldest first. */
function listPodPhotos(dispatchId) {
  getCurrentUser();
  return findRowsByColumn_('DeliveryProofs', 'dispatchId', [String(dispatchId)])
    .map(stripRow_)
    .sort(function (a, b) { return String(a.uploadedAt).localeCompare(String(b.uploadedAt)); });
}

/** Removes a proof. The Drive file goes to the bin rather than being destroyed. */
function deletePodPhoto(proofId) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);
  var proof = findRowById_('DeliveryProofs', proofId);
  if (!proof) throw new Error('That proof is no longer there.');
  try {
    DriveApp.getFileById(proof.fileId).setTrashed(true);
  } catch (err) {
    // The row goes either way: a link to a file somebody already deleted is worse than none.
  }
  deleteRowById_('DeliveryProofs', 'id', proofId, 'Proof of delivery removed');
  return listPodPhotos(proof.dispatchId);
}

/**
 * Raises the service job for a confirmed delivery.
 *
 * Called when delivery is confirmed, which is the moment PIE say the enquiry goes to the
 * service engineer. The parts come off the dispatch rather than being retyped, because the
 * engineer needs to know what actually arrived, not what was ordered.
 *
 * Idempotent: confirming a delivery twice must not raise two jobs.
 */
function raiseServiceJob_(dispatch, engineerEmail, user) {
  var existing = findRowsByColumn_('ServiceJobs', 'dispatchId', [String(dispatch.id)])
    .filter(function (j) { return j.status !== 'Cancelled'; })[0];
  if (existing) return stripRow_(existing);

  var order = dispatch.salesOrderId ? findRowById_('SalesOrders', dispatch.salesOrderId) : null;
  var customer = order && order.customerId ? findRowById_('Customers', order.customerId) : null;
  var quote = order && order.quotationId ? findRowById_('Quotations', order.quotationId) : null;

  // Sales do not pick the engineer; they raise the need. The job starts unassigned and waits
  // for the service coordinator — a name offered by somebody not entitled to allocate is
  // dropped rather than refused, because the delivery is still a fact worth recording.
  var engineer = String(engineerEmail || '').trim();
  if (engineer && SERVICE_ASSIGNERS.indexOf(user.role) === -1) engineer = '';
  var job = {
    id: generateId_('SVJ-'),
    jobNo: nextSeriesNo_('ServiceJobs', 'jobNo', 'SVJ'),
    date: todayIso_(),
    dispatchId: String(dispatch.id),
    salesOrderId: String(dispatch.salesOrderId || ''),
    customerId: order ? String(order.customerId || '') : '',
    customerName: customer ? String(customer.name || '') : '',
    machineModel: quote ? String(quote.machineModel || '') : '',
    serialNo: quote ? String(quote.serialNo || '') : '',
    siteAddressId: order ? String(order.shippingAddressId || '') : '',
    engineerEmail: engineer,
    status: engineer ? 'Assigned' : 'Unassigned',
    scopeText: 'Fit the parts delivered on ' + String(dispatch.dispatchNo || '') + '.',
    scheduledDate: '',
    completedDate: '',
    notes: ''
  };
  appendRow_('ServiceJobs', job, 'Service job raised on delivery confirmation');

  var lines = findRowsByColumn_('DispatchItems', 'dispatchId', [String(dispatch.id)])
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });
  var items = lines.map(function (l, i) {
    return {
      id: generateId_('SVI-'),
      serviceJobId: job.id,
      lineNo: i + 1,
      itemType: String(l.itemType || ''),
      itemId: String(l.itemId || ''),
      itemCode: String(l.itemCode || ''),
      description: String(l.description || ''),
      qty: Number(l.qtyDispatched) || 0
    };
  });
  if (items.length) appendRows_('ServiceJobItems', items, 'Parts carried onto the service job');

  return job;
}

function listServiceJobs(options) {
  var user = getCurrentUser();
  var opts = options || {};
  var rows = readTable_('ServiceJobs').map(stripRow_);

  if (opts.mineOnly) {
    rows = rows.filter(function (j) {
      return String(j.engineerEmail).toLowerCase() === user.email.toLowerCase();
    });
  }
  if (!opts.includeClosed) {
    rows = rows.filter(function (j) {
      return ['Completed', 'Cancelled'].indexOf(j.status) === -1;
    });
  }
  // How many parts, without opening every job: one read of the whole child table beats one
  // read per row on screen.
  var counts = {};
  readTable_('ServiceJobItems').forEach(function (i) {
    var k = String(i.serviceJobId);
    counts[k] = (counts[k] || 0) + 1;
  });
  rows.forEach(function (j) { j.partCount = counts[String(j.id)] || 0; });

  return rows.sort(function (a, b) {
    return String(b.date + b.jobNo).localeCompare(String(a.date + a.jobNo));
  });
}

function getServiceJob(id) {
  getCurrentUser();
  var job = findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  var row = stripRow_(job);
  row.items = findRowsByColumn_('ServiceJobItems', 'serviceJobId', [String(id)])
    .map(stripRow_)
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });
  row.proofs = row.dispatchId ? listPodPhotos(row.dispatchId) : [];
  return row;
}

/** Names the engineer who is going. */
function assignServiceJob(id, engineerEmail, scheduledDate) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS);
  var job = findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  var engineer = String(engineerEmail || '').trim();
  if (!engineer) throw new Error('Pick the service engineer who is going.');

  updateRowById_('ServiceJobs', 'id', id, {
    engineerEmail: engineer,
    scheduledDate: String(scheduledDate || '').slice(0, 10),
    status: job.status === 'Unassigned' ? 'Assigned' : job.status
  }, 'Service job assigned to ' + engineer);
  return getServiceJob(id);
}

function setServiceJobStatus(id, status, notes) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES);
  if (SERVICE_JOB_STATUSES.indexOf(status) === -1) {
    throw new Error('Status must be one of: ' + SERVICE_JOB_STATUSES.join(', ') + '.');
  }
  var job = findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  if (status !== 'Unassigned' && status !== 'Cancelled' && !String(job.engineerEmail).trim()) {
    throw new Error('Name the engineer before moving this job on.');
  }

  var patch = { status: status };
  if (status === 'Completed') patch.completedDate = todayIso_();
  if (String(notes || '').trim()) patch.notes = String(notes).trim();
  updateRowById_('ServiceJobs', 'id', id, patch, 'Service job set to ' + status);
  return getServiceJob(id);
}
