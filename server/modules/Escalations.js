/**
 * Converted from src/Escalations.gs by migration/to-async.js.
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
 * ERP 2.0's escalations: a deal handed to a named person for a decision, with a note saying
 * what needs deciding, and their answer kept with it.
 *
 *   - Anybody on the sales side escalates an enquiry board card (spare enquiry, compressor
 *     lead, opportunity or quotation) to a Sales Coordinator or to Management, by name.
 *   - Management answers with a decision and an instruction: send it back, approve, won or
 *     lost. A coordinator it was sent to replies and sends it back. Management can answer any.
 *   - Whoever escalated it can withdraw it while it waits. One escalation waits on a card at
 *     a time.
 *
 * Two of ERP 2's rules are left out on purpose:
 *   - Moving a deal to "In negotiation" does not escalate it by itself, and the coordinator
 *     is not stopped from closing a deal while it waits. The coordinator looking after the
 *     customer decides, as in ERP 1.
 *   - A decision does not change the quotation or the enquiry. "Won" and "Lost" are
 *     Management's word to the coordinator, who marks the quotation won or lost as now, with
 *     ERP 1's own steps (the PO, the credit check, the lost reason).
 *
 * Sales work: service sees none of it (requireCommercial_). Shown on the 2.0 face only.
 */

var ESC_DECISIONS = ['Sent back', 'Approved', 'Won', 'Lost'];
var ESC_REPLY = 'Replied';
/** Who a deal can be escalated to. */
var ESC_TARGET_ROLES = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
var ESC_WORDS = { enquiry: 'Spare enquiry', lead: 'Compressor lead', opportunity: 'Opportunity', quotation: 'Quotation' };

