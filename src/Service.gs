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

  return storeProof_('DeliveryProofs', 'dispatchId', dispatchId,
    String(dispatch.dispatchNo || dispatchId), input, user);
}

/**
 * The photograph of a finished service job.
 *
 * An installation is complete when the customer says it is. The engineer's word is the report;
 * the customer's photograph is what makes the report evidence rather than an assertion.
 */
function saveServiceProof(serviceJobId, input) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES);

  var job = findRowById_('ServiceJobs', serviceJobId);
  if (!job) throw new Error('Service job not found.');

  return storeProof_('ServiceProofs', 'serviceJobId', serviceJobId,
    String(job.jobNo || serviceJobId), input, user);
}

/**
 * Decodes one photograph, writes it to Drive and keeps the link.
 *
 * The Drive half of this now lives in Documents.gs, shared with the purchase orders and tax
 * invoices that arrive from customers — they are the same operation, and a size limit or a
 * file-name rule changed in one place should hold for every attachment in the system.
 */
function storeProof_(tabName, keyField, keyValue, label, input, user) {
  var stored = storeDriveFile_({
    input: input,
    folder: POD_FOLDER,
    label: label,
    maxBytes: POD_MAX_BYTES,
    rejectMessage: 'That file could not be read as an image.',
    typeMessage: 'A proof of delivery should be a photograph or a PDF.'
  });

  var row = {
    id: generateId_('PRF-'),
    fileId: stored.fileId,
    fileName: stored.fileName,
    fileUrl: stored.fileUrl,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    caption: String((input && input.caption) || '').trim(),
    uploadedBy: user.email,
    uploadedAt: new Date().toISOString()
  };
  row[keyField] = String(keyValue);
  appendRow_(tabName, row, 'Proof photograph stored');
  return row;
}

/** The proofs held against a dispatch, oldest first. */
function listPodPhotos(dispatchId) {
  getCurrentUser();
  return findRowsByColumn_('DeliveryProofs', 'dispatchId', [String(dispatchId)])
    .map(stripRow_)
    .sort(function (a, b) { return String(a.uploadedAt).localeCompare(String(b.uploadedAt)); });
}

/** The photographs held against a service job, oldest first. */
function listServiceProofs(serviceJobId) {
  getCurrentUser();
  return findRowsByColumn_('ServiceProofs', 'serviceJobId', [String(serviceJobId)])
    .map(stripRow_)
    .sort(function (a, b) { return String(a.uploadedAt).localeCompare(String(b.uploadedAt)); });
}

/** Removes a proof. The Drive file goes to the bin rather than being destroyed. */
function deletePodPhoto(proofId) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);
  var proof = findRowById_('DeliveryProofs', proofId);
  if (!proof) throw new Error('That proof is no longer there.');
  dropProofFile_('DeliveryProofs', proof);
  return listPodPhotos(proof.dispatchId);
}

function deleteServiceProof(proofId) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES);
  var proof = findRowById_('ServiceProofs', proofId);
  if (!proof) throw new Error('That proof is no longer there.');
  var job = findRowById_('ServiceJobs', proof.serviceJobId);
  if (job && job.status === 'Completed') {
    throw new Error('This job is closed. Its photographs are part of the service report and ' +
      'stay with it.');
  }
  dropProofFile_('ServiceProofs', proof);
  return listServiceProofs(proof.serviceJobId);
}

