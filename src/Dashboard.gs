/**
 * Management dashboards — M17/M18.
 *
 * One server call, not eight. Every figure on this screen comes from the same seventeen
 * tables, so eight separate endpoints would re-read the same sheets eight times and give
 * Management a page that takes half a minute to settle. `getDashboard()` reads each table
 * once, derives everything from those arrays in memory, and returns a single payload.
 *
 * The result is cached for a couple of minutes because the underlying reads are the
 * expensive part and nobody makes a decision on ninety-second-old data differently than on
 * fresh data. The refresh button bypasses the cache for the case where somebody genuinely
 * just changed something and wants to see it.
 *
 * The blueprint asks for compressor, spare and combined dashboards. They are the same
 * dashboard with a stream filter rather than three screens to keep in step — a metric that
 * means one thing on the combined page and something subtly different on the spare page is
 * how dashboards start lying.
 *
 * Nothing here is a cost or margin figure. Margin needs cost-at-the-time-of-sale, and the
 * only honest source for that is the effective-dated PIE price on the day the line was
 * quoted; approximating it from today's cost would produce a number that looks precise and
 * is not. It is deliberately absent rather than wrong.
 */

var DASHBOARD_CACHE_SECONDS = 120;

/** Exception severities map to the reserved status colours; each ships with a label. */
var EXCEPTION_SEVERITY = { CRITICAL: 'critical', SERIOUS: 'serious', WARNING: 'warning' };

function getDashboard(options) {
  var user = getCurrentUser();
  var opts = options || {};
  // Must be the stored spelling, not a short form — see BUSINESS_STREAMS in Schema.gs.
  var stream = BUSINESS_STREAMS.indexOf(opts.stream) !== -1 ? opts.stream : '';

  var cache = CacheService.getUserCache();
  var cacheKey = 'dash:' + user.email + ':' + stream;
  if (!opts.refresh) {
    var hit = cache.get(cacheKey);
    if (hit) {
      try {
        var parsed = JSON.parse(hit);
        parsed.fromCache = true;
        return parsed;
      } catch (e) { /* a corrupt entry is simply rebuilt below */ }
    }
  }

  var data = buildDashboard_(stream, user);
  try {
    cache.put(cacheKey, JSON.stringify(data), DASHBOARD_CACHE_SECONDS);
  } catch (e) {
    // Over the 100KB cache limit — the dashboard still works, just uncached.
    Logger.log('Dashboard cache skipped: ' + e.message);
  }
  return data;
}