function escBoss_(user) { return MASTER_EDITORS.indexOf(String(user.role)) !== -1; }
function escSame_(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

/** Management sees every escalation; everybody else the ones they raised, were sent, or own. */
function escVisible_(e, user) {
  if (!streamAllowed_(user, String(e.stream || ''))) return false;
  if (escBoss_(user)) return true;
  return escSame_(e.createdBy, user.email) || escSame_(e.toEmail, user.email) || escSame_(e.ownerEmail, user.email);
}

/** What this person may answer: Management decides, the coordinator it was sent to replies. */
function escOutcomes_(e, user) {
  if (String(e.status) !== 'Open') return [];
  if (escBoss_(user)) return ESC_DECISIONS;
  if (escSame_(e.toEmail, user.email)) return [ESC_REPLY];
  return [];
}

async function escTargets_(user) {
  return (await readTable_('Users')).filter(function (u) {
    return String(u.active).toUpperCase() !== 'FALSE' && ESC_TARGET_ROLES.indexOf(String(u.role)) !== -1 &&
      String(u.email || '') && !escSame_(u.email, user.email);
  }).map(function (u) { return { email: String(u.email), name: String(u.name || u.email), role: String(u.role) }; })
    .sort(function (a, b) {
      var boss = function (x) { return x.role === ROLES.SALES_COORDINATOR ? 1 : 0; };
      return boss(a) - boss(b) || a.name.localeCompare(b.name);
    });
}

async function escRows_() {
  try { return await readTable_('Escalations'); } catch (err) { return []; }
}

function escOut_(e, user, people, today) {
  var raised = taskDay_(e.createdAt);
  var decided = taskDay_(e.decidedAt);
  var open = String(e.status) === 'Open';
  return {
    id: String(e.id), cardRef: String(e.cardRef || ''), kind: String(e.recordKind || ''), recordId: String(e.recordId || ''),
    label: String(e.recordLabel || ''), word: ESC_WORDS[String(e.recordKind)] || 'Enquiry',
    stream: String(e.stream || ''), desk: String(e.stream) === STREAM_COMPRESSOR ? 'Compressor' : 'Spares',
    customerName: String(e.customerName || ''), ownerName: personLine_(e.ownerEmail, people),
    value: e.raisedValue === '' || e.raisedValue === null || e.raisedValue === undefined ? '' : Number(e.raisedValue),
    raisedByEmail: String(e.createdBy || ''), raisedByName: personLine_(e.createdBy, people), raisedDay: raised,
    toEmail: String(e.toEmail || ''), toName: personLine_(e.toEmail, people), note: String(e.note || ''),
    status: String(e.status || 'Open'), outcome: String(e.outcome || ''), decisionNote: String(e.decisionNote || ''),
    decidedByName: personLine_(e.decidedBy, people), decidedDay: decided,
    waitingDays: daysBetween_(raised, open ? today : decided),
    outcomes: escOutcomes_(e, user),
    canWithdraw: open && (escBoss_(user) || escSame_(e.createdBy, user.email))
  };
}

/** The card behind a board reference, read from the board itself, on the desks this person works. */
async function escFindCard_(user, ref) {
  var r = String(ref || '');
  var streams = /^SE:/.test(r) ? [STREAM_SPARE] : /^(LD|OP):/.test(r) ? [STREAM_COMPRESSOR] : [STREAM_SPARE, STREAM_COMPRESSOR];
  for (var s of streams) {
    if (!streamAllowed_(user, s)) continue;
    var board = await getEnquiryBoard({ stream: s });
    var card = board.cards.filter(function (c) { return c.ref === r; })[0];
    if (card) { card.stream = board.stream; return card; }
  }
  return null;
}

/**
 * Escalates a board card to a named person.
 *
 * @param input { ref: board card reference, toEmail, note: what needs deciding }
 */
async function escalateCard(input) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Escalating a deal');
  var i = input || {};
  var note = String(i.note || '').trim();
  if (note.length < 5) throw new Error('Say what needs deciding, in a few words.');
  if (note.length > 1000) throw new Error('Keep it under 1,000 characters.');
  var to = (await escTargets_(user)).filter(function (p) { return escSame_(p.email, i.toEmail); })[0];
  if (!to) {
    throw new Error(escSame_(i.toEmail, user.email) ? 'Escalate it to somebody else.'
      : 'Pick a Sales Coordinator or somebody in Management who is still in Users.');
  }
  var card = await escFindCard_(user, i.ref);
  if (!card) throw new Error('That enquiry is no longer on the board.');
  if (card.stage === 'lost' || card.stage === 'dispatched') throw new Error('That deal is closed; there is nothing left to decide.');
  var waiting = (await escRows_()).filter(function (e) { return String(e.cardRef) === String(i.ref) && String(e.status) === 'Open'; })[0];
  if (waiting) {
    throw new Error('It is already with ' + personLine_(waiting.toEmail, await userNameMap_()) + ' for a decision, since ' +
      taskDay_(waiting.createdAt) + '. Withdraw that one first to send it to somebody else.');
  }
  var id = generateId_('ES-');
  await appendRow_('Escalations', {
    id: id, cardRef: String(i.ref), recordKind: card.kind, recordId: card.id,
    recordLabel: card.no || ESC_WORDS[card.kind] || '', stream: card.stream, customerName: card.customerName || '',
    ownerEmail: card.ownerEmail || '', raisedValue: card.value === '' || card.value === undefined ? '' : card.value,
    toEmail: to.email, note: note, status: 'Open', createdAt: nowIso_(), createdBy: user.email
  }, 'Escalated to ' + to.email);
  return escOut_(await findRowById_('Escalations', id), user, await userNameMap_(), todayIso_());
}

/** Management's decision, or the named coordinator's reply, with the instruction that goes back. */
async function decideEscalation(id, outcome, note) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Escalations');
  var e = await findRowById_('Escalations', id);
  if (!e || !escVisible_(e, user)) throw new Error('That escalation is no longer there.');
  if (String(e.status) !== 'Open') throw new Error('That escalation has already been ' + (String(e.status) === 'Withdrawn' ? 'withdrawn.' : 'answered.'));
  var allowed = escOutcomes_(e, user);
  var o = String(outcome || '');
  if (allowed.indexOf(o) === -1) {
    throw new Error(!allowed.length ? 'Only ' + personLine_(e.toEmail, await userNameMap_()) + ' or Management can answer this.'
      : allowed[0] === ESC_REPLY ? 'Your answer is a reply, sent back to whoever escalated it. The decision is Management’s.'
      : 'Answer with Sent back, Approved, Won or Lost.');
  }
  var text = String(note || '').trim();
  if (text.length < 3) throw new Error('Write your decision or instruction first.');
  await updateRowById_('Escalations', 'id', id, { status: 'Decided', outcome: o, decisionNote: text, decidedAt: nowIso_(), decidedBy: user.email },
    'Escalation answered: ' + o);
  return escOut_(await findRowById_('Escalations', id), user, await userNameMap_(), todayIso_());
}

