/**
 * Keeping a stream's work to the people who work in it.
 *
 * PIE run three front offices under ELGi: Unit Sales (compressors), Spare Sales, and Service.
 * Each has its own coordinator, and a spare-sales coordinator has no business reading
 * compressor deals — their customers, their pricing and their negotiations are somebody
 * else's.
 *
 * `businessStream` on a user has recorded this since the beginning and restricted nothing: it
 * was written onto the user record at sign-in and never read again, so the field looked like a
 * permission and behaved like a label. This is that field finally doing its job.
 *
 * Two deliberate holes in it:
 *
 *  - Management and the ERP admin are 'All' and always were. Somebody has to be able to see
 *    the whole business.
 *  - A record with no stream on it is visible to everybody. Customers, contacts, addresses and
 *    the catalogue are shared by both offices — that was the point of one customer master —
 *    and hiding a customer from the office that does not happen to be selling to them today
 *    would break the thing the shared master was for.
 *
 * Service work is deliberately not gated. An engineer fits spares onto compressors; a job that
 * belongs to one stream only in the sense that it came from one is still service work, and the
 * service office covers both.
 */

var STREAM_ALL = 'All';

/** Whether this user may see a record belonging to `stream`. */
function streamAllowed_(user, stream) {
  if (!user) return false;
  var mine = String(user.businessStream || STREAM_ALL);
  if (mine === STREAM_ALL) return true;
  var theirs = String(stream || '').trim();
  if (!theirs) return true;              // shared reference data belongs to nobody in particular
  return theirs === mine;
}

/**
 * Refuses a record from another stream.
 *
 * The message names the stream rather than saying "not permitted", because the usual cause is
 * a link or a bookmark to somebody else's work rather than an attempt to snoop.
 */
function requireStream_(user, stream, what) {
  if (streamAllowed_(user, stream)) return;
  if (String(user.homeStream || '') === STREAM_ALL) {
    throw new Error((what || 'That record') + ' belongs to ' + String(stream) + '. You are on the ' +
      String(user.businessStream) + ' desk: switch desks at the top of the page to open it.');
  }
  throw new Error((what || 'That record') + ' belongs to ' + String(stream) +
    '. You work in ' + String(user.businessStream) + '.');
}

/** Drops rows from other streams out of a list. */
function forStream_(user, rows, field) {
  var mine = String((user && user.businessStream) || STREAM_ALL);
  if (mine === STREAM_ALL) return rows;
  var key = field || 'businessStream';
  return rows.filter(function (r) { return streamAllowed_(user, r[key]); });
}

/** The streams a screen has to belong to for this user to be offered it. */
function streamsFor_(user) {
  var mine = String((user && user.businessStream) || STREAM_ALL);
  return mine === STREAM_ALL ? BUSINESS_STREAMS.slice() : [mine];
}

/**
 * The desk somebody who works both streams is on.
 *
 * A coordinator who looks after compressors and spares alike saw both mixed together: one list
 * of quotations, one dashboard, both front offices in the menu, with a small tag the only way
 * to tell a spares offer from a unit one. They work one desk at a time instead, and flip
 * between them at the top of the page. On a desk they are, for every screen and every list,
 * exactly what a coordinator of that stream alone is (`businessStream` is the desk), so
 * nothing else in the ERP has to know desks exist.
 *
 * Combined ('All') is a desk too, for seeing both at once. Users.desk keeps their choice.
 * Management and the ERP admin start on Combined; anybody else who works both starts on
 * Compressor Sales, since working the desks apart is what it is for.
 * Somebody who works one stream has no desk: '' here.
 */
function deskOf_(home, crossStream, stored) {
  if (String(home) !== STREAM_ALL) return '';
  var d = String(stored || '').trim();
  if (d === STREAM_ALL) return '';
  if (BUSINESS_STREAMS.indexOf(d) !== -1) return d;
  return crossStream ? '' : BUSINESS_STREAMS[0];
}

/** Puts the person asking on a desk: 'Compressor Sales', 'Spare Sales', or 'All' for both combined. */
function setMyDesk(desk) {
  var user = getCurrentUser();
  if (String(user.homeStream || user.businessStream) !== STREAM_ALL) {
    throw new Error('You work in ' + String(user.businessStream) + ' alone, so there is no desk to choose.');
  }
  var want = String(desk || '').trim();
  if (want !== STREAM_ALL && BUSINESS_STREAMS.indexOf(want) === -1) {
    throw new Error('A desk is ' + BUSINESS_STREAMS.join(' or ') + ', or All for both combined.');
  }
  var row = userRowByEmail_(user.email);
  if (!row) throw new Error('Your user record could not be found.');
  updateRowById_('Users', 'id', row.id, { desk: want }, 'Changed desk');
  // Every request reads who is asking from the session's cached copy; the desk is part of it.
  refreshSessionsFor_(user.email);
  row.desk = want;
  var now = userFromRow_(row);
  CURRENT_USER_ = now;
  return now;
}
