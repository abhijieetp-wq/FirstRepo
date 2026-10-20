/**
 * Which service engineer brought the business in.
 *
 * PIE's service engineers are at the customer's machine more often than anybody in sales. They
 * hear that a part is going, that the plant is adding a line, that the old compressor will not
 * last another summer, and they pass it on. Until now nothing recorded that they had: the
 * enquiry or the lead was logged by a coordinator, and the engineer who found it disappeared
 * from the record the moment it was typed in.
 *
 * So a spare enquiry and a compressor lead each name the service engineer it came from, when it
 * came from one, and this file answers the question PIE asked: who generated which enquiries,
 * and what did they turn into — quoted, ordered, invoiced.
 *
 * The engineer is picked from the people who hold the Service Engineer role, the same list the
 * service jobs are assigned from, so one person cannot become three spellings in the report.
 */

/**
 * The service engineer to store on a record: blank, or the address of a service engineer.
 *
 * The one already on the record is kept as it is even if they have since moved role or left —
 * the enquiry still came from them, and an edit to the phone number should not be refused
 * because of who passed the enquiry on two years ago.
 */
function serviceEngineerFor_(value, existing) {
  var raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return '';
  var was = String(existing || '').trim();
  if (was && raw.toLowerCase() === was.toLowerCase()) return was;

  var match = readTable_('Users').filter(function (u) {
    return String(u.email || '').trim().toLowerCase() === raw.toLowerCase();
  })[0];
  if (!match || String(match.role || '').trim() !== ROLES.SERVICE_ENGINEER ||
      String(match.active).toUpperCase() === 'FALSE') {
    throw new Error('Pick the service engineer from the list. That person is not an active ' +
      'service engineer on the user list.');
  }
  return String(match.email).trim();
}

/** The columns of the download, in order: [field on each row, heading in the file]. */
var ENGINEER_LEADS_COLUMNS_ = [
  ['engineer', 'Service engineer'], ['stream', 'Stream'], ['kind', 'Type'], ['ref', 'Ref no.'],
  ['date', 'Date'], ['customer', 'Customer'], ['requirement', 'What they asked for'],
  ['progress', 'Progress'], ['quotes', 'Quotations'], ['quotedValue', 'Quoted value (Rs)'],
  ['orders', 'Sales orders'], ['orderValue', 'Order value (Rs)'],
  ['invoiced', 'Invoiced (Rs)'], ['loggedBy', 'Logged by']
];

var NO_ENGINEER_LABEL_ = 'Not from a service engineer';

/**
 * Spare enquiries and compressor leads by the service engineer who generated them, with what
 * each became.
 *
 * input: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } — on the enquiry or lead date; either may be
 * blank for no limit.
 *
 * Every active service engineer is listed, including those with nothing in the period: a name
 * with a row of zeros is part of the answer. Enquiries and leads with nobody named are counted
 * on a line of their own, so the share that came through engineers can be read off.
 *
 * Money is counted the way the rest of the system counts it: the quoted value is the live
 * revision of each offer, so a quotation revised three times is not counted four times; orders
 * at their order total; invoiced at what the Tally invoice says, issued invoices only.
 */