/** Takes an escalation back while it waits. Whoever raised it, or Management. */
async function withdrawEscalation(id) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Escalations');
  var e = await findRowById_('Escalations', id);
  if (!e || !escVisible_(e, user)) throw new Error('That escalation is no longer there.');
  if (String(e.status) !== 'Open') throw new Error('That escalation is no longer waiting.');
  if (!escBoss_(user) && !escSame_(e.createdBy, user.email)) throw new Error('Only whoever escalated it, or Management, can withdraw it.');
  await updateRowById_('Escalations', 'id', id, { status: 'Withdrawn', outcome: 'Withdrawn', decidedAt: nowIso_(), decidedBy: user.email },
    'Escalation withdrawn');
  return escOut_(await findRowById_('Escalations', id), user, await userNameMap_(), todayIso_());
}

/** The Escalations screen: what waits for a decision, oldest first, and what was decided lately. */
async function getEscalations() {
  var user = getCurrentUser();
  requireCommercial_(user, 'Escalations');
  var people = await userNameMap_();
  var today = todayIso_();
  var since = addDays_(today, -60);
  var rows = (await escRows_()).filter(function (e) { return escVisible_(e, user); });
  var open = rows.filter(function (e) { return String(e.status) === 'Open'; })
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); })
    .map(function (e) { return escOut_(e, user, people, today); });
  var recent = rows.filter(function (e) { return String(e.status) !== 'Open' && taskDay_(e.decidedAt) >= since; })
    .sort(function (a, b) { return String(b.decidedAt).localeCompare(String(a.decidedAt)); }).slice(0, 40)
    .map(function (e) { return escOut_(e, user, people, today); });
  var month = today.slice(0, 7);
  return {
    today: today, me: String(user.email), boss: escBoss_(user), open: open, recent: recent,
    kpis: {
      waiting: open.length,
      compressor: open.filter(function (e) { return e.desk === 'Compressor'; }).length,
      spares: open.filter(function (e) { return e.desk === 'Spares'; }).length,
      toMe: open.filter(function (e) { return e.outcomes.length && escSame_(e.toEmail, user.email); }).length,
      decidedThisMonth: recent.filter(function (e) { return e.status === 'Decided' && e.decidedDay.slice(0, 7) === month; }).length
    }
  };
}

/**
 * The escalations on each board card, for the board (EnquiryBoard.gs): the one waiting, if
 * any, and the earlier ones, newest first.
 */
async function escForCards_(user) {
  var people = await userNameMap_();
  var today = todayIso_();
  var out = {};
  (await escRows_()).filter(function (e) { return escVisible_(e, user); })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })
    .forEach(function (e) {
      var k = String(e.cardRef || '');
      var slot = out[k] = out[k] || { open: null, history: [] };
      var x = escOut_(e, user, people, today);
      if (x.status === 'Open') slot.open = x;
      else slot.history.push(x);
    });
  return out;
}

/** For the person's dashboard: what waits on them, and theirs waiting on somebody else. */
async function escSummary_(email, everyone) {
  var e = String(email || '').toLowerCase();
  var today = todayIso_();
  var open = (await escRows_()).filter(function (x) { return String(x.status) === 'Open'; });
  var mine = everyone ? open : open.filter(function (x) { return escSame_(x.toEmail, e); });
  return {
    toThem: mine.length,
    waitingLong: mine.filter(function (x) { return daysBetween_(taskDay_(x.createdAt), today) > 3; }).length,
    theirs: open.filter(function (x) { return escSame_(x.createdBy, e); }).length
  };
}
