/**
 * Converted from src/QuotationProgress.gs by migration/to-async.js.
 *
 * Only two things changed: functions that reach storage are `async`, and the calls that
 * reach it are `await`ed. Everything else — the logic, the names, the comments — is the
 * original, because the original is the specification and reformatting it would make the
 * diff unreadable at exactly the moment it needs to be read.
 *
 * Storage comes from server/shim.js, which keeps the old names (`readTable_`,
 * `appendRow_`) pointing at db.js. If this file is edited from here on, edit this one —
 * the .gs original stays frozen at the point of conversion so the live portal keeps running.
 */
/**
 * One quotation, from the enquiry that started it to the money that came back.
 *
 * Every screen in this system shows one step. All Quotations shows where an offer has got to
 * but not how it got there; the order screen shows the purchase order but not what was
 * quoted; the versions window shows revisions but not what happened after. Somebody asking
 * "why is this one still open, and who has it?" had to open four screens and hold the answer
 * in their head.
 *
 * This assembles the whole chain in one call: who prepared and who approved, every revision
 * and what became of it, the purchase order with the document the customer actually sent,
 * the order, the dispatches, the invoices and the receipts against them. It reads, and
 * changes nothing — it is the screen you send somebody to when the question is "what
 * happened", not "what next".
 *
 * Read once, joined in memory. A page that fires nine server calls to answer one question is
 * a page nobody waits for, and the tables here are the same handful the dashboard already
 * reads whole.
 */