function buildDashboard_(stream, user) {
  var today = todayIso_();
  var thisMonth = today.slice(0, 7);

  // ---- read each table exactly once ----
  var orders = readTable_('SalesOrders');
  var orderItems = readTable_('SalesOrderItems');
  var invoices = readTable_('Invoices');
  var receipts = readTable_('Receipts');
  var quotations = readTable_('Quotations');
  var enquiries = readTable_('SpareEnquiries');
  var leads = readTable_('Leads');
  var opportunities = readTable_('Opportunities');
  var dispatches = readTable_('Dispatches');
  var followups = readTable_('CollectionFollowups');
  var grns = readTable_('GRNs');
  var customers = readTable_('Customers');
  var spares = readTable_('Spares');
  var reservations = readTable_('StockReservations');
  var movements = readTable_('StockMovements');

  var inStream = function (row) { return !stream || row.businessStream === stream; };
  var streamOrders = orders.filter(inStream);
  var streamInvoices = invoices.filter(inStream);
  var streamQuotes = quotations.filter(inStream);

  var customerName = {};
  customers.forEach(function (c) { customerName[String(c.id)] = c.name; });

  // ---- receipts indexed by invoice, so ageing is one pass ----
  var receivedByInvoice = {};
  receipts.forEach(function (r) {
    var key = String(r.invoiceId);
    receivedByInvoice[key] = (receivedByInvoice[key] || 0) + (Number(r.amount) || 0);
  });

  var openInvoices = streamInvoices.filter(function (inv) { return inv.status === 'Issued'; })
    .map(function (inv) {
      var balance = roundMoney_((Number(inv.grand) || 0) - (receivedByInvoice[String(inv.id)] || 0));
      var overdue = inv.dueDate ? daysBetween_(inv.dueDate, today) : 0;
      return {
        id: inv.id, invoiceNo: inv.invoiceNo, customerId: inv.customerId,
        grand: Number(inv.grand) || 0, balance: balance,
        overdueDays: overdue > 0 ? overdue : 0,
        bucket: ageingBucketFor_(overdue)
      };
    })
    .filter(function (inv) { return inv.balance > 0.5; });

  // ---- headline figures ----
  var openOrderStatuses = ['Draft', 'Approval Pending', 'Credit Hold', 'Material Pending',
    'Ready for Dispatch', 'Dispatched'];
  var openOrders = streamOrders.filter(function (o) {
    return openOrderStatuses.indexOf(o.orderStatus) !== -1;
  });

  var weightedPipeline = 0;
  opportunities.forEach(function (op) {
    if (stream === STREAM_SPARE) return;
    if (['Won', 'Lost'].indexOf(op.stage) !== -1) return;
    var probability = op.probability === '' || op.probability === null
      ? (STAGE_PROBABILITY[op.stage] || 0) : Number(op.probability);
    weightedPipeline += (Number(op.expectedValue) || 0) * probability / 100;
  });

  var invoicedThisMonth = 0;
  streamInvoices.forEach(function (inv) {
    if (inv.status !== 'Issued') return;
    if (String(inv.invoiceDate).slice(0, 7) !== thisMonth) return;
    invoicedThisMonth += Number(inv.grand) || 0;
  });

  var invoiceStream = {};
  invoices.forEach(function (inv) { invoiceStream[String(inv.id)] = inv.businessStream; });
  var collectedThisMonth = 0;
  receipts.forEach(function (r) {
    if (String(r.receiptDate).slice(0, 7) !== thisMonth) return;
    if (stream && invoiceStream[String(r.invoiceId)] !== stream) return;
    collectedThisMonth += Number(r.amount) || 0;
  });

  var outstanding = openInvoices.reduce(function (s, i) { return s + i.balance; }, 0);
  var overdueAmount = openInvoices.reduce(function (s, i) {
    return s + (i.overdueDays > 0 ? i.balance : 0);
  }, 0);

  var headline = {
    openOrderCount: openOrders.length,
    openOrderValue: roundMoney_(openOrders.reduce(function (s, o) { return s + (Number(o.grand) || 0); }, 0)),
    weightedPipeline: roundMoney_(weightedPipeline),
    outstanding: roundMoney_(outstanding),
    overdueAmount: roundMoney_(overdueAmount),
    overduePct: outstanding > 0 ? Math.round(overdueAmount / outstanding * 100) : 0,
    invoicedThisMonth: roundMoney_(invoicedThisMonth),
    collectedThisMonth: roundMoney_(collectedThisMonth),
    openQuotationCount: streamQuotes.filter(function (q) {
      return ['Draft', 'Approved', 'Submitted', 'Revised'].indexOf(q.status) !== -1;
    }).length,
    openQuotationValue: roundMoney_(streamQuotes.reduce(function (s, q) {
      return ['Draft', 'Approved', 'Submitted', 'Revised'].indexOf(q.status) !== -1
        ? s + (Number(q.grand) || 0) : s;
    }, 0))
  };

  return {
    generatedAt: new Date().toISOString(),
    stream: stream,
    role: user.role,
    headline: headline,
    exceptions: buildExceptions_(stream, {
      orders: streamOrders, orderItems: orderItems, dispatches: dispatches,
      invoices: invoices, openInvoices: openInvoices, followups: followups,
      grns: grns, quotations: streamQuotes, spares: spares,
      movements: movements, reservations: reservations, today: today
    }),
    orderPipeline: buildOrderPipeline_(streamOrders),
    funnel: stream === STREAM_SPARE ? [] : buildFunnel_(opportunities),
    enquiryFunnel: stream === STREAM_COMPRESSOR ? [] : buildEnquiryFunnel_(enquiries),
    ageing: buildAgeing_(openInvoices),
    trend: buildTrend_(streamInvoices, receipts, invoiceStream, stream),
    topCustomers: buildTopCustomers_(openInvoices, customerName),
    leadCount: stream === STREAM_SPARE ? 0 : leads.filter(function (l) {
      return ['New', 'Contacted', 'Qualified'].indexOf(l.status) !== -1;
    }).length
  };
}

