/**
 * Converted from src/EnquiryBoard.gs by migration/to-async.js.
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
 * ERP 2.0's enquiry board: every enquiry on a desk, on ERP 2's ten stages.
 *
 *   Enquiry received → Requirement understood → Quotation prepared → Quotation sent →
 *   In negotiation → Approved by customer → PO received → Sales order (WON) →
 *   Material procurement → Dispatched              (and, apart, Rejected / Lost)
 *
 * Nothing here is a new record. Each stage is read off what ERP 1 already keeps — the
 * enquiry or lead, its quotations, the order a quotation became, the dispatch — the same
 * facts QuotationJourney.gs reads for the strip on a quotation, so the board can never say
 * something the screens it summarises do not. Three stages are set by hand, and each of them
 * is written into a field ERP 1 already has, so ERP 1's own screens follow:
 *
 *   - Enquiry received / Requirement understood: the spare enquiry's status (New, Identifying)
 *     or the lead's (New, Qualified);
 *   - In negotiation: the quotation's own status, Negotiating — which ERP 1 shows as Sent, its
 *     meaning, and which it already counted as sent everywhere.
 *
 * What a card is on each desk:
 *
 *   - Spare Sales: each spare enquiry, with the quotations raised from it; and each spares
 *     quotation that was raised without an enquiry, on its own — a walk-in quoted straight
 *     from New Quotation is still business on the desk.
 *   - Compressor Sales: each lead, with its opportunity's quotations; each opportunity with no
 *     lead; and each compressor quotation with neither.
 *
 * Shown on the 2.0 face only (JavaScript.html, FACE_V2). The stage names can be renamed
 * (ConfigLists, category BoardStage); stages cannot be added, because the ones that move by
 * themselves are tied to records.
 */

var BOARD_STAGES = [
  { key: 'enquiry', label: 'Enquiry received', how: 'hand' },
  { key: 'requirement', label: 'Requirement understood', how: 'hand' },
  { key: 'quoted', label: 'Quotation prepared', how: 'auto', when: 'a quotation is prepared' },
  { key: 'sent', label: 'Quotation sent', how: 'auto', when: 'the quotation is sent' },
  { key: 'negotiation', label: 'In negotiation', how: 'hand', when: 'the customer is discussing the offer' },
  { key: 'approved', label: 'Approved by customer', how: 'auto', when: 'the quotation is marked won' },
  { key: 'po', label: 'PO received', how: 'auto', when: 'an order is raised on the PO; credit holds wait here' },
  { key: 'won', label: 'Sales order (WON)', how: 'auto', when: 'the order clears the credit check' },
  { key: 'procurement', label: 'Material procurement', how: 'auto', when: 'material is reserved, short or ready' },
  { key: 'dispatched', label: 'Dispatched', how: 'auto', when: 'the goods leave' }
];
var BOARD_CLOSED = { key: 'lost', label: 'Rejected / Lost' };

/** Finished cards — dispatched or closed — stay on the board this long, then leave it. */
var BOARD_RECENT_DAYS = 90;

/** Where each key sits on the road, for "the furthest along" comparisons. */
function boardRank_(key) {
  for (var i = 0; i < BOARD_STAGES.length; i++) if (BOARD_STAGES[i].key === key) return i;
  return -1;
}

/** The stage names, renamed where the business has renamed them. */
async function boardStageNames_() {
  var names = {};
  BOARD_STAGES.concat([BOARD_CLOSED]).forEach(function (s) { names[s.key] = { label: s.label, id: '' }; });
  try {
    (await readTable_('ConfigLists')).forEach(function (r) {
      if (String(r.category) !== 'BoardStage' || !names[String(r.code)]) return;
      if (String(r.active).toUpperCase() === 'FALSE' || !String(r.label || '').trim()) return;
      names[String(r.code)] = { label: String(r.label).trim(), id: String(r.id) };
    });
  } catch (err) {
    // A sheet without the tab still shows the board, with the standard names.
  }
  return names;
}

/**
 * Where one quotation has got to, on the board's road.
 *
 * The order speaks first, because an order is the customer's PO turned into a commitment
 * whatever the quotation's own status says (the journey strip reads it the same way).
 */
