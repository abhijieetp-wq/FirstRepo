/**
 * Where a quotation stands, end to end.
 *
 * PIE's order-to-cash runs: lead → quotation → internal approval → sent → discussed with the
 * customer → accepted → customer PO → sales order → procurement → credit check → invoice →
 * dispatch → proof of delivery → service. The ERP already records every one of those facts,
 * but each lived on its own screen: the quotation knew it had been submitted and nothing
 * else, and answering "where has this one got to?" meant opening four tabs and joining them
 * by eye.
 *
 * This joins them once. Nothing here is a new source of truth — every stage is read off the
 * record that owns it, so a stage cannot disagree with the screen it came from.
 */

/**
 * Every stage here is a step that has to happen. "With customer" used to sit between Sent and
 * Accepted, and it was the exception: it ticked only when somebody pressed the button, which
 * in the ordinary run of things — offer goes out, customer says yes — nobody does. So a
 * quotation that went perfectly showed a permanent grey gap, and the one signal the strip
 * exists to give, that a step was missed, became noise.
 *
 * Whether the customer is actively talking is still worth knowing; it is just not a stop on
 * the way. It rides on Sent as a note, below.
 */
var QUOTE_JOURNEY = [
  { key: 'prepared',   label: 'Prepared',     owner: 'Quotation' },
  { key: 'approved',   label: 'Approved',     owner: 'Quotation', hint: 'by management' },
  { key: 'sent',       label: 'Sent',         owner: 'Quotation', hint: 'to the customer' },
  { key: 'accepted',   label: 'Accepted',     owner: 'Quotation' },
  { key: 'po',         label: 'PO received',  owner: 'Sales order' },
  { key: 'order',      label: 'Sales order',  owner: 'Sales order' },
  { key: 'invoiced',   label: 'Invoiced',     owner: 'Invoice' },
  { key: 'dispatched', label: 'Dispatched',   owner: 'Dispatch' },
  { key: 'delivered',  label: 'Delivered',    owner: 'Dispatch', hint: 'proof of delivery' },
  { key: 'service',    label: 'Service told', owner: 'Dispatch' }
];

/**
 * The downstream records for a set of quotations, read once.
 *
 * Reading the order, dispatch and invoice tables per quotation is what a list of two hundred
 * quotations cannot afford, and reading them whole is three tables the screen mostly does not
 * need. So the ids wanted are named up front: a scan of the key column says which rows matter
 * and only those are fetched. On a list where most rows do match, `rowRuns_` collapses back to
 * one span, so the worst case costs one extra column scan rather than a second strategy.
 */
function journeyIndex_(quotationIds) {
  var idx = { orderByQuote: {}, dispatchByOrder: {}, invoiceByOrder: {} };
  if (!quotationIds || !quotationIds.length) return idx;

  var orders = journeyRows_('SalesOrders', 'quotationId', quotationIds);
  var orderIds = [];
  orders.forEach(function (o) {
    var key = String(o.quotationId || '');
    if (!key) return;
    // An order can be superseded; the newest one is the one a quotation became.
    var prev = idx.orderByQuote[key];
    if (!prev || String(o.date || '') >= String(prev.date || '')) idx.orderByQuote[key] = o;
    orderIds.push(String(o.id));
  });

  if (orderIds.length) {
    var dispatches = journeyRows_('Dispatches', 'salesOrderId', orderIds);
    dispatches.forEach(function (d) {
      var key = String(d.salesOrderId || '');
      if (!key) return;
      var prev = idx.dispatchByOrder[key];
      // The furthest-along dispatch speaks for the order: a part shipment that has been
      // delivered says more than a later one still being packed.
      if (!prev || dispatchReach_(d) > dispatchReach_(prev)) idx.dispatchByOrder[key] = d;
    });

    var invoices = journeyRows_('Invoices', 'salesOrderId', orderIds);
    invoices.forEach(function (v) {
      var key = String(v.salesOrderId || '');
      if (!key) return;
      if (String(v.status) === 'Cancelled') return;
      var prev = idx.invoiceByOrder[key];
      if (!prev || String(v.invoiceDate || '') <= String(prev.invoiceDate || '')) {
        idx.invoiceByOrder[key] = v;      // the first invoice is when billing started
      }
    });
  }
  return idx;
}

/**
 * The rows of a downstream tab, or none of them.
 *
 * The strip is something extra the quotation screen shows; it is never the reason the screen
 * fails to open. A Sheet set up before one of these tabs existed shows the stages it can and
 * leaves the rest grey, which is also the honest answer.
 */
function journeyRows_(tabName, column, keys) {
  try {
    return findRowsByColumn_(tabName, column, keys);
  } catch (err) {
    return [];
  }
}

function dispatchReach_(d) {
  if (isTrue_(d.serviceNotified)) return 4;
  if (isTrue_(d.deliveryConfirmed) || d.podDate) return 3;
  if (dispatchGone_(d)) return 2;
  return 1;
}

/**
 * Whether the goods have actually left.
 *
 * Not `dispatchDate` — a dispatch is created with today's date while it is still being
 * planned, so reading that would tick "Dispatched" on a consignment sitting in the store.
 * The status is what changes when it is posted out.
 */
function dispatchGone_(d) {
  return String(d.status) === 'Dispatched' || String(d.status) === 'Delivered';
}

/** Dispatches write Yes/No where most tabs write TRUE/FALSE. Both mean the same thing here. */
function isTrue_(v) {
  var t = String(v).trim().toUpperCase();
  return t === 'TRUE' || t === 'YES' || t === 'Y';
}

/**
 * The stage list for one quotation: what has happened, when, and what is next.
 *
 * A stage is reached when the record that owns it says so — not when the stage before it was
 * reached. An order raised without the quotation ever being marked Won is a real thing that
 * happens on a busy day, and the strip shows it rather than pretending the earlier step
 * occurred.
 */
