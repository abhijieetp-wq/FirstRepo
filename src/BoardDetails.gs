/**
 * ERP 2.0's enquiry drawer, behind the board on both desks: the next follow-up, the flag and
 * the owner as dropdowns; follow-ups logged against the enquiry; marking it lost with a reason.
 *
 * Every one of them writes ERP 1's own records, so the lists and forms agree with the board:
 *   - the next follow-up is a lead's or opportunity's nextActionDate, and a spare enquiry's
 *     nextFollowUpDate (a date of its own; its expected-delivery date is left alone);
 *   - the owner is the record's ownerEmail;
 *   - a follow-up is a row in Activities, where ERP 1 keeps follow-ups on leads and
 *     opportunities (CompressorSales.gs) — spare enquiries now use it too;
 *   - lost is the record's own closed status with a lost reason: Lost on a spare enquiry,
 *     Disqualified on a lead, Lost on an opportunity.
 * The flag (Hot, Warm, Cold…) is the one thing ERP 1 had no place for; it is a column of its own.
 */

var BOARD_FLAGS = ['Hot', 'Warm', 'Cold', 'Price issue', 'Competitor in play', 'Budget pending'];
var BOARD_FOLLOWUP_MODES = ['Call', 'Visit', 'WhatsApp', 'E-mail'];
// Who hands an enquiry to somebody else: the coordinators, and Management.
var BOARD_OWNER_SETTERS = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
var BOARD_RECORDS = {
  SE: { table: 'SpareEnquiries', related: 'SpareEnquiry', stream: 'Spare Sales', what: 'enquiry' },
  LD: { table: 'Leads', related: 'Lead', stream: 'Compressor Sales', what: 'lead' },
  OP: { table: 'Opportunities', related: 'Opportunity', stream: 'Compressor Sales', what: 'opportunity' },
  QT: { table: 'Quotations', related: 'Quotation', stream: '', what: 'quotation' }
};

/** "LD:L1" → "Lead:L1": where a card's follow-ups are kept in Activities. */
function boardLogKey_(ref) {
  var spec = BOARD_RECORDS[String(ref).slice(0, 2)];
  return spec ? spec.related + ':' + String(ref).slice(3) : '';
}

function boardLogCounts_() {
  var out = {};
  try {
    readTable_('Activities').forEach(function (a) {
      var k = String(a.relatedType || '') + ':' + String(a.relatedId || '');
      out[k] = (out[k] || 0) + 1;
    });
  } catch (err) { /* no Activities tab yet */ }
  return out;
}