function boardQuoteStage_(quote, idx, checkedOrders) {
  var order = idx.orderByQuote[String(quote.id)] || null;
  if (order) {
    var dispatch = idx.dispatchByOrder[String(order.id)] || null;
    var status = String(order.orderStatus || '');
    if ((dispatch && dispatchGone_(dispatch)) || ['Dispatched', 'Invoiced', 'Closed'].indexOf(status) !== -1) {
      return 'dispatched';
    }
    if (['Material Pending', 'Ready for Dispatch'].indexOf(status) !== -1) return 'procurement';
    if (isTrue_(order.creditHold) || status === 'Credit Hold') return 'po';
    return checkedOrders[String(order.id)] ? 'won' : 'po';
  }
  var qs = String(quote.status || '');
  if (qs === 'Won') return 'approved';
  if (qs === 'Lost' || qs === 'Expired') return 'lost';
  if (qs === 'Negotiating') return 'negotiation';
  if (quote.submittedDate || quote.emailSentDate || qs === 'Submitted') return 'sent';
  return 'quoted';
}

/** Orders whose credit check has been passed, or whose hold was lifted. */
async function boardCheckedOrders_(orderIds) {
  var out = {};
  if (!orderIds.length) return out;
  (await journeyRows_('CreditChecks', 'salesOrderId', orderIds)).forEach(function (c) {
    if (String(c.result) !== 'Hold' || String(c.releaseDate || '').trim()) out[String(c.salesOrderId)] = true;
  });
  return out;
}

/**
 * The desk's board.
 *
 * @param options { stream: 'Spare Sales' | 'Compressor Sales' }
 * @return { stream, stages: [{key,label,how,when,id}], closed: {...}, cards: [...],
 *           recentDays, canMove, canRename, me }
 */