/** Everyone on the commercial side may read a progress trail; nobody may change one here. */
async function getQuotationProgress(quotationId) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Quotation progress');

  var quotations = await readTable_('Quotations');
  var quote = quotations.filter(function (q) {
    return String(q.id) === String(quotationId);
  })[0];
  if (!quote) throw new Error('That quotation no longer exists.');
  requireStream_(user, quote.businessStream, 'This quotation');

  // The whole family, so "how many times was it revised" is answerable from the one the
  // person happened to open, whichever revision that is.
  var rootId = String(quote.parentQuotationId || quote.id);
  var family = quotations.filter(function (q) {
    return String(q.id) === rootId || String(q.parentQuotationId) === rootId;
  }).sort(function (a, b) {
    return revisionNo_(a) - revisionNo_(b);
  });
  var familyIds = family.map(function (q) { return String(q.id); });
  var current = family.filter(function (q) {
    return revisionNo_(q) === revisionNo_(family[family.length - 1]);
  })[0] || quote;

  var journeyIdx = await journeyIndex_(familyIds);
  var names = await userNameMap_();

  // ---------------------------------------------------------------- the offer itself
  var customer = (await readTable_('Customers')).filter(function (c) {
    return String(c.id) === String(current.customerId);
  })[0];

  var enquiry = current.spareEnquiryId
    ? (await readTable_('SpareEnquiries')).filter(function (e) {
        return String(e.id) === String(current.spareEnquiryId);
      })[0]
    : null;
  var opportunity = current.opportunityId
    ? (await readTable_('Opportunities')).filter(function (o) {
        return String(o.id) === String(current.opportunityId);
      })[0]
    : null;

  // ---------------------------------------------------------------- what came after
  // Any revision of the offer could be the one that was converted, so the order is looked up
  // against the whole family rather than against the revision somebody happened to open.
  var order = (await readTable_('SalesOrders')).filter(function (o) {
    return familyIds.indexOf(String(o.quotationId)) !== -1;
  })[0] || null;

  var orderLines = order
    ? (await readTable_('SalesOrderItems')).filter(function (l) {
        return String(l.salesOrderId) === String(order.id);
      }).sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    : [];

  var dispatches = order
    ? (await readTable_('Dispatches')).filter(function (d) {
        return String(d.salesOrderId) === String(order.id);
      })
    : [];

  var invoices = order
    ? (await readTable_('Invoices')).filter(function (i) {
        return String(i.salesOrderId) === String(order.id);
      })
    : [];
  var invoiceIds = invoices.map(function (i) { return String(i.id); });
  var receipts = invoiceIds.length
    ? (await readTable_('Receipts')).filter(function (r) {
        return invoiceIds.indexOf(String(r.invoiceId)) !== -1;
      })
    : [];

  // The customer's own paperwork. Read directly rather than through listDocuments, which
  // checks a permission this function has already checked once.
  var documents = order ? await documentsFor_('SalesOrder', order.id) : [];

  return {
    quotationId: String(current.id),
    quoteNo: String(current.quoteNo || ''),
    businessStream: String(current.businessStream || ''),
    customerName: customer ? String(customer.name) : String(current.customerName || ''),
    journey: await quotationJourney_(current, journeyIdx),

    // ------------------------------------------------------------ where it began
    origin: enquiry
      ? { kind: 'Spare enquiry', ref: String(enquiry.enquiryNo || ''),
          date: String(enquiry.date || ''), id: String(enquiry.id),
          who: String(enquiry.contactName || ''),
          detail: String(enquiry.requirementText || '') }
      : (opportunity
          ? { kind: 'Opportunity', ref: String(opportunity.opportunityNo || ''),
              date: String(opportunity.createdAt || '').slice(0, 10),
              id: String(opportunity.id), who: '',
              detail: String(opportunity.title || '') }
          : null),

    // ------------------------------------------------------------ who did what
    // Names rather than addresses: these are personal addresses on this installation, and a
    // progress page is read over somebody's shoulder more than most screens.
    preparedBy: personLine_(current.preparedBy, names),
    preparedAt: String(current.createdAt || current.date || ''),
    approvedBy: personLine_(current.approvedBy, names),
    approvedAt: String(current.approvalDate || ''),
    // An offer that reached the customer unapproved cannot happen now, but one sent before
    // that rule existed still reads honestly rather than claiming an approver it never had.
    approved: !!String(current.approvalDate || '').trim(),
    sentAt: String(current.submittedDate || current.emailSentDate || ''),
    status: String(current.status || ''),
    lostReason: current.lostReasonId ? await lostReasonText_(current.lostReasonId) : '',

    // ------------------------------------------------------------ the revisions
    revisions: family.map(function (q) {
      return {
        id: String(q.id),
        revision: String(q.revision || 'R0'),
        date: String(q.date || ''),
        status: String(q.status || ''),
        grand: payableTotal_(q),
        preparedBy: personLine_(q.preparedBy, names),
        revisionReason: String(q.revisionReason || ''),
        approvedBy: personLine_(q.approvedBy, names),
        approvalDate: String(q.approvalDate || ''),
        superseded: String(q.id) !== String(current.id),
        isCurrent: String(q.id) === String(current.id)
      };
    }),
    revisionCount: Math.max(0, family.length - 1),

    // ------------------------------------------------------------ the order
    order: order ? {
      id: String(order.id),
      orderNo: String(order.orderNo || ''),
      date: String(order.date || ''),
      status: String(order.orderStatus || ''),
      grand: Number(order.grand) || 0,
      poNo: String(order.poNo || ''),
      poDate: String(order.poDate || ''),
      poValue: order.poValue === '' ? null : Number(order.poValue),
      poVerified: String(order.poVerified).toUpperCase() === 'TRUE',
      poVarianceNotes: String(order.poVarianceNotes || ''),
      creditHold: String(order.creditHold).toUpperCase() === 'TRUE',
      creditHoldReason: String(order.creditHoldReason || ''),
      promisedDispatchDate: String(order.promisedDispatchDate || ''),
      despatchThrough: String(order.despatchThrough || ''),
      destination: String(order.destination || ''),
      deliveryTerms: String(order.deliveryTerms || ''),
      paymentTerms: String(order.paymentTerms || ''),
      paymentMode: String(order.paymentMode || ''),
      lines: orderLines.map(function (l) {
        return { lineNo: Number(l.lineNo) || 0, itemCode: String(l.itemCode || ''),
                 description: String(l.description || ''), qty: Number(l.qty) || 0,
                 uom: String(l.uom || ''), dueDays: l.dueDays === '' ? null : Number(l.dueDays),
                 qtyDispatched: Number(l.qtyDispatched) || 0,
                 qtyInvoiced: Number(l.qtyInvoiced) || 0 };
      })
    } : null,

    // ------------------------------------------------------------ the paperwork
    documents: documents.map(function (d) {
      return { id: String(d.id), docType: String(d.docType || ''),
               fileName: String(d.fileName || ''), fileUrl: String(d.fileUrl || ''),
               caption: String(d.caption || ''),
               uploadedBy: personLine_(d.uploadedBy, names),
               uploadedAt: String(d.uploadedAt || '').slice(0, 10) };
    }),

    dispatches: dispatches.map(function (d) {
      return { id: String(d.id), dispatchNo: String(d.dispatchNo || ''),
               date: String(d.dispatchDate || ''), status: String(d.status || ''),
               lrNo: String(d.lrNumber || ''), transporter: String(d.transporterName || ''),
               challanNo: String(d.deliveryChallanNo || ''),
               delivered: String(d.deliveryConfirmed).toUpperCase() === 'TRUE',
               deliveredDate: String(d.deliveryConfirmedDate || '') };
    }),

    invoices: invoices.map(function (i) {
      var paid = receipts.filter(function (r) {
        return String(r.invoiceId) === String(i.id);
      }).reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);
      var grand = billedAmount_(i);
      return { id: String(i.id), invoiceNo: String(i.invoiceNo || ''),
               date: String(i.invoiceDate || ''), status: String(i.status || ''),
               grand: grand, received: roundMoney_(paid),
               balance: roundMoney_(grand - paid),
               dueDate: String(i.dueDate || '') };
    }),

    receipts: receipts.map(function (r) {
      return { id: String(r.id), date: String(r.receiptDate || ''),
               amount: Number(r.amount) || 0, mode: String(r.mode || ''),
               reference: String(r.reference || '') };
    })
  };
}