function quotationJourney_(quote, idx) {
  var order = idx.orderByQuote[String(quote.id)] || null;
  var dispatch = order ? (idx.dispatchByOrder[String(order.id)] || null) : null;
  var invoice = order ? (idx.invoiceByOrder[String(order.id)] || null) : null;

  var at = {
    prepared:   { done: true, date: quote.date || quote.createdAt },
    // Evidence, not inference: a quotation sent without the approval ever being recorded
    // shows the approval grey. That gap is the point — it is a step of PIE's process that
    // did not happen, and filling it in because a later step did would hide exactly the
    // thing worth seeing. (The status is accepted as evidence of its own stage, so rows
    // that predate these dates still read correctly.)
    approved:   { done: !!quote.approvalDate || quote.status === 'Approved',
                  date: quote.approvalDate, detail: quote.approvedBy || '' },
    // Negotiating is no longer offered as a step, but rows carrying it from before still
    // have to read correctly, and it has only ever meant one thing: the offer went out.
    sent:       { done: !!(quote.submittedDate || quote.emailSentDate) ||
                    ['Submitted', 'Negotiating'].indexOf(quote.status) !== -1,
                  date: quote.submittedDate || quote.emailSentDate },
    accepted:   { done: quote.status === 'Won', date: quote.wonDate },
    po:         { done: !!(order && order.poNo), date: order ? order.poDate : '',
                  detail: order ? String(order.poNo || '') : '' },
    order:      { done: !!order, date: order ? order.date : '',
                  detail: order ? String(order.orderNo || '') : '' },
    invoiced:   { done: !!invoice, date: invoice ? invoice.invoiceDate : '',
                  detail: invoice ? String(invoice.invoiceNo || '') : '' },
    dispatched: { done: !!(dispatch && dispatchGone_(dispatch)),
                  date: dispatch ? dispatch.dispatchDate : '',
                  detail: dispatch ? String(dispatch.lrNumber || dispatch.dispatchNo || '') : '' },
    delivered:  { done: !!(dispatch && (isTrue_(dispatch.deliveryConfirmed) || dispatch.podDate)),
                  date: dispatch ? (dispatch.deliveryConfirmedDate || dispatch.podDate) : '',
                  detail: dispatch ? String(dispatch.podRef || '') : '' },
    service:    { done: !!(dispatch && isTrue_(dispatch.serviceNotified)) }
  };

  // An order is the customer's own PO turned into a commitment, so it proves the offer was
  // accepted even when nobody got round to pressing Won.
  if (order) at.accepted.done = true;

  var stages = QUOTE_JOURNEY.map(function (st) {
    var f = at[st.key] || {};
    return {
      key: st.key, label: st.label, owner: st.owner, hint: st.hint || '',
      done: !!f.done,
      date: f.date ? String(f.date).slice(0, 10) : '',
      detail: f.detail || ''
    };
  });

  // Where it stands is the last stage actually reached — not the furthest one ticked, so a
  // gap left by a skipped step does not read as progress that has not happened.
  var reached = -1;
  for (var i = 0; i < stages.length; i++) if (stages[i].done) reached = i;

  var closed = ['Lost', 'Expired'].indexOf(quote.status) !== -1;
  var stalled = quote.status === 'Revised';

  // An offer the customer turned down did not travel any further along this line, so it gets
  // a stop at the point it stopped rather than a stage of its own. Drawing "Declined" in the
  // run of stages would put a refusal on the road to delivery, which is not where it belongs.
  var declined = quote.status === 'Lost'
    ? { after: reached, reason: lostReasonText_(quote.lostReasonId), date: '' }
    : null;

  return {
    stages: stages,
    declined: declined,
    expired: quote.status === 'Expired',
    reachedIndex: reached,
    reachedKey: reached >= 0 ? stages[reached].key : '',
    // The one line a list column shows.
    label: journeyLabel_(quote, stages, reached, closed, stalled),
    closed: closed,
    stalled: stalled,
    nextKey: !closed && !stalled && reached + 1 < stages.length ? stages[reached + 1].key : '',
    nextLabel: !closed && !stalled && reached + 1 < stages.length ? stages[reached + 1].label : '',
    orderNo: order ? String(order.orderNo || '') : '',
    orderId: order ? String(order.id || '') : '',
    creditHold: !!(order && isTrue_(order.creditHold)),
    creditHoldReason: order ? String(order.creditHoldReason || '') : ''
  };
}

/**
 * The reason an offer was turned down, in the words the business chose for it.
 *
 * Tolerant of a missing tab for the same reason the rest of this module is: the strip is a
 * summary, and a summary that takes the whole screen down with it when one lookup fails is
 * worse than one missing a line. A Sheet set up before LostReasons existed still opens.
 */
function lostReasonText_(lostReasonId) {
  if (!lostReasonId) return '';
  try {
    var row = findRowById_('LostReasons', lostReasonId);
    return row ? String(row.reasonText || '') : '';
  } catch (err) {
    return '';
  }
}

function journeyLabel_(quote, stages, reached, closed, stalled) {
  // Named for what happened, matching the stage on the strip and the button that got it
  // there. 'Lost' is what the sheet stores; 'Declined' is what the customer did.
  if (quote.status === 'Lost') return 'Declined';
  if (quote.status === 'Expired') return 'Expired';
  if (stalled) return 'Revised';
  if (reached < 0) return 'Not started';
  return stages[reached].label;
}

/** The whole strip for one quotation, reading only the downstream rows that concern it. */
function quotationJourneyFor_(quote) {
  return quotationJourney_(quote, journeyIndex_([String(quote.id)]));
}
