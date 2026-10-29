/**
 * The schema top-up: what a release declares exists before anything writes it, and nothing
 * that is already there is touched.
 *
 * Run in a scratch Postgres schema rather than against the tables the other tests use, so it
 * can drop columns and tables to see them come back without disturbing anything.
 *
 *   DATABASE_URL=postgres://... node tests/schema-sync-test.js
 */
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}

const { Client } = require(path.join(__dirname, '..', 'server', 'node_modules', 'pg'));
const { syncSchema } = require(path.join(__dirname, '..', 'server', 'schema-sync.js'));
const { loadSchema } = require(path.join(__dirname, '..', 'migration', 'schema.js'));
const { withoutSslMode, sslFor } = require(path.join(__dirname, '..', 'server', 'db.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const SCRATCH = 'schema_sync_probe';
const TABLES = Object.keys(loadSchema()).length;

(async () => {
  const client = new Client({ connectionString: withoutSslMode(URL), ssl: sslFor(URL) });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS ' + SCRATCH + ' CASCADE');
  await client.query('CREATE SCHEMA ' + SCRATCH);
  // public stays on the path so pgcrypto's functions still resolve; new tables go first in it.
  await client.query('SET search_path TO ' + SCRATCH + ', public');
  const db = { q: (sql, params) => client.query(sql, params) };
  const said = [];
  const quiet = (m) => said.push(m);

  const count = async (what) => (await client.query(what === 'tables'
    ? "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1"
    : "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1", [SCRATCH])).rows[0].n;

  console.log('AN EMPTY DATABASE GETS EVERYTHING');
  const first = await syncSchema(db, quiet);
  ok('every declared table is created', first.tables.length === TABLES, first.tables.length);
  ok('and they are in the database', (await count('tables')) === TABLES, await count('tables'));
  const indexes = await count('indexes');
  ok('with their indexes', indexes === 245, indexes);

  console.log('\nA SECOND START CHANGES NOTHING');
  said.length = 0;
  const second = await syncSchema(db, quiet);
  ok('nothing to add', !second.tables.length && !second.columns.length, second);
  ok('and nothing said about it', said.length === 0, said);
  ok('no index doubled', (await count('indexes')) === indexes, await count('indexes'));

  console.log('\nA COLUMN A RELEASE ADDED IS ADDED');
  await client.query("INSERT INTO quotations (tenant_id, id, quote_no, notes) VALUES ('t', 'QT-1', 'Q/1', 'keep me')");
  await client.query('ALTER TABLE quotations DROP COLUMN valid_until');
  await client.query('ALTER TABLE quotations DROP COLUMN created_by');
  const third = await syncSchema(db, quiet);
  ok('both missing columns are named', third.columns.sort().join() ===
    'quotations.created_by,quotations.valid_until', third.columns);
  const types = (await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1" +
    " AND table_name = 'quotations' AND column_name IN ('valid_until', 'created_by')",
    [SCRATCH])).rows.reduce((m, r) => { m[r.column_name] = r.data_type; return m; }, {});
  ok('with the type the schema gives them', types.valid_until === 'date' &&
    types.created_by === 'text', types);
  const row = (await client.query("SELECT notes FROM quotations WHERE id = 'QT-1'")).rows[0];
  ok('and the row already there is untouched', row && row.notes === 'keep me', row);
  ok('the change is said, so a deploy log shows it',
    said.some((m) => /added 2 column/.test(m)), said);

  console.log('\nA TABLE A RELEASE ADDED IS CREATED, WITH ITS INDEXES');
  await client.query('DROP TABLE stock_reservations');
  const fourth = await syncSchema(db, quiet);
  ok('the missing table is named', fourth.tables.join() === 'stock_reservations', fourth.tables);
  ok('and every index is back', (await count('indexes')) === indexes, await count('indexes'));

  console.log('\nA NUMBER COLUMN THE SCHEMA NOW CALLS TEXT IS WIDENED, LOSING NOTHING');
  // How Neon looks today: motor_kw and weight_kg were created NUMERIC, which silently turned
  // "22 kW, 30 hp" into null. Put them back that way, with numbers in them, and let it mend.
  await client.query('ALTER TABLE products ALTER COLUMN motor_kw TYPE NUMERIC(14,3) USING NULL');
  await client.query('ALTER TABLE products ALTER COLUMN weight_kg TYPE NUMERIC(14,3) USING NULL');
  await client.query("INSERT INTO products (tenant_id, id, product_code, motor_kw, weight_kg) " +
    "VALUES ('t', 'PR-1', 'EQ22-7.5', 22, 700.5), ('t', 'PR-2', 'EQ11-7.5', NULL, 100)");
  said.length = 0;
  const widen = await syncSchema(db, quiet);
  ok('both columns are named as widened', widen.widened.sort().join() ===
    'products.motor_kw,products.weight_kg', widen.widened);
  const kinds = (await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1" +
    " AND table_name = 'products' AND column_name IN ('motor_kw', 'weight_kg')", [SCRATCH])).rows;
  ok('and are text now', kinds.every((k) => k.data_type === 'text'), kinds);
  const vals = (await client.query("SELECT id, motor_kw, weight_kg FROM products ORDER BY id")).rows;
  ok('a whole number keeps no trailing zeros', vals[0].motor_kw === '22', vals[0]);
  ok('a fraction keeps its digits', vals[0].weight_kg === '700.5', vals[0]);
  ok('a blank stays blank and 100 stays 100, not 1', vals[1].motor_kw === null &&
    vals[1].weight_kg === '100', vals[1]);
  await client.query("UPDATE products SET motor_kw = '22 kW, 30 hp' WHERE id = 'PR-1'");
  ok('and the words an offer prints now fit', (await client.query(
    "SELECT motor_kw FROM products WHERE id = 'PR-1'")).rows[0].motor_kw === '22 kW, 30 hp');
  ok('the log says so', said.some((m) => /widened to text 2 column/.test(m)), said);
  const money = (await client.query("SELECT data_type FROM information_schema.columns " +
    "WHERE table_schema = $1 AND table_name = 'quotations' AND column_name = 'grand'", [SCRATCH])).rows[0];
  ok('a real number column is not touched', money.data_type === 'numeric', money);
  const again2 = await syncSchema(db, quiet);
  ok('and a second start widens nothing', !again2.widened.length, again2);

  console.log('\nWHAT THE SCHEMA NO LONGER DECLARES IS LEFT ALONE');
  // Removing a column from Schema.gs must never cost the data in it. Rolling back the code
  // takes a minute; there is no rolling back a dropped column.
  await client.query('ALTER TABLE quotations ADD COLUMN retired_field TEXT');
  await client.query("UPDATE quotations SET retired_field = 'still here' WHERE id = 'QT-1'");
  await syncSchema(db, quiet);
  const kept = (await client.query("SELECT retired_field FROM quotations WHERE id = 'QT-1'")).rows[0];
  ok('an undeclared column keeps its data', kept && kept.retired_field === 'still here', kept);

  await client.query('DROP SCHEMA ' + SCRATCH + ' CASCADE');
  await client.end();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