/** The number in 'R2'. Used for ordering a family and finding its newest member. */
function revisionNo_(q) {
  return Number(String((q && q.revision) || 'R0').replace(/[^0-9]/g, '')) || 0;
}

/** email → name, for every user on file, so the page can name people rather than address them. */
async function userNameMap_() {
  var out = {};
  (await readTable_('Users')).forEach(function (u) {
    var email = String(u.email || '').toLowerCase();
    if (email) out[email] = String(u.name || '').trim();
  });
  return out;
}

/**
 * How a person is shown on this page.
 *
 * The name where we know it, the address only where we do not — the same rule the pickers
 * follow, and for the same reason: these are personal addresses, and a progress page invites
 * being read over somebody's shoulder.
 */
function personLine_(email, names) {
  var raw = String(email || '').trim();
  if (!raw) return '';
  return names[raw.toLowerCase()] || raw;
}

// lostReasonText_ is not redefined here. QuotationJourney.gs already has one, and a second
// declaration of the same name does not collide loudly in Apps Script — the later file
// silently replaces the earlier, taking its try/catch for a missing LostReasons tab with it.
// That is how the compressor Pipeline tab was broken for months, and it was reintroduced here
// within a day of being fixed. dupfn-test now walks the .gs files as well as the client.

/** Documents against one record, without re-checking a permission the caller already held. */
async function documentsFor_(recordType, recordId) {
  var rows;
  try {
    rows = await findRowsByColumn_('Documents', 'recordId', [String(recordId)]);
  } catch (err) {
    // A sheet set up before the Documents tab existed. Nothing attached is the honest answer.
    return [];
  }
  return rows
    .filter(function (d) { return String(d.recordType) === String(recordType); })
    .map(stripRow_)
    .sort(function (a, b) { return String(a.uploadedAt).localeCompare(String(b.uploadedAt)); });
}

/**
 * The offers a progress page can be opened on, newest first.
 *
 * Only the live revision of each family: opening the progress of a superseded revision would
 * show the same chain under an older number, which is the confusion All Quotations was just
 * cleared of.
 *
 * Each row also says who created the offer and where it has got to, so the list answers the
 * two questions people opened it for without opening every trail. "Created by" is the person
 * who raised the original offer; when somebody else made the live revision they are named
 * too, because both are answers to "whose quotation is this".
 */
