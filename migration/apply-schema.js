/**
 * Creates the 52 tables in Postgres, from the same generator the rest of the migration uses.
 *
 * Exists because the alternative on Windows is pasting 1,214 lines of DDL into a browser SQL
 * editor and hoping it all arrived. This runs it over the same `pg` connection the importer
 * uses, in one transaction, so either every table exists afterwards or none does.
 *
 * It refuses a database that already has these tables rather than failing halfway through
 * CREATE TABLE statements. Re-running it after a failed attempt should be a decision, not an
 * accident: --force drops and recreates, which destroys whatever is in them.
 *
 *   DATABASE_URL=postgres://... node migration/apply-schema.js
 *   DATABASE_URL=postgres://... node migration/apply-schema.js --force
 *   node migration/apply-schema.js --print        just show the SQL, touch nothing
 */
'use strict';

const { Client } = require('../server/node_modules/pg');
const { build } = require('./schema.js');

async function main() {
  const args = process.argv.slice(2);
  const ddl = build().ddl;

  if (args.indexOf('--print') !== -1) {
    console.log(ddl);
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('Set DATABASE_URL to the Neon connection string first.\n');
    console.log('  PowerShell:  $env:DATABASE_URL = "postgres://..."');
    console.log('  cmd:         set DATABASE_URL=postgres://...\n');
    console.log('Do not paste that string anywhere public — it is the database password.');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables" +
      " WHERE table_schema = 'public'");
    const force = args.indexOf('--force') !== -1;

    if (rows[0].n && !force) {
      console.log('This database already has ' + rows[0].n + ' table(s) in the public schema.');
      console.log('Refusing to create on top of them — that fails halfway through and leaves');
      console.log('a half-built schema nobody can reason about.\n');
      console.log('  --force  drops every one of them and starts again. It DESTROYS whatever');
      console.log('           they hold, so it is for a rehearsal you are redoing, not for a');
      console.log('           database with PIE’s data in it.');
      process.exit(1);
    }

    await client.query('BEGIN');
    if (force && rows[0].n) {
      // Named tables rather than DROP SCHEMA, so anything somebody else put in this database
      // is left alone.
      const theirs = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      for (const t of theirs.rows) {
        await client.query('DROP TABLE IF EXISTS "' + t.tablename + '" CASCADE');
      }
      console.log('Dropped ' + theirs.rows.length + ' existing table(s).');
    }
    await client.query(ddl);
    await client.query('COMMIT');

    const after = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables" +
      " WHERE table_schema = 'public'");
    console.log(after.rows[0].n + ' tables created.');
    console.log('\nNext: node migration/import.js <the export folder>');
    console.log('which checks everything and writes nothing until you add --write.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* the error below is the real one */ }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.log('FAILED: ' + e.message);
  process.exit(1);
});