/**
 * The control tower (FR-057). This is the part of the dashboard that earns its place: not
 * what is going well, but what has stopped moving and who has to unblock it. Every row is a
 * count, a value and a destination, because an exception you cannot click through to is a
 * complaint rather than a control.
 */
function buildExceptions_(stream, d) {
  var out = [];
  var add = function (row) { if (row.count > 0) out.push(row); };

  var creditHolds = d.orders.filter(function (o) {
    return String(o.creditHold).toUpperCase() === 'TRUE' || o.orderStatus === 'Credit Hold';
  });
  add({
    key: 'creditHolds', label: 'Orders on credit hold',
    detail: 'Management must release these before dispatch',
    count: creditHolds.length,
    value: roundMoney_(creditHolds.reduce(function (s, o) { return s + (Number(o.grand) || 0); }, 0)),
    severity: EXCEPTION_SEVERITY.CRITICAL, view: 'orders'
  });

  // Goods that left without a bill — the most expensive thing to find out late (FR-049).
  var invoicedDispatch = {};
  d.invoices.forEach(function (inv) {
    if (inv.dispatchId && inv.status !== 'Cancelled') invoicedDispatch[String(inv.dispatchId)] = true;
  });
  var orderIds = {};
  d.orders.forEach(function (o) { orderIds[String(o.id)] = true; });
  var notInvoiced = d.dispatches.filter(function (dp) {
    return dp.status === 'Dispatched' && !invoicedDispatch[String(dp.id)] &&
      (!stream || orderIds[String(dp.salesOrderId)]);
  });
  add({
    key: 'notInvoiced', label: 'Dispatched but not invoiced',
    detail: 'Goods have left the building with no bill raised',
    count: notInvoiced.length,
    value: 0,
    oldestDays: notInvoiced.reduce(function (m, dp) {
      return Math.max(m, daysBetween_(dp.dispatchDate, d.today));
    }, 0),
    severity: EXCEPTION_SEVERITY.CRITICAL, view: 'dispatch'
  });

  var invoiceIds = {};
  d.openInvoices.forEach(function (i) { invoiceIds[String(i.id)] = true; });
  var broken = d.followups.filter(function (f) {
    if (f.status === 'Closed' || f.commitmentMet === 'Yes') return false;
    if (!f.commitmentDate || !(Number(f.commitmentAmount) > 0)) return false;
    if (stream && !invoiceIds[String(f.invoiceId)]) return false;
    return daysBetween_(f.commitmentDate, d.today) > 0;
  });
  add({
    key: 'brokenCommitments', label: 'Broken payment commitments',
    detail: 'The promised date has passed and the money has not arrived',
    count: broken.length,
    value: roundMoney_(broken.reduce(function (s, f) { return s + (Number(f.commitmentAmount) || 0); }, 0)),
    severity: EXCEPTION_SEVERITY.CRITICAL, view: 'collections'
  });

  var badDebt = d.openInvoices.filter(function (i) { return i.bucket === 'd90plus'; });
  add({
    key: 'over90', label: 'Receivables over 90 days',
    detail: 'Past the point where these usually collect themselves',
    count: badDebt.length,
    value: roundMoney_(badDebt.reduce(function (s, i) { return s + i.balance; }, 0)),
    severity: EXCEPTION_SEVERITY.CRITICAL, view: 'collections'
  });

  var lateDispatch = d.orders.filter(function (o) {
    if (['Dispatched', 'Invoiced', 'Closed'].indexOf(o.orderStatus) !== -1) return false;
    return o.promisedDispatchDate && daysBetween_(o.promisedDispatchDate, d.today) > 0;
  });
  add({
    key: 'lateDispatch', label: 'Orders past their promised date',
    detail: 'Promised to the customer and still not shipped',
    count: lateDispatch.length,
    value: roundMoney_(lateDispatch.reduce(function (s, o) { return s + (Number(o.grand) || 0); }, 0)),
    severity: EXCEPTION_SEVERITY.SERIOUS, view: 'orders'
  });

  var unverified = d.grns.filter(function (g) { return g.verificationStatus !== 'Verified'; });
  add({
    key: 'unverifiedGrn', label: 'Goods received, not verified',
    detail: 'Stock does not exist in the system until someone verifies it',
    count: unverified.length, value: 0,
    severity: EXCEPTION_SEVERITY.SERIOUS, view: 'inventory'
  });

  // Orders waiting on material: stock reserved short of what was sold.
  var orderIdSet = {};
  d.orders.forEach(function (o) {
    if (o.orderStatus === 'Material Pending') orderIdSet[String(o.id)] = true;
  });
  var shortLines = d.orderItems.filter(function (l) {
    if (!orderIdSet[String(l.salesOrderId)]) return false;
    var outstanding = (Number(l.qty) || 0) - (Number(l.qtyDispatched) || 0);
    return (Number(l.qtyReserved) || 0) < outstanding;
  });
  add({
    key: 'materialShort', label: 'Order lines without stock',
    detail: 'Sold but not reservable — these are the purchase list',
    count: shortLines.length, value: 0,
    severity: EXCEPTION_SEVERITY.WARNING, view: 'inventory'
  });

  if (stream !== STREAM_COMPRESSOR) {
    var onHand = {};
    d.movements.forEach(function (m) {
      if (m.itemType !== 'Spare') return;
      onHand[String(m.itemId)] = (onHand[String(m.itemId)] || 0) + (Number(m.qty) || 0);
    });
    var belowReorder = d.spares.filter(function (sp) {
      if (String(sp.active).toUpperCase() === 'FALSE') return false;
      var level = Number(sp.reorderLevel);
      if (!(level > 0)) return false;
      return (onHand[String(sp.id)] || 0) < level;
    });
    add({
      key: 'belowReorder', label: 'Spares below reorder level',
      detail: 'On hand has fallen under the level set on the part',
      count: belowReorder.length, value: 0,
      severity: EXCEPTION_SEVERITY.WARNING, view: 'inventory'
    });
  }

  var stale = d.quotations.filter(function (q) {
    if (['Draft', 'Approved', 'Submitted', 'Revised'].indexOf(q.status) === -1) return false;
    return q.validUntil && daysBetween_(q.validUntil, d.today) > 0;
  });
  add({
    key: 'expiredQuotes', label: 'Quotations past their validity',
    detail: 'Still open on our side but no longer binding',
    count: stale.length,
    value: roundMoney_(stale.reduce(function (s, q) { return s + (Number(q.grand) || 0); }, 0)),
    severity: EXCEPTION_SEVERITY.WARNING, view: 'quotations'
  });

  var order = { critical: 0, serious: 1, warning: 2 };
  return out.sort(function (a, b) {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    return b.count - a.count;
  });
}