async function listProgressCandidates() {
  var user = getCurrentUser();
  requireCommercial_(user, 'Quotation progress');
  return (await progressRows_(user)).map(function (r) {
    return {
      id: r.id, quoteNo: r.quoteNo, revision: r.revision, date: r.date, status: r.status,
      businessStream: r.businessStream, customerName: r.customerName, grand: r.grand,
      createdBy: r.createdBy, revisedBy: r.revisedBy, stage: r.stage,
      lostReason: r.lostReason
    };
  });
}

/**
 * Every live offer, as a table to download: where each one stands and why.
 *
 * The same rows as the list, with everything the trail would say about each — the approval,
 * the dates it moved, the reason and the competitor when it was declined, the order and the
 * money. Built here rather than by opening every trail, which would be one call per offer.
 * The browser turns it into the file, so nothing is written anywhere on the way.
 */
var PROGRESS_EXPORT_COLUMNS_ = [
  ['quoteNo', 'Quote No.'], ['revision', 'Revision'], ['businessStream', 'Stream'],
  ['date', 'Quote date'], ['validUntil', 'Valid until'], ['customerName', 'Customer'],
  ['grand', 'Quoted value (Rs)'], ['statusLabel', 'Status'], ['stage', 'Progress'],
  ['nextStep', 'Next step'], ['createdBy', 'Created by'], ['revisedBy', 'Live revision by'],
  ['revisionCount', 'Times revised'], ['revisionReason', 'Latest revision reason'],
  ['approvedBy', 'Approved by'], ['approvalDate', 'Approved on'], ['sentDate', 'Sent on'],
  ['wonDate', 'Accepted on'], ['lostDate', 'Declined on'], ['lostReason', 'Reason for decline'],
  ['lostNotes', 'What the customer said'], ['lostToCompetitor', 'Lost to'],
  ['lostAtPrice', 'Their price (Rs)'], ['orderNo', 'Sales order'], ['poNo', 'Customer PO'],
  ['orderStatus', 'Order status'], ['invoiced', 'Invoiced (Rs)'], ['received', 'Received (Rs)'],
  ['balance', 'Balance due (Rs)']
];

async function exportQuotationProgress() {
  var user = getCurrentUser();
  requireCommercial_(user, 'Quotation progress');
  var rows = await progressRows_(user);
  return {
    generatedAt: nowIso_(),
    headers: PROGRESS_EXPORT_COLUMNS_.map(function (c) { return c[1]; }),
    // Arrays rather than objects, in the header's order, so the file and the header cannot
    // drift apart and the browser has nothing to decide.
    rows: rows.map(function (r) {
      return PROGRESS_EXPORT_COLUMNS_.map(function (c) {
        var v = r[c[0]];
        return v === undefined || v === null ? '' : v;
      });
    })
  };
}

var PROGRESS_STATUS_LABEL_ = {
  'Submitted': 'Sent', 'Negotiating': 'Sent', 'Won': 'Accepted', 'Lost': 'Declined'
};