function getEngineerLeadsReport(input) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Leads by engineer');

  var opts = input || {};
  var from = reportDay_(opts.from, 'start');
  var to = reportDay_(opts.to, 'end');
  if (from && to && from > to) throw new Error('The start date is after the end date.');
  var inRange = function (d) {
    var day = String(d || '').slice(0, 10);
    if (!day) return !from && !to;
    return (!from || day >= from) && (!to || day <= to);
  };

  var showSpare = streamAllowed_(user, STREAM_SPARE);
  var showUnits = streamAllowed_(user, STREAM_COMPRESSOR);

  var names = userNameMap_();
  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = String(c.name || ''); });

  // ---------------------------------------------------------------- what was logged
  var enquiries = showSpare
    ? readTable_('SpareEnquiries').filter(function (e) { return inRange(e.date); }) : [];
  var leads = showUnits
    ? readTable_('Leads').filter(function (l) { return inRange(l.date); }) : [];

  // ---------------------------------------------------------------- what came of it
  // Fetched by the keys in hand rather than whole tables: a month's enquiries need their own
  // quotations, not every quotation PIE have ever raised.
  var enquiryIds = enquiries.map(function (e) { return String(e.id); });
  var leadIds = leads.map(function (l) { return String(l.id); });

  var opportunities = leadIds.length ? journeyRows_('Opportunities', 'leadId', leadIds) : [];
  var oppIds = opportunities.map(function (o) { return String(o.id); });

  // A revision carries the enquiry and the opportunity across from the offer it replaces, so
  // these reads bring whole families back, every revision included.
  var quotes = (enquiryIds.length ? journeyRows_('Quotations', 'spareEnquiryId', enquiryIds) : [])
    .concat(oppIds.length ? journeyRows_('Quotations', 'opportunityId', oppIds) : []);
  var quoteIds = quotes.map(function (q) { return String(q.id); });

  var orders = quoteIds.length ? journeyRows_('SalesOrders', 'quotationId', quoteIds) : [];
  var orderIds = orders.map(function (o) { return String(o.id); });
  var invoices = (orderIds.length ? journeyRows_('Invoices', 'salesOrderId', orderIds) : [])
    .filter(function (i) { return String(i.status) === 'Issued'; });

  // ---------------------------------------------------------------- joined up
  var rootOf = function (q) { return String(q.parentQuotationId || q.id); };
  var families = {};          // root id -> { live, ids, enquiryId, opportunityId }
  quotes.forEach(function (q) {
    var root = rootOf(q);
    var f = families[root] = families[root] || { live: null, ids: [], enquiryId: '', opportunityId: '' };
    f.ids.push(String(q.id));
    if (!f.live || revisionNo_(q) > revisionNo_(f.live)) f.live = q;
    if (q.spareEnquiryId) f.enquiryId = String(q.spareEnquiryId);
    if (q.opportunityId) f.opportunityId = String(q.opportunityId);
  });

  var rootByQuote = {};
  Object.keys(families).forEach(function (root) {
    families[root].ids.forEach(function (id) { rootByQuote[id] = root; });
  });

  var invoicedByOrder = {};
  invoices.forEach(function (i) {
    var k = String(i.salesOrderId);
    invoicedByOrder[k] = (invoicedByOrder[k] || 0) + billedAmount_(i);
  });

  var ordersByRoot = {};
  orders.forEach(function (o) {
    var root = rootByQuote[String(o.quotationId)];
    if (!root) return;
    (ordersByRoot[root] = ordersByRoot[root] || []).push(o);
  });

  var rootsByEnquiry = {};
  var rootsByOpp = {};
  Object.keys(families).forEach(function (root) {
    var f = families[root];
    if (f.enquiryId) (rootsByEnquiry[f.enquiryId] = rootsByEnquiry[f.enquiryId] || []).push(root);
    else if (f.opportunityId) (rootsByOpp[f.opportunityId] = rootsByOpp[f.opportunityId] || []).push(root);
  });

  var oppsByLead = {};
  opportunities.forEach(function (o) {
    var k = String(o.leadId);
    (oppsByLead[k] = oppsByLead[k] || []).push(o);
  });

  /** Quotes, orders and money behind a set of offer families. */
  var outcome = function (roots) {
    var out = { quotes: [], quotedValue: 0, orders: [], orderValue: 0, invoiced: 0 };
    roots.forEach(function (root) {
      var live = families[root].live;
      out.quotes.push(String(live.quoteNo || '') + (live.revision && live.revision !== 'R0'
        ? ' ' + live.revision : ''));
      out.quotedValue += payableTotal_(live);
      (ordersByRoot[root] || []).forEach(function (o) {
        out.orders.push(String(o.orderNo || ''));
        out.orderValue += Number(o.grand) || 0;
        out.invoiced += invoicedByOrder[String(o.id)] || 0;
      });
    });
    return out;
  };

  // ---------------------------------------------------------------- one row per enquiry / lead
  var rows = [];
  enquiries.forEach(function (e) {
    var got = outcome(rootsByEnquiry[String(e.id)] || []);
    rows.push(reportRow_(e, names, customerNames, {
      stream: STREAM_SPARE, kind: 'Spare enquiry', ref: String(e.enquiryNo || ''),
      requirement: String(e.requirementText || ''), progress: String(e.status || '')
    }, got));
  });
  leads.forEach(function (l) {
    var opps = oppsByLead[String(l.id)] || [];
    var roots = [];
    opps.forEach(function (o) { roots = roots.concat(rootsByOpp[String(o.id)] || []); });
    var got = outcome(roots);
    var stage = opps.length ? String(opps[opps.length - 1].stage || '') : '';
    rows.push(reportRow_(l, names, customerNames, {
      stream: STREAM_COMPRESSOR, kind: 'Compressor lead', ref: String(l.leadNo || ''),
      requirement: String(l.requirementSummary || ''),
      // A converted lead lives on as its opportunity, so that is where its progress is read.
      progress: stage ? 'Opportunity: ' + stage : String(l.status || ''),
      converted: opps.length > 0
    }, got));
  });
  rows.sort(function (a, b) {
    return String(b.date + b.ref).localeCompare(String(a.date + a.ref));
  });

  // ---------------------------------------------------------------- one line per engineer
  var lines = {};
  var lineFor = function (email, name) {
    var key = String(email || '').toLowerCase();
    if (!lines[key]) {
      lines[key] = { email: String(email || ''), name: name, spare: emptyTally_('spare'),
                     units: emptyTally_('units') };
    }
    return lines[key];
  };
  readTable_('Users').forEach(function (u) {
    if (String(u.role || '').trim() !== ROLES.SERVICE_ENGINEER) return;
    if (String(u.active).toUpperCase() === 'FALSE') return;
    var email = String(u.email || '').trim();
    if (email) lineFor(email, String(u.name || '').trim() || email);
  });

  var totals = { spare: emptyTally_('spare'), units: emptyTally_('units') };
  rows.forEach(function (r) {
    var line = r.engineerEmail ? lineFor(r.engineerEmail, r.engineer) : lineFor('', NO_ENGINEER_LABEL_);
    var bucket = r.stream === STREAM_SPARE ? 'spare' : 'units';
    addToTally_(line[bucket], r);
    addToTally_(totals[bucket], r);
  });

  var engineers = Object.keys(lines).filter(function (k) { return k !== ''; })
    .map(function (k) { return finishLine_(lines[k]); })
    .sort(function (a, b) {
      var n = (b.spare.logged + b.units.logged) - (a.spare.logged + a.units.logged);
      return n || a.name.localeCompare(b.name);
    });

  return {
    from: from,
    to: to,
    generatedAt: nowIso_(),
    showSpare: showSpare,
    showUnits: showUnits,
    engineers: engineers,
    none: lines[''] ? finishLine_(lines['']) : finishLine_({
      email: '', name: NO_ENGINEER_LABEL_, spare: emptyTally_('spare'), units: emptyTally_('units')
    }),
    totals: { spare: finishTally_(totals.spare), units: finishTally_(totals.units) },
    columns: ENGINEER_LEADS_COLUMNS_.map(function (c) { return { key: c[0], label: c[1] }; }),
    rows: rows.map(function (r) {
      r.quotedValue = roundMoney_(r.quotedValue);
      r.orderValue = roundMoney_(r.orderValue);
      r.invoiced = roundMoney_(r.invoiced);
      return r;
    })
  };
}