async function getEnquiryBoard(options) {
  var user = getCurrentUser();
  var opts = options || {};
  var stream = opts.stream === STREAM_COMPRESSOR ? STREAM_COMPRESSOR : STREAM_SPARE;
  var what = stream === STREAM_SPARE ? 'Spare enquiries' : 'Compressor leads';
  requireCommercial_(user, what);
  requireStream_(user, stream, what);

  var people = await userNameMap_();
  var customers = {};
  (await readTable_('Customers')).forEach(function (c) { customers[String(c.id)] = String(c.name || ''); });
  var lostReasons = {};
  try {
    (await readTable_('LostReasons')).forEach(function (r) { lostReasons[String(r.id)] = String(r.reasonText || ''); });
  } catch (err) { /* reasons are a courtesy on the card */ }

  // The live offers on this desk: the newest revision of each, never a superseded one.
  var all = (await readTable_('Quotations')).filter(function (q) {
    return String(q.businessStream || '') === stream;
  });
  var current = supersededFilter_(all);
  var quotes = all.filter(function (q) { return current(q) && String(q.status) !== 'Revised'; });
  var idx = await journeyIndex_(quotes.map(function (q) { return String(q.id); }));
  var orderIds = Object.keys(idx.orderByQuote).map(function (k) { return String(idx.orderByQuote[k].id); });
  var checked = await boardCheckedOrders_(orderIds);

  var byKey = function (field) {
    var out = {};
    quotes.forEach(function (q) {
      var k = String(q[field] || '');
      if (k) (out[k] = out[k] || []).push(q);
    });
    return out;
  };

  var cards = [];
  if (stream === STREAM_SPARE) {
    var quotesByEnquiry = byKey('spareEnquiryId');
    (await readTable_('SpareEnquiries')).forEach(function (e) {
      if (e.businessStream && String(e.businessStream) !== STREAM_SPARE) return;
      var status = String(e.status || 'New');
      cards.push(boardCard_({
        ref: 'SE:' + e.id, kind: 'enquiry', id: String(e.id), no: String(e.enquiryNo || ''),
        date: String(e.date || '').slice(0, 10),
        customerId: String(e.customerId || ''),
        customerName: customers[String(e.customerId)] || String(e.customerName || ''),
        what: [e.productModel, e.serialNo].filter(Boolean).join(' · ') || String(e.requirementText || ''),
        detail: String(e.requirementText || ''),
        type: String(e.enquiryType || '') || 'Spares',
        urgency: String(e.urgency || ''),
        source: String(e.source || ''),
        ownerEmail: String(e.ownerEmail || ''),
        followUp: String(e.expectedDeliveryDate || '').slice(0, 10),
        followUpLabel: 'Expected',
        floor: status === 'Identifying' || status === 'Quoted' || status === 'Won' ? 'requirement' : 'enquiry',
        closed: ['Lost', 'Dropped'].indexOf(status) !== -1
          ? status + (lostReasons[String(e.lostReasonId)] ? ': ' + lostReasons[String(e.lostReasonId)] : '') : '',
        handMoves: ['New', 'Identifying'].indexOf(status) !== -1
      }, quotesByEnquiry[String(e.id)] || [], idx, checked, lostReasons, people));
    });
    quotes.filter(function (q) { return !String(q.spareEnquiryId || ''); }).forEach(function (q) {
      cards.push(boardQuoteCard_(q, idx, checked, customers, lostReasons, people));
    });
  } else {
    var quotesByOpp = byKey('opportunityId');
    var opps = (await readTable_('Opportunities')).filter(function (o) {
      return !o.businessStream || String(o.businessStream) === STREAM_COMPRESSOR;
    });
    var oppsByLead = {};
    opps.forEach(function (o) {
      var k = String(o.leadId || '');
      if (k) (oppsByLead[k] = oppsByLead[k] || []).push(o);
    });
    var leadIds = {};
    var oppFloor = function (o) {
      var s = String(o.stage || '');
      if (s === 'Negotiation') return 'negotiation';
      if (s === 'PO Expected' || s === 'Won') return 'approved';
      return 'requirement';
    };
    (await readTable_('Leads')).forEach(function (l) {
      if (l.businessStream && String(l.businessStream) !== STREAM_COMPRESSOR) return;
      leadIds[String(l.id)] = true;
      var status = String(l.status || 'New');
      var lOpps = oppsByLead[String(l.id)] || [];
      var lQuotes = [];
      var floor = ['Qualified', 'Converted'].indexOf(status) !== -1 ? 'requirement' : 'enquiry';
      var oppLost = lOpps.length && lOpps.every(function (o) { return String(o.stage) === 'Lost'; });
      lOpps.forEach(function (o) {
        lQuotes = lQuotes.concat(quotesByOpp[String(o.id)] || []);
        if (String(o.stage) !== 'Lost' && boardRank_(oppFloor(o)) > boardRank_(floor)) floor = oppFloor(o);
      });
      cards.push(boardCard_({
        ref: 'LD:' + l.id, kind: 'lead', id: String(l.id), no: String(l.leadNo || ''),
        date: String(l.date || '').slice(0, 10),
        customerId: String(l.customerId || ''),
        customerName: customers[String(l.customerId)] || String(l.customerName || ''),
        what: String(l.requirementSummary || ''),
        detail: String(l.requirementSummary || ''),
        type: '', urgency: String(l.urgency || ''), source: String(l.source || ''),
        ownerEmail: String(l.ownerEmail || ''),
        followUp: String(l.nextActionDate || '').slice(0, 10),
        followUpLabel: 'Next action',
        floor: floor,
        closed: status === 'Disqualified'
          ? 'Disqualified' + (lostReasons[String(l.lostReasonId)] ? ': ' + lostReasons[String(l.lostReasonId)] : '')
          : (oppLost ? 'Opportunity lost' : ''),
        handMoves: ['New', 'Contacted', 'Qualified'].indexOf(status) !== -1 && !lOpps.length,
        opportunityId: lOpps.length ? String(lOpps[0].id) : ''
      }, lQuotes, idx, checked, lostReasons, people));
    });
    opps.filter(function (o) { return !leadIds[String(o.leadId || '')]; }).forEach(function (o) {
      cards.push(boardCard_({
        ref: 'OP:' + o.id, kind: 'opportunity', id: String(o.id), no: String(o.opportunityNo || ''),
        date: String(o.date || '').slice(0, 10),
        customerId: String(o.customerId || ''),
        customerName: customers[String(o.customerId)] || '',
        what: String(o.title || ''), detail: String(o.title || ''),
        type: '', urgency: '', source: '',
        ownerEmail: String(o.ownerEmail || ''),
        followUp: String(o.nextActionDate || '').slice(0, 10), followUpLabel: 'Next action',
        floor: String(o.stage) === 'Lost' ? 'requirement' : oppFloor(o),
        closed: String(o.stage) === 'Lost'
          ? 'Lost' + (lostReasons[String(o.lostReasonId)] ? ': ' + lostReasons[String(o.lostReasonId)] : '') : '',
        handMoves: false,
        expectedValue: o.expectedValue
      }, quotesByOpp[String(o.id)] || [], idx, checked, lostReasons, people));
    });
    quotes.filter(function (q) { return !String(q.opportunityId || ''); }).forEach(function (q) {
      cards.push(boardQuoteCard_(q, idx, checked, customers, lostReasons, people));
    });
  }

  // Finished work leaves the board after a while; open work never does.
  var since = addDays_(todayIso_(), -BOARD_RECENT_DAYS);
  cards = cards.filter(function (c) {
    if (c.stage !== 'dispatched' && c.stage !== 'lost') return true;
    return String(c.lastDate || c.date || '') >= since;
  });
  cards.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });

  // The escalations on each card (Escalations.gs): the one waiting, and the earlier ones.
  var escs = await escForCards_(user);
  cards.forEach(function (c) {
    var x = escs[c.ref];
    c.escalation = x ? x.open : null;
    c.escalations = x ? x.history : [];
  });

  var names = await boardStageNames_();
  var editors = stream === STREAM_SPARE ? ENQUIRY_EDITORS : LEAD_EDITORS;
  return {
    stream: stream,
    stages: BOARD_STAGES.map(function (s) {
      return { key: s.key, label: names[s.key].label, standard: s.label, how: s.how, when: s.when || '', id: names[s.key].id };
    }),
    closed: { key: BOARD_CLOSED.key, label: names.lost.label, standard: BOARD_CLOSED.label, id: names.lost.id },
    cards: cards,
    recentDays: BOARD_RECENT_DAYS,
    canMove: editors.indexOf(user.role) !== -1,
    canRename: MASTER_EDITORS.indexOf(user.role) !== -1,
    // Who a card can be escalated to.
    escalateTo: await escTargets_(user),
    me: user.email
  };
}