function buildOrderPipeline_(orders) {
  var counts = {};
  var values = {};
  ORDER_STATUSES.forEach(function (s) { counts[s] = 0; values[s] = 0; });
  orders.forEach(function (o) {
    if (counts[o.orderStatus] === undefined) return;
    counts[o.orderStatus] += 1;
    values[o.orderStatus] += Number(o.grand) || 0;
  });
  return ORDER_STATUSES.map(function (s) {
    return { label: s, count: counts[s], value: roundMoney_(values[s]) };
  });
}

function buildFunnel_(opportunities) {
  var counts = {};
  var values = {};
  OPPORTUNITY_STAGES.forEach(function (s) { counts[s] = 0; values[s] = 0; });
  opportunities.forEach(function (op) {
    if (counts[op.stage] === undefined) return;
    counts[op.stage] += 1;
    values[op.stage] += Number(op.expectedValue) || 0;
  });
  return OPPORTUNITY_STAGES.map(function (s) {
    return { label: s, count: counts[s], value: roundMoney_(values[s]) };
  });
}

function buildEnquiryFunnel_(enquiries) {
  var stages = ['New', 'Identifying', 'Quoted', 'Won', 'Lost'];
  var counts = {};
  stages.forEach(function (s) { counts[s] = 0; });
  enquiries.forEach(function (e) {
    if (counts[e.status] !== undefined) counts[e.status] += 1;
  });
  return stages.map(function (s) { return { label: s, count: counts[s], value: 0 }; });
}

