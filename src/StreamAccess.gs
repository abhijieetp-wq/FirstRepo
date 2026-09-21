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