/**
 * One card, from the record it stands for and its quotations.
 *
 * The furthest-along live quotation sets the stage. When every quotation is lost or expired,
 * so is the card, unless an order came of one anyway. The record's own stage is a floor: an
 * enquiry whose parts are named is past "received" whether or not it has been quoted.
 */
function boardCard_(base, quotes, idx, checked, lostReasons, people) {
  var best = null;
  var bestRank = -1;
  var closedQuote = null;
  quotes.forEach(function (q) {
    var stage = boardQuoteStage_(q, idx, checked);
    if (stage === 'lost') { closedQuote = closedQuote || q; return; }
    var rank = boardRank_(stage);
    if (rank > bestRank || (rank === bestRank && String(q.date) > String(best.q.date))) {
      best = { q: q, stage: stage };
      bestRank = rank;
    }
  });

  var stage;
  var closedWhy = '';
  var hasOrder = best && boardRank_(best.stage) >= boardRank_('po');
  if (base.closed && !hasOrder) {
    stage = 'lost';
    closedWhy = base.closed;
  } else if (!best && closedQuote) {
    stage = 'lost';
    closedWhy = String(closedQuote.status) === 'Expired' ? 'Offer expired'
      : 'Quotation lost' + (lostReasons[String(closedQuote.lostReasonId)] ? ': ' + lostReasons[String(closedQuote.lostReasonId)] : '');
  } else {
    stage = best && bestRank > boardRank_(base.floor) ? best.stage : base.floor;
  }

  var q = best ? best.q : closedQuote;
  var order = q ? idx.orderByQuote[String(q.id)] || null : null;
  var dispatch = order ? idx.dispatchByOrder[String(order.id)] || null : null;
  var value = order && order.grand !== '' && order.grand !== undefined ? Number(order.grand) || 0
    : q && q.grand !== '' && q.grand !== undefined ? Number(q.grand) || 0
    : base.expectedValue !== undefined && base.expectedValue !== '' ? Number(base.expectedValue) || 0 : '';
  var lastDate = [base.date, q && q.date, q && q.submittedDate, q && q.lostDate, order && order.date,
    dispatch && dispatch.dispatchDate].filter(Boolean).map(function (d) { return String(d).slice(0, 10); })
    .sort().pop() || '';

  return {
    ref: base.ref, kind: base.kind, id: base.id, no: base.no, date: base.date, lastDate: lastDate,
    customerId: base.customerId, customerName: base.customerName,
    what: base.what, detail: base.detail, type: base.type, urgency: base.urgency, source: base.source,
    ownerEmail: base.ownerEmail, ownerName: personLine_(base.ownerEmail, people),
    followUp: stage === 'lost' || stage === 'dispatched' ? '' : base.followUp,
    followUpLabel: base.followUpLabel,
    stage: stage, closedWhy: closedWhy, value: value,
    // What the hand-set stages may do from here; the server checks again on the move.
    moves: boardMoves_(stage, base, best),
    opportunityId: base.opportunityId || '',
    quote: q ? {
      id: String(q.id), quoteNo: String(q.quoteNo || ''), revision: String(q.revision || ''),
      status: String(q.status || ''), date: String(q.date || '').slice(0, 10),
      sentDate: String(q.submittedDate || q.emailSentDate || '').slice(0, 10)
    } : null,
    quoteCount: quotes.length,
    order: order ? {
      id: String(order.id), orderNo: String(order.orderNo || ''), status: String(order.orderStatus || ''),
      poNo: String(order.poNo || ''), creditHold: isTrue_(order.creditHold)
    } : null,
    dispatch: dispatch ? {
      dispatchNo: String(dispatch.dispatchNo || ''), date: String(dispatch.dispatchDate || '').slice(0, 10),
      status: String(dispatch.status || '')
    } : null
  };
}

