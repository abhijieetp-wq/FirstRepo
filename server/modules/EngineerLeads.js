/**
 * Converted from src/EngineerLeads.gs by migration/to-async.js.
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
async function serviceEngineerFor_(value, existing) {
  var raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return '';
  var was = String(existing || '').trim();
  if (was && raw.toLowerCase() === was.toLowerCase()) return was;

  var match = (await readTable_('Users')).filter(function (u) {
    return String(u.email || '').trim().toLowerCase() === raw.toLowerCase();
  })[0];
  if (!match || String(match.role || '').trim() !== ROLES.SERVICE_ENGINEER ||
      String(match.active).toUpperCase() === 'FALSE') {
    throw new Error('Pick the service engineer from the list. That person is not an active ' +
      'service engineer on the user list.');
  }
  return String(match.email).trim();
}

// ---------------------------------------------------------------- the Engineers list

var ENGINEER_KINDS = ['Service Engineer', 'Sales Engineer'];

/** The sales team keeps the list: whoever logs enquiries and quotations. */
function engineerEditor_(user) {
  return [ROLES.SALES_COORDINATOR, ROLES.SALES_ENGINEER, ROLES.MANAGEMENT, ROLES.ERP_ADMIN].indexOf(String(user.role)) !== -1;
}
function engineerOut_(e) {
  return { id: String(e.id), name: String(e.name || ''), kind: ENGINEER_KINDS.indexOf(String(e.kind)) !== -1 ? String(e.kind) : 'Service Engineer',
    active: String(e.active).toUpperCase() !== 'FALSE' };
}
/** Everybody on the list, active or not (a switched-off one still names old records), by type then name. */
async function listEngineers() {
  var user = getCurrentUser();
  var list = (await readTable_('Engineers')).map(engineerOut_).sort(function (a, b) {
    return ENGINEER_KINDS.indexOf(a.kind) - ENGINEER_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name);
  });
  return { engineers: list, kinds: ENGINEER_KINDS, canEdit: engineerEditor_(user) };
}
function engineerName_(v) {
  var name = String(v || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Type the engineer\'s name.');
  if (name.length > 80) throw new Error('That name is too long.');
  return name;
}
/** One engineer added, renamed, given another type, or switched off / on. */
async function saveEngineer(input) {
  var user = getCurrentUser();
  if (!engineerEditor_(user)) throw new Error('The engineers list is kept by the sales team.');
  var r = input || {};
  var rows = await readTable_('Engineers');
  var was = r.id ? rows.filter(function (e) { return String(e.id) === String(r.id); })[0] : null;
  if (r.id && !was) throw new Error('That engineer is no longer on the list.');
  var name = r.name === undefined && was ? String(was.name) : engineerName_(r.name);
  var kind = r.kind === undefined && was ? String(was.kind) : String(r.kind || '');
  if (ENGINEER_KINDS.indexOf(kind) === -1) throw new Error('Pick Service Engineer or Sales Engineer.');
  var clash = rows.filter(function (e) { return String(e.id) !== String(r.id || '') && String(e.name).trim().toLowerCase() === name.toLowerCase(); })[0];
  if (clash) throw new Error(name + ' is already on the list' + (String(clash.active).toUpperCase() === 'FALSE' ? ', switched off. Switch them back on instead.' : '.'));
  var active = r.active === undefined && was ? String(was.active).toUpperCase() !== 'FALSE' : r.active !== false;
  var rec = { name: name, kind: kind, active: active ? 'TRUE' : 'FALSE', updatedAt: nowIso_(), updatedBy: user.email };
  if (was) {
    await updateRowById_('Engineers', 'id', was.id, rec, 'Engineer ' + name + ' updated');
  } else {
    rec.id = generateId_('ENG-'); rec.createdAt = nowIso_(); rec.createdBy = user.email;
    await appendRow_('Engineers', rec, 'Engineer ' + name + ' added');
  }
  return await listEngineers();
}
/** Several at once, one name per line (an engineer already on the list is skipped). */
async function addEngineers(text, kind) {
  var user = getCurrentUser();
  if (!engineerEditor_(user)) throw new Error('The engineers list is kept by the sales team.');
  if (ENGINEER_KINDS.indexOf(String(kind)) === -1) throw new Error('Pick Service Engineer or Sales Engineer.');
  var have = {};
  (await readTable_('Engineers')).forEach(function (e) { have[String(e.name).trim().toLowerCase()] = true; });
  var added = [], skipped = [];
  var names = String(text || '').split(/[\r\n]+/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
  if (!names.length) throw new Error('Type the names, one per line.');
  for (var n of names) {
    var name = engineerName_(n);
    if (have[name.toLowerCase()]) { skipped.push(name); continue; }
    have[name.toLowerCase()] = true;
    await appendRow_('Engineers', { id: generateId_('ENG-'), name: name, kind: String(kind), active: 'TRUE',
      createdAt: nowIso_(), createdBy: user.email, updatedAt: nowIso_(), updatedBy: user.email }, 'Engineer ' + name + ' added');
    added.push(name);
  }
  var out = await listEngineers();
  out.added = added; out.skipped = skipped;
  return out;
}
/**
 * An engineer to name on a record: one on the list, active, of the type wanted when one is.
 * The one already on the record is accepted as it is, even if since switched off.
 */
async function engineerPick_(id, kindWanted, keptId) {
  var key = String(id || '').trim();
  var e = (await readTable_('Engineers')).filter(function (x) { return String(x.id) === key; })[0];
  if (!e) throw new Error('Pick the engineer from the list.');
  var out = engineerOut_(e);
  if (key === String(keptId || '')) return out;
  if (!out.active) throw new Error(out.name + ' is switched off on the engineers list.');
  if (kindWanted && out.kind !== kindWanted) throw new Error(out.name + ' is on the list as a ' + out.kind + ', not a ' + kindWanted + '.');
  return out;
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
async function getEngineerLeadsReport(input) {
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

  var names = await userNameMap_();
  var customerNames = {};
  (await readTable_('Customers')).forEach(function (c) { customerNames[String(c.id)] = String(c.name || ''); });

  // ---------------------------------------------------------------- what was logged
  var enquiries = showSpare
    ? (await readTable_('SpareEnquiries')).filter(function (e) { return inRange(e.date); }) : [];
  var leads = showUnits
    ? (await readTable_('Leads')).filter(function (l) { return inRange(l.date); }) : [];

  // ---------------------------------------------------------------- what came of it
  // Fetched by the keys in hand rather than whole tables: a month's enquiries need their own
  // quotations, not every quotation PIE have ever raised.
  var enquiryIds = enquiries.map(function (e) { return String(e.id); });
  var leadIds = leads.map(function (l) { return String(l.id); });

  var opportunities = leadIds.length ? await journeyRows_('Opportunities', 'leadId', leadIds) : [];
  var oppIds = opportunities.map(function (o) { return String(o.id); });

  // A revision carries the enquiry and the opportunity across from the offer it replaces, so
  // these reads bring whole families back, every revision included.
  var quotes = (enquiryIds.length ? await journeyRows_('Quotations', 'spareEnquiryId', enquiryIds) : [])
    .concat(oppIds.length ? await journeyRows_('Quotations', 'opportunityId', oppIds) : []);
  var quoteIds = quotes.map(function (q) { return String(q.id); });

  var orders = quoteIds.length ? await journeyRows_('SalesOrders', 'quotationId', quoteIds) : [];
  var orderIds = orders.map(function (o) { return String(o.id); });
  var invoices = (orderIds.length ? await journeyRows_('Invoices', 'salesOrderId', orderIds) : [])
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
  (await readTable_('Users')).forEach(function (u) {
    if (String(u.role || '').trim() !== ROLES.SERVICE_ENGINEER) return;
    if (String(u.active).toUpperCase() === 'FALSE') return;
    var email = String(u.email || '').trim();
    if (email) lineFor(email, String(u.name || '').trim() || email);
  });
  // And everybody on the Engineers list, which is where Generated by is picked from now.
  (await readTable_('Engineers')).forEach(function (e) {
    if (String(e.active).toUpperCase() === 'FALSE') return;
    lineFor('eng:' + e.id, String(e.name || ''));
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
  // Picked from the Engineers list: keyed by the list entry, named as it was picked.
  var picked = String(rec.generatedById || '').trim();
  if (picked) {
    return reportRowFor_(rec, names, customerNames, extra, got, 'eng:' + picked, String(rec.generatedByName || ''));
  }
  return reportRowFor_(rec, names, customerNames, extra, got, engineerEmail, engineerEmail ? personLine_(engineerEmail, names) : '');
}
function reportRowFor_(rec, names, customerNames, extra, got, engineerEmail, engineerName) {
  return {
    id: String(rec.id),
    stream: extra.stream,
    kind: extra.kind,
    ref: extra.ref,
    date: String(rec.date || '').slice(0, 10),
    engineerEmail: engineerEmail,
    engineer: engineerName,
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
