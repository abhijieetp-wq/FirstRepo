/**
 * The weekly service due upload's refresh of the calls still open, as one statement.
 *
 * Next week's report lists most of this week's machines again, so an upload refreshes what is
 * due on several hundred open calls. One UPDATE per call is several hundred round trips to the
 * database — tens of seconds on Neon, with the coordinator watching a spinner. Every row
 * carries the same fields (serviceDueMachine_ builds them), so this is one UPDATE ... FROM
 * unnest(...) for the lot, cast by each column's own type the way the catalogue import does.
 *
 * The specification is updateServiceDueRows_ in src/ServiceDue.gs: a patch of those fields
 * onto each row by id.
 */
'use strict';

async function updateServiceDueRows_(rows) {
  if (!rows || !rows.length) return;
  var m = mapFor_('ServiceDueCalls');
  var fields = Object.keys(rows[0]).filter(function (k) { return k !== 'id' && m.toDb[k]; });

  var params = [db.tenant, rows.map(function (r) { return String(r.id); })];
  var cols = ['id'];
  fields.forEach(function (f) {
    params.push(rows.map(function (r) {
      var v = r[f];
      return v === undefined || v === null ? '' : String(v);
    }));
    cols.push(m.toDb[f]);
  });

  var selectList = cols.map(function (c, i) { return '$' + (i + 2) + '::text[]'; }).join(', ');
  var asList = cols.map(function (c) { return 'v_' + c; }).join(', ');
  var sets = fields.map(function (f) {
    var c = m.toDb[f];
    var t = m.kind[f] || 'TEXT';
    // A blank is NULL in a DATE or a number, not a cast failure.
    return c + ' = ' + (t === 'TEXT' ? 'w.v_' + c : 'nullif(w.v_' + c + ", '')::" + t);
  });

  await db.q(
    'UPDATE ' + m.table + ' t SET ' + sets.join(', ') +
    '  FROM (SELECT * FROM unnest(' + selectList + ') AS u(' + asList + ')) w' +
    ' WHERE t.tenant_id = $1 AND t.id = w.v_id',
    params);
}