function boardMoves_(stage, base, best) {
  if (stage === 'enquiry' && base.handMoves) return ['requirement'];
  if (stage === 'requirement' && base.handMoves && base.floor === 'requirement' && !best) return ['enquiry'];
  if (stage === 'sent' && best && best.stage === 'sent') return ['negotiation'];
  if (stage === 'negotiation' && best && best.stage === 'negotiation') return ['sent'];
  return [];
}

/** A quotation raised with no enquiry, lead or opportunity behind it, as a card of its own. */
function boardQuoteCard_(q, idx, checked, customers, lostReasons, people) {
  return boardCard_({
    ref: 'QT:' + q.id, kind: 'quotation', id: String(q.id), no: String(q.quoteNo || ''),
    date: String(q.date || '').slice(0, 10),
    customerId: String(q.customerId || ''), customerName: customers[String(q.customerId)] || '',
    what: [q.machineModel, q.serialNo].filter(Boolean).join(' · '),
    detail: '', type: '', urgency: '', source: 'No enquiry logged',
    ownerEmail: String(q.preparedBy || ''), followUp: '', followUpLabel: '',
    floor: 'quoted', closed: '', handMoves: false
  }, [q], idx, checked, lostReasons, people);
}

/**
 * Moves a card along a stage that is set by hand, and nothing else: the others follow the
 * records, and moving them here would make the board disagree with the screen that owns them.
 *
 *   enquiry ⇄ requirement   writes the enquiry's or lead's own status;
 *   sent → negotiation      marks the quotation Negotiating, with a note of what is being
 *                           discussed (logged against the quotation);
 *   negotiation → sent      takes it back, keeping the dates it was sent on.
 */