/** The shared reading behind the list and the download. */
async function progressRows_(user) {
  var all = (await readTable_('Quotations')).map(stripRow_);
  var rows = forStream_(user, all.filter(supersededFilter_(all)));

  var byId = {};
  var familySize = {};
  all.forEach(function (q) {
    byId[String(q.id)] = q;
    var root = String(q.parentQuotationId || q.id);
    familySize[root] = (familySize[root] || 0) + 1;
  });

  var names = await userNameMap_();
  var customerNames = {};
  (await readTable_('Customers')).forEach(function (c) { customerNames[String(c.id)] = c.name; });

  // Read once rather than once per declined offer, which on a database is a query each.
  var reasons = {};
  try {
    (await readTable_('LostReasons')).forEach(function (r) { reasons[String(r.id)] = String(r.reasonText || ''); });
  } catch (err) {
    // A sheet set up before LostReasons existed: the reason column is blank, not an error.
  }

  var ids = rows.map(function (q) { return String(q.id); });
  var idx = await journeyIndex_(ids);
  idx.lostReasons = reasons;

  // The money, per order: every invoice and what has been received against each. The journey
  // index keeps only the first invoice, which says when billing started, not how much.
  var orderIds = [];
  Object.keys(idx.orderByQuote).forEach(function (k) { orderIds.push(String(idx.orderByQuote[k].id)); });
  var invoices = orderIds.length ? await journeyRows_('Invoices', 'salesOrderId', orderIds) : [];
  // Issued only: a draft is a bill not yet sent and a cancelled one was never owed. The money
  // columns have to agree with Collections, which counts the same way.
  invoices = invoices.filter(function (i) { return String(i.status) === 'Issued'; });
  var invoiceIds = invoices.map(function (i) { return String(i.id); });
  var receipts = invoiceIds.length ? await journeyRows_('Receipts', 'invoiceId', invoiceIds) : [];
  var receivedByInvoice = {};
  receipts.forEach(function (r) {
    var k = String(r.invoiceId);
    receivedByInvoice[k] = (receivedByInvoice[k] || 0) + (Number(r.amount) || 0);
  });
  var moneyByOrder = {};
  invoices.forEach(function (i) {
    var k = String(i.salesOrderId);
    var m = moneyByOrder[k] = moneyByOrder[k] || { invoiced: 0, received: 0 };
    m.invoiced += billedAmount_(i);
    m.received += receivedByInvoice[String(i.id)] || 0;
  });

  // A loop rather than map: quotationJourney_ reads the database on the server, and an
  // asynchronous call inside a map callback would hand back promises instead of rows.
  var out = [];
  for (var q of rows) {
    var rootId = String(q.parentQuotationId || q.id);
    var root = byId[rootId] || q;
    var journey = await quotationJourney_(q, idx);
    var order = idx.orderByQuote[String(q.id)] || null;
    var money = order ? moneyByOrder[String(order.id)] : null;
    var lost = String(q.status) === 'Lost';
    var creator = personLine_(root.preparedBy || root.createdBy, names);
    var reviser = String(root.id) === String(q.id) ? ''
      : personLine_(q.preparedBy || q.createdBy, names);
    out.push({
      id: String(q.id),
      quoteNo: String(q.quoteNo || ''),
      revision: String(q.revision || 'R0'),
      date: String(q.date || ''),
      validUntil: String(q.validUntil || ''),
      status: String(q.status || ''),
      // The words the screens use, not the ones the sheet stores: nobody at PIE says
      // "Submitted" or "Lost" — they say Sent and Declined.
      statusLabel: PROGRESS_STATUS_LABEL_[String(q.status)] || String(q.status || ''),
      businessStream: String(q.businessStream || ''),
      customerName: customerNames[String(q.customerId)] || String(q.customerName || ''),
      grand: payableTotal_(q),
      createdBy: creator,
      // Only when it is somebody else: the same name twice reads as a mistake.
      revisedBy: reviser && reviser !== creator ? reviser : '',
      stage: journey.label,
      nextStep: journey.nextLabel || '',
      revisionCount: Math.max(0, (familySize[rootId] || 1) - 1),
      revisionReason: String(q.revisionReason || ''),
      approvedBy: personLine_(q.approvedBy, names),
      approvalDate: String(q.approvalDate || ''),
      sentDate: String(q.submittedDate || q.emailSentDate || ''),
      wonDate: String(q.wonDate || ''),
      lostDate: lost ? String(q.lostDate || '') : '',
      lostReason: lost ? (reasons[String(q.lostReasonId)] || '') : '',
      lostNotes: lost ? String(q.lostNotes || '') : '',
      lostToCompetitor: lost ? String(q.lostToCompetitor || '') : '',
      lostAtPrice: lost && q.lostAtPrice !== '' && q.lostAtPrice !== null &&
        q.lostAtPrice !== undefined ? Number(q.lostAtPrice) : '',
      orderNo: order ? String(order.orderNo || '') : '',
      poNo: order ? String(order.poNo || '') : '',
      orderStatus: order ? String(order.orderStatus || '') : '',
      invoiced: money ? roundMoney_(money.invoiced) : '',
      received: money ? roundMoney_(money.received) : '',
      balance: money ? roundMoney_(money.invoiced - money.received) : ''
    });
  }
  return out.sort(function (a, b) {
    return String(b.date + b.quoteNo).localeCompare(String(a.date + a.quoteNo));
  });
}