function buildAgeing_(openInvoices) {
  var totals = {};
  AGEING_BUCKETS.forEach(function (b) { totals[b.key] = { amount: 0, count: 0 }; });
  openInvoices.forEach(function (i) {
    totals[i.bucket].amount += i.balance;
    totals[i.bucket].count += 1;
  });
  return AGEING_BUCKETS.map(function (b) {
    return {
      key: b.key, label: b.label,
      value: roundMoney_(totals[b.key].amount),
      count: totals[b.key].count
    };
  });
}

/** Invoiced against collected, by month, for the last six months including this one. */
function buildTrend_(streamInvoices, receipts, invoiceStream, stream) {
  var months = [];
  var now = new Date();
  for (var i = 5; i >= 0; i--) {
    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }

  var invoiced = {};
  var collected = {};
  months.forEach(function (m) { invoiced[m] = 0; collected[m] = 0; });

  streamInvoices.forEach(function (inv) {
    if (inv.status !== 'Issued') return;
    var m = String(inv.invoiceDate).slice(0, 7);
    if (invoiced[m] === undefined) return;
    invoiced[m] += Number(inv.grand) || 0;
  });

  receipts.forEach(function (r) {
    var m = String(r.receiptDate).slice(0, 7);
    if (collected[m] === undefined) return;
    if (stream && invoiceStream[String(r.invoiceId)] !== stream) return;
    collected[m] += Number(r.amount) || 0;
  });

  return months.map(function (m) {
    return {
      month: m,
      label: monthLabel_(m),
      invoiced: roundMoney_(invoiced[m]),
      collected: roundMoney_(collected[m])
    };
  });
}

function monthLabel_(iso) {
  var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var parts = String(iso).split('-');
  var idx = Number(parts[1]) - 1;
  return (names[idx] || parts[1]) + " '" + String(parts[0]).slice(2);
}

/** The ten customers holding the most of our money. */
function buildTopCustomers_(openInvoices, customerName) {
  var byCustomer = {};
  openInvoices.forEach(function (inv) {
    var key = String(inv.customerId);
    if (!byCustomer[key]) {
      byCustomer[key] = {
        customerId: inv.customerId,
        customerName: customerName[key] || '',
        outstanding: 0, overdue: 0, invoiceCount: 0, oldestOverdueDays: 0
      };
    }
    var row = byCustomer[key];
    row.outstanding += inv.balance;
    if (inv.overdueDays > 0) row.overdue += inv.balance;
    row.invoiceCount += 1;
    row.oldestOverdueDays = Math.max(row.oldestOverdueDays, inv.overdueDays);
  });

  return Object.keys(byCustomer)
    .map(function (k) {
      var row = byCustomer[k];
      row.outstanding = roundMoney_(row.outstanding);
      row.overdue = roundMoney_(row.overdue);
      return row;
    })
    .sort(function (a, b) { return b.outstanding - a.outstanding; })
    .slice(0, 10);
}