async function moveBoardCard(input) {
  var user = getCurrentUser();
  var ref = String(input && input.ref || '');
  var to = String(input && input.to || '');
  var note = String(input && input.note || '').trim();
  var kind = ref.slice(0, 2);
  var id = ref.slice(3);
  if (!id || ['SE', 'LD', 'OP', 'QT'].indexOf(kind) === -1) throw new Error('That card is not on the board.');
  var stream = kind === 'SE' || (kind === 'QT' && String((await findRowById_('Quotations', id) || {}).businessStream) === STREAM_SPARE)
    ? STREAM_SPARE : STREAM_COMPRESSOR;
  requireCommercial_(user, 'The enquiry board');
  requireStream_(user, stream, 'The enquiry board');

  var board = await getEnquiryBoard({ stream: stream });
  var card = board.cards.filter(function (c) { return c.ref === ref; })[0];
  if (!card) throw new Error('That card is no longer on the board.');
  if (card.moves.indexOf(to) === -1) {
    var names = {};
    board.stages.forEach(function (s) { names[s.key] = s.label; });
    throw new Error('“' + (names[card.stage] || card.stage) + '” cannot be moved to “' + (names[to] || to) +
      '” by hand. ' + (card.stage === 'enquiry' || card.stage === 'requirement'
        ? 'It moves on by itself once a quotation is prepared.'
        : 'This stage follows the quotation, the order and the dispatch.'));
  }

  if (to === 'requirement' || to === 'enquiry') {
    if (kind === 'SE') {
      requireRole_(user, ENQUIRY_EDITORS);
      await updateRowById_('SpareEnquiries', 'id', id, { status: to === 'requirement' ? 'Identifying' : 'New' },
        to === 'requirement' ? 'Board: requirement understood' : 'Board: back to enquiry received');
    } else if (kind === 'LD') {
      requireRole_(user, LEAD_EDITORS);
      await updateRowById_('Leads', 'id', id, { status: to === 'requirement' ? 'Qualified' : 'New' },
        to === 'requirement' ? 'Board: requirement understood' : 'Board: back to enquiry received');
    }
    if (note) await boardNote_(card, note, user);
  } else {
    requireRole_(user, QUOTE_EDITORS);
    if (!card.quote) throw new Error('There is no quotation on this card.');
    if (to === 'negotiation' && note.length < 5) {
      throw new Error('Say what the customer is discussing — the price, the terms, delivery — so whoever picks it up knows.');
    }
    await updateRowById_('Quotations', 'id', card.quote.id, { status: to === 'negotiation' ? 'Negotiating' : 'Submitted' },
      to === 'negotiation' ? 'Board: in negotiation' : 'Board: back to quotation sent');
    var q = await findRowById_('Quotations', card.quote.id);
    if (q && q.opportunityId) {
      var opp = await findRowById_('Opportunities', q.opportunityId);
      if (opp && ['Won', 'Lost', 'PO Expected'].indexOf(String(opp.stage)) === -1) {
        await updateRowById_('Opportunities', 'id', q.opportunityId, { stage: to === 'negotiation' ? 'Negotiation' : 'Quotation' },
          'Kept in step with quotation ' + q.quoteNo);
      }
    }
    if (note) {
      await appendRow_('Activities', {
        id: generateId_('ACT-'), relatedType: 'Quotation', relatedId: card.quote.id,
        activityType: 'Note', activityDate: todayIso_(), ownerEmail: user.email, contactPerson: '',
        notes: (to === 'negotiation' ? 'In negotiation: ' : 'Back to quotation sent: ') + note,
        outcome: '', nextActionDate: '', status: 'Logged', createdAt: todayIso_(), createdBy: user.email
      }, 'Board note');
    }
  }
  var after = (await getEnquiryBoard({ stream: stream })).cards.filter(function (c) { return c.ref === ref; })[0];
  return after || card;
}

/** A note on a move between the first two stages, kept where ERP 1 keeps notes on the record. */
async function boardNote_(card, note, user) {
  // A spare enquiry has no follow-up log of its own in ERP 1; its requirement text is what
  // the desk reads, so the note is kept in the audit trail only, with the move.
  if (card.kind !== 'lead') return;
  await appendRow_('Activities', {
    id: generateId_('ACT-'), relatedType: 'Lead', relatedId: card.id, activityType: 'Note',
    activityDate: todayIso_(), ownerEmail: user.email, contactPerson: '', notes: note, outcome: '',
    nextActionDate: '', status: 'Logged', createdAt: todayIso_(), createdBy: user.email
  }, 'Board note');
}

/** Renames one stage on both desks' boards. Management and ERP Admin, as for every list. */
async function saveBoardStageName(key, label) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  var k = String(key || '').trim();
  var known = BOARD_STAGES.concat([BOARD_CLOSED]).filter(function (s) { return s.key === k; })[0];
  if (!known) throw new Error('There is no stage called that. Stages can be renamed, not added.');
  var name = String(label || '').trim();
  if (!name) throw new Error('A stage needs a name.');
  if (name.length > 40) throw new Error('Keep a stage name under 40 characters, so it fits its column.');
  var existing = (await readTable_('ConfigLists')).filter(function (r) {
    return String(r.category) === 'BoardStage' && String(r.code) === k;
  })[0];
  await saveConfigListItem({ id: existing ? existing.id : '', category: 'BoardStage', code: k, label: name,
    sortOrder: boardRank_(k) === -1 ? 99 : boardRank_(k) + 1 });
  return await boardStageNames_();
}
