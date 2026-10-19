/**
 * Brings the database up to what Schema.gs declares, before the portal answers anything.
 *
 * On the Sheet this was Setup's job: a release that added a column added it to the tab, and
 * appendRow_ refused to write a column the tab did not have. Postgres needs the same thing and
 * did not have it. A column declared in Schema.gs but missing from the table is worse here than
 * on the Sheet, because every record the portal builds carries every declared column — a
 * quotation copied for its next revision included — so one new column turned into an INSERT
 * naming a column that does not exist, and every revision failing until somebody altered Neon
 * by hand.
 *
 * ADDITIVE ONLY. Missing tables are created, missing columns added, missing indexes built.
 * Nothing is ever dropped or renamed: a column removed from Schema.gs stays in the database
 * with its data. That is the same rule Setup followed on the Sheet, for the same reason — the
 * code can be rolled back in a minute and the data cannot.
 *
 * ONE KIND OF RETYPE, because it cannot lose anything: a number column the schema now says is
 * TEXT is widened to TEXT. Every number has a text form ("22.000" is written "22"); no text has
 * to become a number. motorKw and weightKg were declared NUMERIC by mistake and silently threw
 * away "22 kW, 30 hp" — this is how the databases that already have them get mended. Any other
 * change of type is left alone for a person to decide on.
 *
 * CHEAP WHEN THERE IS NOTHING TO DO, which is every start but the first after a release: one
 * read of the catalogue, compared in memory, and nothing else is sent.
 */
'use strict';

const { loadSchema, typeFor, snake, build } = require('../migration/schema.js');

/**
 * @param db  anything with q(sql, params) answering { rows } — a Db from db.js
 * @param log where to say what was changed; console.log unless a caller wants it quiet
 * @returns   { tables: [...], columns: ['table.column', ...] } — what was added
 */
async function syncSchema(db, log) {
  const say = log || ((m) => console.log(m));
  const SCHEMA = loadSchema();

  const { rows } = await db.q(
    'SELECT table_name, column_name, data_type FROM information_schema.columns' +
    ' WHERE table_schema = current_schema()');
  const have = {};
  for (const r of rows) (have[r.table_name] = have[r.table_name] || {})[r.column_name] = r.data_type;

  const tables = [];
  const columns = [];
  const widened = [];
  const NUMBERS = ['numeric', 'integer', 'bigint', 'smallint', 'double precision', 'real'];
  for (const tab of Object.keys(SCHEMA)) {
    const table = snake(tab);
    if (!have[table]) { tables.push(table); continue; }
    for (const c of SCHEMA[tab].columns) {
      const col = snake(c);
      const type = typeFor(c).type;
      if (!have[table][col]) columns.push({ table, col, type });
      else if (type === 'TEXT' && NUMBERS.indexOf(have[table][col]) !== -1) {
        widened.push({ table, col, from: have[table][col] });
      }
    }
  }
  if (!tables.length && !columns.length && !widened.length) {
    return { tables: [], columns: [], widened: [] };
  }

  // trim_scale so a NUMERIC(14,3) 22 becomes "22" and not "22.000" on a printed offer.
  for (const w of widened) {
    const as = w.from === 'numeric' ? 'trim_scale(' + w.col + ')::text' : w.col + '::text';
    await db.q('ALTER TABLE ' + w.table + ' ALTER COLUMN ' + w.col + ' TYPE TEXT USING ' + as);
  }

  // Columns first, so the indexes the full DDL builds below can name them.
  for (const m of columns) {
    await db.q('ALTER TABLE ' + m.table + ' ADD COLUMN IF NOT EXISTS ' + m.col + ' ' + m.type);
  }
  // The generated DDL is safe to apply over a live schema: every table and index in it is IF
  // NOT EXISTS, so this creates whatever is missing and skips everything already there.
  await db.q(build().ddl);

  const added = { tables, columns: columns.map((m) => m.table + '.' + m.col),
    widened: widened.map((w) => w.table + '.' + w.col) };
  if (tables.length) say('[schema] created ' + tables.length + ' table(s): ' + tables.join(', '));
  if (columns.length) say('[schema] added ' + columns.length + ' column(s): ' + added.columns.join(', '));
  if (widened.length) say('[schema] widened to text ' + widened.length + ' column(s): ' + added.widened.join(', '));
  return added;
}

module.exports = { syncSchema };