function dropProofFile_(tabName, proof) {
  try {
    DriveApp.getFileById(proof.fileId).setTrashed(true);
  } catch (err) {
    // The row goes either way: a link to a file somebody already deleted is worse than none.
  }
  deleteRowById_(tabName, 'id', proof.id, 'Proof photograph removed');
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
  var contact = customerContactFor_(order, customer);

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
    jobType: 'Installation',
    urgency: 'Normal',
    reportedBy: '',
    contactName: contact.name,
    contactPhone: contact.phone,
    contactEmail: contact.email,
    handedOverBy: user.email,
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

/**
 * Logs a breakdown call.
 *
 * Not every job follows a delivery. A customer rings to say a machine has stopped, and that
 * needs the same engineer, the same allocation and the same record as an installation — but
 * it arrives with nothing behind it: no dispatch, no parts, often not even a serial number
 * until somebody is standing in front of the machine. So this asks for what a phone call can
 * actually supply and no more.
 *
 * Anybody who can see service jobs can raise one, because a breakdown call lands on whichever
 * phone happens to ring. Deciding who goes is still the service coordinator's, so the job
 * starts unassigned however it was raised.
 */
function createServiceJob(input) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES);

  var customerId = String((input && input.customerId) || '').trim();
  if (!customerId) throw new Error('Pick the customer whose machine has stopped.');
  var customer = findRowById_('Customers', customerId);
  if (!customer) throw new Error('That customer is no longer there.');

  var scope = String((input && input.scopeText) || '').trim();
  if (!scope) throw new Error('Say what the problem is — the engineer is going on this alone.');

  var urgency = String((input && input.urgency) || 'Normal').trim();
  if (SERVICE_URGENCIES.indexOf(urgency) === -1) {
    throw new Error('Urgency must be one of: ' + SERVICE_URGENCIES.join(', ') + '.');
  }

  var job = {
    id: generateId_('SVJ-'),
    jobNo: nextSeriesNo_('ServiceJobs', 'jobNo', 'SVJ'),
    date: todayIso_(),
    dispatchId: '',
    salesOrderId: '',
    customerId: customerId,
    customerName: String(customer.name || ''),
    machineModel: String((input && input.machineModel) || '').trim(),
    serialNo: String((input && input.serialNo) || '').trim(),
    siteAddressId: String((input && input.siteAddressId) || '').trim(),
    engineerEmail: '',
    status: 'Unassigned',
    jobType: 'Breakdown',
    urgency: urgency,
    reportedBy: String((input && input.reportedBy) || '').trim(),
    contactName: String((input && input.contactName) || '').trim(),
    contactPhone: String((input && input.contactPhone) || '').trim(),
    contactEmail: String((input && input.contactEmail) || '').trim(),
    handedOverBy: user.email,
    scopeText: scope,
    scheduledDate: '',
    completedDate: '',
    notes: ''
  };
  appendRow_('ServiceJobs', job, 'Breakdown call logged');
  return getServiceJob(job.id);
}

/**
 * The person service should ring.
 *
 * The quotation names a contact if one was chosen when the offer was raised; failing that the
 * customer's primary contact is the right guess, and failing that anybody active on the
 * record beats handing service a job with no phone number on it.
 */
function customerContactFor_(order, customer) {
  var blank = { name: '', phone: '', email: '' };
  if (!customer) return blank;

  // A phone number is worth having and is never worth failing a delivery over, so everything
  // here degrades to blank rather than throwing.
  var chosen = null;
  try {
    var quote = order && order.quotationId ? findRowById_('Quotations', order.quotationId) : null;
    chosen = quote && quote.contactId ? findRowById_('CustomerContacts', quote.contactId) : null;

    if (!chosen) {
      var contacts = findRowsByColumn_('CustomerContacts', 'customerId', [String(customer.id)])
        .filter(function (c) { return String(c.active).toUpperCase() !== 'FALSE'; });
      chosen = contacts.filter(function (c) {
        return String(c.isPrimary).toUpperCase() === 'TRUE';
      })[0] || contacts[0] || null;
    }
  } catch (err) {
    return blank;
  }
  if (!chosen) return blank;
  return {
    name: String(chosen.name || ''),
    phone: String(chosen.phone || ''),
    email: String(chosen.email || '')
  };
}

/**
 * Hands a job back the other way: the engineer found something that has to be quoted.
 *
 * PIE's spares almost never sell at installation. They sell later — a part fails, or starts
 * making a noise — and from there it is the ordinary spares run: enquiry, quotation to the
 * customer, their signature, then an engineer goes out to fit it. That run already exists.
 * What did not exist was the join: somebody closed the service job and then retyped the
 * customer and the machine into the Spare Sales screen from memory.
 *
 * The enquiry it raises belongs to Spare Sales, not to whoever pressed the button. Service
 * cannot see spare enquiries and should not: they are reporting that parts are needed, not
 * taking the sale. So it goes in unassigned, for a spares coordinator to pick up, and the
 * raiser is told the number so they can say which one they mean.
 */