/** A report bound as YYYY-MM-DD, or blank for none. Anything else is a mistake worth saying. */
function reportDay_(value, which) {
  var s = String(value === undefined || value === null ? '' : value).trim().slice(0, 10);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error('The ' + (which === 'end' ? 'end' : 'start') + ' date is not a date.');
  }
  return s;
}

function reportRow_(rec, names, customerNames, extra, got) {
  var engineerEmail = String(rec.serviceEngineerEmail || '').trim();
  return {
    id: String(rec.id),
    stream: extra.stream,
    kind: extra.kind,
    ref: extra.ref,
    date: String(rec.date || '').slice(0, 10),
    engineerEmail: engineerEmail,
    engineer: engineerEmail ? personLine_(engineerEmail, names) : '',
    customer: customerNames[String(rec.customerId)] || String(rec.customerName || ''),
    requirement: extra.requirement,
    progress: extra.progress,
    converted: !!extra.converted,
    quotes: got.quotes.join(', '),
    quoteCount: got.quotes.length,
    quotedValue: got.quotedValue,
    orders: got.orders.join(', '),
    orderCount: got.orders.length,
    orderValue: got.orderValue,
    invoiced: got.invoiced,
    loggedBy: personLine_(rec.createdBy, names)
  };
}

function emptyTally_(which) {
  var t = { logged: 0, quoted: 0, quotedValue: 0, won: 0, orderValue: 0, invoiced: 0 };
  if (which === 'units') t.converted = 0;
  return t;
}

function addToTally_(t, r) {
  t.logged += 1;
  if (r.converted && t.converted !== undefined) t.converted += 1;
  if (r.quoteCount) t.quoted += 1;
  t.quotedValue += r.quotedValue;
  if (r.orderCount) t.won += 1;
  t.orderValue += r.orderValue;
  t.invoiced += r.invoiced;
}

function finishTally_(t) {
  t.quotedValue = roundMoney_(t.quotedValue);
  t.orderValue = roundMoney_(t.orderValue);
  t.invoiced = roundMoney_(t.invoiced);
  return t;
}

function finishLine_(line) {
  finishTally_(line.spare);
  finishTally_(line.units);
  return line;
}
