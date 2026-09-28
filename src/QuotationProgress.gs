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
function getQuotationProgress(quotationId) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Quotation progress');

  var quotations = readTable_('Quotations');
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

  var journeyIdx = journeyIndex_(familyIds);
  var names = userNameMap_();

  // ---------------------------------------------------------------- the offer itself
  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(current.customerId);
  })[0];

  var enquiry = current.spareEnquiryId
    ? readTable_('SpareEnquiries').filter(function (e) {
        return String(e.id) === String(current.spareEnquiryId);
      })[0]
    : null;
  var opportunity = current.opportunityId
    ? readTable_('Opportunities').filter(function (o) {
        return String(o.id) === String(current.opportunityId);
      })[0]
    : null;

  // ---------------------------------------------------------------- what came after
  // Any revision of the offer could be the one that was converted, so the order is looked up
  // against the whole family rather than against the revision somebody happened to open.
  var order = readTable_('SalesOrders').filter(function (o) {
    return familyIds.indexOf(String(o.quotationId)) !== -1;
  })[0] || null;

  var orderLines = order
    ? readTable_('SalesOrderItems').filter(function (l) {
        return String(l.salesOrderId) === String(order.id);
      }).sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    : [];

  var dispatches = order
    ? readTable_('Dispatches').filter(function (d) {
        return String(d.salesOrderId) === String(order.id);
      })
    : [];

  var invoices = order
    ? readTable_('Invoices').filter(function (i) {
        return String(i.salesOrderId) === String(order.id);
      })
    : [];
  var invoiceIds = invoices.map(function (i) { return String(i.id); });
  var receipts = invoiceIds.length
    ? readTable_('Receipts').filter(function (r) {
        return invoiceIds.indexOf(String(r.invoiceId)) !== -1;
      })
    : [];

  // The customer's own paperwork. Read directly rather than through listDocuments, which
  // checks a permission this function has already checked once.
  var documents = order ? documentsFor_('SalesOrder', order.id) : [];

  return {
    quotationId: String(current.id),
    quoteNo: String(current.quoteNo || ''),
    businessStream: String(current.businessStream || ''),
    customerName: customer ? String(customer.name) : String(current.customerName || ''),
    journey: quotationJourney_(current, journeyIdx),

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
    lostReason: current.lostReasonId ? lostReasonText_(current.lostReasonId) : '',

    // ------------------------------------------------------------ the revisions
    revisions: family.map(function (q) {
      return {
        id: String(q.id),
        revision: String(q.revision || 'R0'),
        date: String(q.date || ''),
        status: String(q.status || ''),
        grand: payableTotal_(q),
        preparedBy: personLine_(q.preparedBy, names),
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
      var grand = Number(i.grand) || 0;
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
function userNameMap_() {
  var out = {};
  readTable_('Users').forEach(function (u) {
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

function lostReasonText_(id) {
  var row = readTable_('LostReasons').filter(function (r) {
    return String(r.id) === String(id);
  })[0];
  return row ? String(row.reasonText || '') : '';
}

/** Documents against one record, without re-checking a permission the caller already held. */
function documentsFor_(recordType, recordId) {
  var rows;
  try {
    rows = findRowsByColumn_('Documents', 'recordId', [String(recordId)]);
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
 */
function listProgressCandidates() {
  var user = getCurrentUser();
  requireCommercial_(user, 'Quotation progress');

  var rows = readTable_('Quotations').map(stripRow_);
  rows = rows.filter(supersededFilter_(rows));
  rows = forStream_(user, rows);

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  return rows.map(function (q) {
    return {
      id: String(q.id),
      quoteNo: String(q.quoteNo || ''),
      revision: String(q.revision || 'R0'),
      date: String(q.date || ''),
      status: String(q.status || ''),
      businessStream: String(q.businessStream || ''),
      customerName: customerNames[String(q.customerId)] || String(q.customerName || ''),
      grand: payableTotal_(q)
    };
  }).sort(function (a, b) {
    return String(b.date + b.quoteNo).localeCompare(String(a.date + a.quoteNo));
  });
}