/** Who can own an enquiry on this desk: its coordinators, and Management. */
function boardOwners_(stream) {
  return readTable_('Users').filter(function (u) {
    if (String(u.active).toUpperCase() === 'FALSE') return false;
    var role = String(u.role || '');
    if (role === ROLES.MANAGEMENT) return true;
    if (role !== ROLES.SALES_COORDINATOR && role !== ROLES.SALES_ENGINEER) return false;
    var s = String(u.businessStream || 'All');
    return s === 'All' || s === stream;
  }).map(function (u) { return { email: String(u.email), name: String(u.name || u.email), role: String(u.role) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function boardLostReasons_(stream) {
  try {
    return readTable_('LostReasons').filter(function (r) {
      if (String(r.active).toUpperCase() === 'FALSE') return false;
      var to = String(r.appliesTo || 'All');
      return to === 'All' || (stream === STREAM_SPARE ? to === 'Spare' : to !== 'Spare');
    }).map(function (r) { return { id: String(r.id), text: String(r.reasonText || '') }; });
  } catch (err) { return []; }
}

/** The card's record, after the checks every change here makes: the desk, the role, the card. */
function boardRecord_(ref, user, editors) {
  var kind = String(ref || '').slice(0, 2);
  var id = String(ref || '').slice(3);
  var spec = BOARD_RECORDS[kind];
  if (!spec || !id) throw new Error('That card is not on the board.');
  var row = findRowById_(spec.table, id);
  if (!row) throw new Error('That ' + spec.what + ' is no longer there.');
  var stream = spec.stream || String(row.businessStream || STREAM_SPARE);
  requireCommercial_(user, 'The enquiry board');
  requireStream_(user, stream, 'The enquiry board');
  requireRole_(user, editors || (stream === STREAM_SPARE ? ENQUIRY_EDITORS : LEAD_EDITORS));
  return { kind: kind, id: id, spec: spec, row: row, stream: stream };
}

function boardCardAfter_(r) {
  return getEnquiryBoard({ stream: r.stream }).cards.filter(function (c) { return c.ref === r.kind + ':' + r.id; })[0] || null;
}

/** The follow-up date column a record keeps its next chase in. */
function boardFollowUpColumn_(kind) {
  return kind === 'SE' ? 'nextFollowUpDate' : kind === 'QT' ? '' : 'nextActionDate';
}

/**
 * One of the drawer's dropdowns: the next follow-up, the flag or the owner.
 *
 * @param input { ref, field: 'followUp' | 'flag' | 'owner', value }
 * @return the card, as the board now shows it
 */
function setBoardCardDetail(input) {
  var user = getCurrentUser();
  var i = input || {};
  var field = String(i.field || '');
  var value = String(i.value === null || i.value === undefined ? '' : i.value).trim();
  var r = boardRecord_(i.ref, user, field === 'owner' ? BOARD_OWNER_SETTERS : null);
  var patch = {};
  var reason = '';
  if (field === 'followUp') {
    var col = boardFollowUpColumn_(r.kind);
    if (!col) throw new Error('A quotation on its own has no follow-up date here. Open the quotation.');
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Give the follow-up as a date.');
    if (!value && r.kind === 'LD') throw new Error('An open lead must always have a next follow-up date.');
    patch[col] = value;
    reason = value ? 'Board: next follow-up ' + value : 'Board: follow-up date cleared';
  } else if (field === 'flag') {
    if (r.kind === 'QT') throw new Error('A quotation on its own has no flag. Flag the enquiry it is for.');
    if (value && BOARD_FLAGS.indexOf(value) === -1) throw new Error('Pick the flag from the list.');
    patch.flag = value;
    reason = 'Board: flag ' + (value || 'cleared');
  } else if (field === 'owner') {
    if (r.kind === 'QT') throw new Error('A quotation is owned by whoever prepared it.');
    var who = boardOwners_(r.stream).filter(function (p) { return p.email.toLowerCase() === value.toLowerCase(); })[0];
    if (!who) throw new Error('Pick the owner from the list.');
    patch.ownerEmail = who.email;
    reason = 'Board: owner ' + who.name;
  } else {
    throw new Error('That cannot be changed from the board.');
  }
  updateRowById_(r.spec.table, 'id', r.id, patch, reason);
  return boardCardAfter_(r);
}

/**
 * A follow-up: what happened, how, and when to chase next. Kept in Activities against the
 * card's record; the next date also becomes the card's follow-up.
 *
 * @param input { ref, mode, text, nextDate }
 * @return { card, log }
 */
function addBoardFollowUp(input) {
  var user = getCurrentUser();
  var i = input || {};
  var r = boardRecord_(i.ref, user, null);
  var text = String(i.text || '').trim();
  if (!text) throw new Error('Write what happened first.');
  if (text.length > 2000) throw new Error('Keep a follow-up under 2,000 characters.');
  var mode = BOARD_FOLLOWUP_MODES.indexOf(String(i.mode)) !== -1 ? String(i.mode) : 'Call';
  var next = String(i.nextDate || '').slice(0, 10);
  if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next)) throw new Error('Give the next follow-up as a date.');
  var now = todayIso_();
  appendRow_('Activities', {
    id: generateId_('ACT-'), relatedType: r.spec.related, relatedId: r.id, activityType: mode, activityDate: now,
    ownerEmail: user.email, contactPerson: String(r.row.contactName || ''), notes: text, outcome: '',
    nextActionDate: next, status: 'Logged', createdAt: nowIso_(), createdBy: user.email
  }, 'Board follow-up');
  var col = boardFollowUpColumn_(r.kind);
  if (next && col) updateRowById_(r.spec.table, 'id', r.id, (function () { var p = {}; p[col] = next; return p; })(), 'Board: next follow-up ' + next);
  return { card: boardCardAfter_(r), log: getBoardCardLog(i.ref) };
}

/** The follow-ups on a card's record, newest first, with who logged each. */
function getBoardCardLog(ref) {
  var user = getCurrentUser();
  var r = boardRecord_(ref, user, COMMERCIAL_SIDE);
  var people = userNameMap_();
  var rows = [];
  try {
    rows = findRowsByColumn_('Activities', 'relatedId', [r.id]).filter(function (a) { return String(a.relatedType) === r.spec.related; });
  } catch (err) { rows = []; }
  return rows.map(function (a) {
    return { at: String(a.activityDate || a.createdAt || '').slice(0, 10), stamp: String(a.createdAt || ''), mode: String(a.activityType || ''),
      text: String(a.notes || ''), next: String(a.nextActionDate || '').slice(0, 10), by: personLine_(String(a.createdBy || a.ownerEmail || ''), people) };
  }).sort(function (a, b) { return (b.at + b.stamp).localeCompare(a.at + a.stamp); });
}

/**
 * Closes the card as lost, with the reason, on the record itself: a spare enquiry Lost, a lead
 * Disqualified, an opportunity Lost. A quotation already sent stays as it is — the customer's
 * answer on the offer is marked on the quotation, as ERP 1 does.
 *
 * @param input { ref, reasonId, note }
 */
function markBoardCardLost(input) {
  var user = getCurrentUser();
  var i = input || {};
  var r = boardRecord_(i.ref, user, null);
  if (r.kind === 'QT') throw new Error('Mark a quotation lost on the quotation itself.');
  var reason = boardLostReasons_(r.stream).filter(function (x) { return x.id === String(i.reasonId || ''); })[0];
  if (!reason) throw new Error('Pick why it was lost.');
  var note = String(i.note || '').trim();
  var patch = { lostReasonId: reason.id };
  if (r.kind === 'SE') patch.status = 'Lost';
  else if (r.kind === 'LD') patch.status = 'Disqualified';
  else { patch.stage = 'Lost'; if (note) patch.lostNotes = note; }
  updateRowById_(r.spec.table, 'id', r.id, patch, 'Board: lost — ' + reason.text + (note ? ': ' + note : ''));
  appendRow_('Activities', {
    id: generateId_('ACT-'), relatedType: r.spec.related, relatedId: r.id, activityType: 'Note', activityDate: todayIso_(),
    ownerEmail: user.email, contactPerson: '', notes: 'Marked lost: ' + reason.text + (note ? ' — ' + note : ''), outcome: 'Lost',
    nextActionDate: '', status: 'Logged', createdAt: nowIso_(), createdBy: user.email
  }, 'Board: lost');
  return boardCardAfter_(r);
}