function raiseSpareEnquiryFromServiceJob(serviceJobId, input) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES);

  var job = findRowById_('ServiceJobs', serviceJobId);
  if (!job) throw new Error('Service job not found.');

  var need = String((input && input.requirementText) || '').trim();
  if (!need) {
    throw new Error('Say what the machine needs. A spares coordinator has to quote from this.');
  }
  if (job.spareEnquiryId) {
    var already = findRowById_('SpareEnquiries', job.spareEnquiryId);
    if (already) {
      throw new Error('This visit already raised enquiry ' + already.enquiryNo +
        '. Add to that one rather than starting a second.');
    }
  }

  var urgency = String((input && input.urgency) || job.urgency || 'Normal').trim();
  if (SERVICE_URGENCIES.indexOf(urgency) === -1) urgency = 'Normal';

  // Written straight rather than through saveSpareEnquiry, which refuses anybody outside
  // Spare Sales — correctly, for an ordinary enquiry. This one is a handover, not a sale.
  var enquiry = {
    id: generateId_('SE-'),
    enquiryNo: nextEnquiryNo_(),
    date: todayIso_(),
    customerId: String(job.customerId || ''),
    customerName: String(job.customerName || ''),
    contactName: String(job.contactName || ''),
    productModel: String(job.machineModel || ''),
    serialNo: String(job.serialNo || ''),
    installedBaseId: '',
    requirementText: need,
    urgency: urgency,
    source: 'Service visit ' + String(job.jobNo || ''),
    ownerEmail: '',
    serviceJobId: String(job.id),
    status: 'New',
    // Nobody has promised the customer a date yet — the engineer has only said which parts
    // are wanted. Stamping today's date here would have the enquiry reading as late by
    // tomorrow morning.
    expectedDeliveryDate: '',
    lostReasonId: '',
    businessStream: STREAM_SPARE,
    brand: 'ELGI',
    createdAt: todayIso_(),
    createdBy: user.email
  };
  appendRow_('SpareEnquiries', enquiry, 'Raised from service job ' + job.jobNo);

  updateRowById_('ServiceJobs', 'id', serviceJobId, { spareEnquiryId: enquiry.id },
    'Spare enquiry ' + enquiry.enquiryNo + ' raised from this visit');

  return { id: enquiry.id, enquiryNo: enquiry.enquiryNo, customerName: enquiry.customerName };
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
  if (opts.jobType) {
    rows = rows.filter(function (j) {
      return String(j.jobType || 'Installation') === opts.jobType;
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
  // Rows raised before breakdown calls existed are installations; that is what they were.
  rows.forEach(function (j) {
    j.partCount = counts[String(j.id)] || 0;
    j.jobType = String(j.jobType || 'Installation');
    j.urgency = String(j.urgency || 'Normal');
  });

  return rows.sort(function (a, b) {
    return String(b.date + b.jobNo).localeCompare(String(a.date + a.jobNo));
  });
}

function getServiceJob(id) {
  getCurrentUser();
  var job = findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  var row = stripRow_(job);
  row.jobType = String(row.jobType || 'Installation');
  row.urgency = String(row.urgency || 'Normal');
  row.items = findRowsByColumn_('ServiceJobItems', 'serviceJobId', [String(id)])
    .map(stripRow_)
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });
  // Two different photographs, and they answer different questions: the delivery one says the
  // goods arrived, the service one says the work was finished and accepted.
  row.deliveryProofs = row.dispatchId ? listPodPhotos(row.dispatchId) : [];
  row.proofs = listServiceProofs(id);
  // Service cannot open a spare enquiry, so the number is all they get — and all they need,
  // since it is the spares office that carries it from here.
  var raised = row.spareEnquiryId ? findRowById_('SpareEnquiries', row.spareEnquiryId) : null;
  row.spareEnquiryNo = raised ? String(raised.enquiryNo || '') : '';
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

  // An installation is complete when the customer says so. Without their photograph the
  // report is the engineer's word for it, which is what PIE asked not to rely on.
  if (status === 'Completed' && !listServiceProofs(id).length) {
    throw new Error('Add the photograph of the finished work before closing this job \u2014 ' +
      'it is what the service report stands on.');
  }

  var patch = { status: status };
  if (status === 'Completed') patch.completedDate = todayIso_();
  if (String(notes || '').trim()) patch.notes = String(notes).trim();
  updateRowById_('ServiceJobs', 'id', id, patch, 'Service job set to ' + status);
  return getServiceJob(id);
}
