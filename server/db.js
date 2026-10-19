/**
 * What SheetService.gs becomes.
 *
 * `SheetService.gs` is the only file in the Apps Script portal that touches storage — a rule
 * held since the first commit precisely so this day would be a swap rather than a rewrite.
 * Counting the calls bears it out: 43 modules and 17,500 lines reach storage through just
 * twelve functions, and this file is those twelve against Postgres.
 *
 * Six more functions do not appear here, and that is the point. `getSheet_`, `getHeaders_`,
 * `sheetRows_`, `sheetCols_`, `noteRowCount_`, `invalidateTable_` exist only because the
 * storage was a spreadsheet: a database has no header row to cache, no height to measure and
 * no request-scoped block to keep in step. Fifty-six call sites are deleted rather than
 * ported, including the dimension cache added two days ago to make saves bearable.
 *
 * FAITHFUL FIRST. Every function here returns exactly what its Apps Script namesake
 * returned, including the oddities — blanks as '' rather than null, dates as 'yyyy-MM-dd'
 * strings, one audit row per changed field, a throw when an update finds no row. The
 * portal's existing behaviour is the specification, and the existing test suite is how we
 * check it. Making the queries clever comes after everything already works, not during.
 *
 * ASYNC. This is the one thing the callers cannot ignore. Apps Script's storage calls block;
 * Postgres cannot. `var rows = readTable_('Spares')` becomes
 * `const rows = await db.readTable('Spares')`, and every function containing one becomes
 * async, and so does every function calling those. Roughly 630 call sites. Mechanical, not
 * difficult, but it is the bulk of the work and there is no way round it — the synchronous
 * Postgres clients that exist are not maintained well enough to put a business on.
 */
'use strict';

const { Pool, types } = require('pg');
const { loadSchema, typeFor, snake } = require('../migration/schema.js');

const SCHEMA = loadSchema();

// NUMERIC arrives from pg as a string, so that 1e20 does not quietly become 1.0000000000001e20.
// The sheet handed back numbers and every caller treats these as numbers, so they are parsed
// here. Safe for this data: the widest column is NUMERIC(14,2), far inside what a double
// holds exactly. If a column ever needs more precision than that, this is the line to revisit
// rather than the place to discover the problem.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// DATE likewise: pg builds a JS Date at the server's midnight, which can shift the day across
// time zones. The sheet stored 'yyyy-MM-dd' and the whole portal compares these as strings.
types.setTypeParser(types.builtins.DATE, (v) => v);

/**
 * How a tab's columns map between the two worlds, worked out once per tab.
 *
 * The portal speaks camelCase because that is what the sheet's header row says; Postgres
 * speaks snake_case because an identifier that needs quoting is one everybody eventually
 * gets wrong. Both names come from the same declaration in Schema.gs, so they cannot drift.
 */
const MAPS = {};
function mapFor(tab) {
  if (MAPS[tab]) return MAPS[tab];
  const spec = SCHEMA[tab];
  if (!spec) throw new Error('Unknown tab "' + tab + '" — it is not declared in Schema.gs.');
  const toDb = {};
  const toJs = {};
  const kind = {};
  spec.columns.forEach((c) => {
    const col = snake(c);
    toDb[c] = col;
    toJs[col] = c;
    kind[c] = typeFor(c).type;
  });
  MAPS[tab] = { table: snake(tab), columns: spec.columns, toDb, toJs, kind };
  return MAPS[tab];
}

/**
 * A database row, as the portal expects to receive it.
 *
 * The important conversion is null to ''. A spreadsheet has no null — an empty cell reads as
 * an empty string — and the portal is full of `String(x).trim()` and `x === ''` written
 * against that. Handing back null instead would turn a blank field into the text "null" on a
 * printed quotation, and nothing would throw to say so.
 */
function toRecord(tab, row) {
  const m = mapFor(tab);
  const out = {};
  m.columns.forEach((c) => {
    const v = row[m.toDb[c]];
    if (v === null || v === undefined) { out[c] = ''; return; }
    if (v instanceof Date) {
      // TIMESTAMPTZ. The sheet held these as ISO strings and the portal slices them.
      out[c] = v.toISOString();
      return;
    }
    out[c] = v;
  });
  return out;
}

/** The other direction: a portal object to the values a statement wants. */
function toColumns(tab, obj) {
  const m = mapFor(tab);
  const cols = [];
  const values = [];
  Object.keys(obj).forEach((k) => {
    if (!m.toDb.hasOwnProperty(k)) {
      // assertWritableFields_ threw for a declared column the sheet lacked and warned for a
      // field nobody declared. There is no "sheet behind the code" here — the schema is
      // generated — so an unknown key is a code mistake, and warning keeps one stray key
      // from taking a working screen down.
      console.warn('Ignored field not declared for ' + tab + ': ' + k);
      return;
    }
    cols.push(m.toDb[k]);
    values.push(coerce(m.kind[k], obj[k]));
  });
  return { cols, values };
}

/**
 * '' means "nothing here" on a sheet and breaks a typed column.
 *
 * Every write in the portal passes '' for an absent value, because that is what a blank cell
 * was. A date column given '' raises `invalid input syntax for type date`, which is a correct
 * complaint about an input that was always meant to be absent.
 */
function coerce(type, v) {
  if (v === undefined || v === null || v === '') return null;
  if (type === 'BOOLEAN') {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toUpperCase();
    if (s === 'TRUE' || s === 'YES' || s === '1') return true;
    if (s === 'FALSE' || s === 'NO' || s === '0') return false;
    return null;
  }
  if (type.startsWith('NUMERIC') || type === 'INTEGER' || type === 'BIGINT') {
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  if (type === 'DATE') return String(v).slice(0, 10);
  return v;
}

// ------------------------------------------------------------------ the twelve

/**
 * The tables Db.enableTableCache keeps in memory: small, read on most screens, rarely written.
 * Sessions are not here — the portal's own session cache sits in front of them.
 */
const CACHED_TABLES = new Set(['users', 'brands', 'business_streams', 'config_lists',
  'lost_reasons', 'warehouses', 'company_profile', 'quote_templates']);

/**
 * Every table a statement writes to. Generous on purpose: a false match only means a table is
 * read again, while a missed one would mean a stale answer.
 */
function writtenTables(text) {
  const out = [];
  const re = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+"?([a-z_][a-z0-9_]*)"?/gi;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1].toLowerCase());
  return out;
}

class Db {
  /**
   * @param pool    a pg Pool
   * @param tenant  which client's data this connection may see. Every statement carries it;
   *                there is no way to ask a question without it, which is the point — a
   *                missing WHERE on a shared table is how one client reads another's prices.
   */
  constructor(pool, tenant) {
    if (!tenant) throw new Error('A tenant is required. Refusing to query across all clients.');
    this.pool = pool;
    this.tenant = tenant;
    this.client = null;      // set inside withTransaction
    this.actor = 'system';   // who the audit trail records; set per request
  }

  /** Runs on the transaction's client when inside one, the pool otherwise. */
  q(text, params) {
    const run = (this.client || this.pool).query(text, params);
    if (!this.tableCache) return run;
    // A write to a remembered table forgets it — before the statement, so nobody reads the
    // old copy while it runs, and again after, so a read that overlapped it cannot put the
    // old rows back. Inside a transaction the table is forgotten once more when it ends.
    const touched = writtenTables(text).filter((t) => CACHED_TABLES.has(t));
    if (!touched.length) return run;
    touched.forEach((t) => this.forgetTable(t));
    if (this.txWritten) touched.forEach((t) => this.txWritten.add(t));
    const after = () => touched.forEach((t) => this.forgetTable(t));
    return run.then((res) => { after(); return res; }, (err) => { after(); throw err; });
  }

  /**
   * Keeps the small, rarely changed tables in memory between requests.
   *
   * Users, the dropdown lists, brands, warehouses, the letterhead, the quotation templates:
   * read on nearly every screen, changed a few times a month. Each read was a round trip to
   * Neon — about 30 ms from Railway — and Settings alone made ten of them in a row.
   *
   * Correct by construction rather than by expiry. Every write in the portal goes through q(),
   * and q() forgets a table the moment a statement writes to it. A read inside a transaction
   * never uses or fills the memory, so nothing uncommitted is ever remembered. A generation
   * number stops a read that overlapped a write from storing what it saw. The five minutes
   * are only for changes made from outside this process — a script, or SQL typed at Neon.
   *
   * Switched on by the web server. Off by default, because a test or a script that writes
   * through a second connection would otherwise read its own stale copy.
   */
  enableTableCache(ms) {
    this.tableCache = new Map();
    this.tableGen = new Map();
    this.tableCacheMs = ms || 5 * 60 * 1000;
  }

  forgetTable(table) {
    if (!this.tableCache) return;
    this.tableCache.delete(table);
    this.tableGen.set(table, (this.tableGen.get(table) || 0) + 1);
  }

  /** The same object, bound to one connection and one transaction. */
  async withTransaction(fn) {
    if (this.client) return fn(this);              // already inside one; join it
    const client = await this.pool.connect();
    const scoped = Object.create(this);
    scoped.client = client;
    scoped.txWritten = new Set();
    try {
      await client.query('BEGIN');
      const out = await fn(scoped);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { /* the error below is the real one */ }
      throw err;
    } finally {
      // Committed or rolled back, what it wrote is forgotten again: a read elsewhere during
      // the transaction saw the old rows, and may have stored them.
      scoped.txWritten.forEach((t) => this.forgetTable(t));
      client.release();
    }
  }

  /**
   * Every row of a tab.
   *
   * Faithful to readTable_, which means it really does read everything. That is the wrong
   * shape for a database and deliberately kept for now: it makes all 354 call sites work
   * unchanged on day one, and it is already far quicker than the sheet was because there is
   * no round trip and no cold start. The call sites that matter get replaced with real
   * queries afterwards, one at a time, each measurable.
   */
  async readTable(tab) {
    const m = mapFor(tab);
    const remember = this.tableCache && !this.client && CACHED_TABLES.has(m.table);
    if (remember) {
      const hit = this.tableCache.get(m.table);
      // Copies, because callers decorate the rows they are given and the next caller must
      // not see the decorations.
      if (hit && hit.until > Date.now()) return hit.rows.map((r) => Object.assign({}, r));
    }
    const gen = remember ? (this.tableGen.get(m.table) || 0) : 0;
    const { rows } = await this.q(
      'SELECT * FROM ' + m.table + ' WHERE tenant_id = $1', [this.tenant]);
    const records = rows.map((r) => toRecord(tab, r));
    if (remember && (this.tableGen.get(m.table) || 0) === gen) {
      this.tableCache.set(m.table, { rows: records, until: Date.now() + this.tableCacheMs });
      return records.map((r) => Object.assign({}, r));
    }
    return records;
  }

  /** One row by id, or null. */
  async findRowById(tab, idValue) {
    const m = mapFor(tab);
    const { rows } = await this.q(
      'SELECT * FROM ' + m.table + ' WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [this.tenant, String(idValue)]);
    return rows.length ? toRecord(tab, rows[0]) : null;
  }

  /** Rows whose column is any of `values`. */
  async findRowsByColumn(tab, column, values) {
    const m = mapFor(tab);
    if (!m.toDb[column]) throw new Error('Column "' + column + '" not found in ' + tab);
    const list = (Array.isArray(values) ? values : [values]).map(String);
    if (!list.length) return [];
    const { rows } = await this.q(
      'SELECT * FROM ' + m.table + ' WHERE tenant_id = $1 AND ' + m.toDb[column] +
      '::text = ANY($2)', [this.tenant, list]);
    return rows.map((r) => toRecord(tab, r));
  }

  /** Rows by a set of ids, in one statement. */
  findRowsByIds(tab, ids) { return this.findRowsByColumn(tab, 'id', ids); }

  /** { key: value } from two columns, without building the rest. */
  async columnMap(tab, keyColumn, valueColumn) {
    const m = mapFor(tab);
    if (!m.toDb[keyColumn] || !m.toDb[valueColumn]) return {};
    const { rows } = await this.q(
      'SELECT ' + m.toDb[keyColumn] + ' AS k, ' + m.toDb[valueColumn] + ' AS v FROM ' +
      m.table + ' WHERE tenant_id = $1', [this.tenant]);
    const out = {};
    rows.forEach((r) => {
      const k = r.k === null || r.k === undefined ? '' : String(r.k);
      if (k) out[k] = r.v === null || r.v === undefined ? '' : r.v;
    });
    return out;
  }

  /** Adds a row. Returns its id, where the sheet returned a row number nobody read. */
  async appendRow(tab, obj, auditReason) {
    const { cols, values } = toColumns(tab, obj);
    const m = mapFor(tab);
    const placeholders = values.map((_, i) => '$' + (i + 2));
    await this.q(
      'INSERT INTO ' + m.table + ' (tenant_id, ' + cols.join(', ') + ') VALUES ($1, ' +
      placeholders.join(', ') + ')', [this.tenant].concat(values));
    await this.audit('Create', tab, obj.id || '', '', '', '', auditReason);
    return obj.id || '';
  }

  /** Several rows and one audit line, as appendRows_ did. */
  async appendRows(tab, objs, auditReason) {
    if (!objs || !objs.length) return 0;
    const m = mapFor(tab);
    // Every row writes the same columns, so the statement is built once from the first.
    const cols = Object.keys(objs[0]).filter((k) => m.toDb.hasOwnProperty(k));
    const dbCols = cols.map((c) => m.toDb[c]);
    const params = [this.tenant];
    const tuples = objs.map((obj) => {
      const slots = cols.map((c) => {
        params.push(coerce(m.kind[c], obj[c]));
        return '$' + params.length;
      });
      return '($1, ' + slots.join(', ') + ')';
    });
    await this.q(
      'INSERT INTO ' + m.table + ' (tenant_id, ' + dbCols.join(', ') + ') VALUES ' +
      tuples.join(', '), params);
    await this.audit('Create', tab, '(bulk)', '', '',
      String(objs.length) + ' rows', auditReason);
    return objs.length;
  }

  /**
   * Merges a patch onto one row.
   *
   * Two behaviours carried over deliberately. It writes **one audit entry per changed
   * field**, not one per save — the audit trail's whole value is answering "who changed the
   * price and what was it before", and a single row saying "updated" cannot. And it
   * **throws** when no row matches, rather than succeeding quietly, which is how a save
   * against a deleted record gets noticed.
   */
  async updateRowById(tab, idField, idValue, patch, auditReason) {
    const m = mapFor(tab);
    if (!m.toDb[idField]) throw new Error('Column "' + idField + '" not found in ' + tab);

    return this.withTransaction(async (db) => {
      const { rows } = await db.q(
        'SELECT * FROM ' + m.table + ' WHERE tenant_id = $1 AND ' + m.toDb[idField] +
        '::text = $2 FOR UPDATE', [db.tenant, String(idValue)]);
      if (!rows.length) {
        throw new Error('Row with ' + idField + '=' + idValue + ' not found in ' + tab);
      }
      const current = toRecord(tab, rows[0]);

      const changes = [];
      const sets = [];
      const values = [db.tenant, String(idValue)];
      Object.keys(patch).forEach((k) => {
        if (!m.toDb.hasOwnProperty(k)) {
          console.warn('Ignored field not declared for ' + tab + ': ' + k);
          return;
        }
        // Compared as strings, exactly as the sheet did — the values arriving from a form are
        // text, and 5 against '5' is not a change anybody wants in the audit log.
        if (String(patch[k]) === String(current[k])) return;
        changes.push({ field: k, oldValue: current[k], newValue: patch[k] });
        values.push(coerce(m.kind[k], patch[k]));
        sets.push(m.toDb[k] + ' = $' + values.length);
      });

      if (sets.length) {
        await db.q('UPDATE ' + m.table + ' SET ' + sets.join(', ') +
          ' WHERE tenant_id = $1 AND ' + m.toDb[idField] + '::text = $2', values);
      }
      for (const c of changes) {
        await db.audit('Update', tab, idValue, c.field, c.oldValue, c.newValue, auditReason);
      }
      return true;
    });
  }

  /** Removes one row. The audit entry keeps what it held, as the sheet's did. */
  async deleteRowById(tab, idField, idValue, auditReason) {
    const m = mapFor(tab);
    if (!m.toDb[idField]) throw new Error('Column "' + idField + '" not found in ' + tab);
    return this.withTransaction(async (db) => {
      const { rows } = await db.q(
        'DELETE FROM ' + m.table + ' WHERE tenant_id = $1 AND ' + m.toDb[idField] +
        '::text = $2 RETURNING *', [db.tenant, String(idValue)]);
      if (!rows.length) {
        throw new Error('Row with ' + idField + '=' + idValue + ' not found in ' + tab);
      }
      const gone = m.columns.map((c) => toRecord(tab, rows[0])[c]).join(' | ');
      await db.audit('Delete', tab, idValue, '', gone, '', auditReason);
      return true;
    });
  }

  /**
   * Removes every row the predicate accepts.
   *
   * The one function SQL cannot improve on, because the caller hands over a JavaScript
   * function and there is no way to push that into the database. So it reads, decides in
   * memory, and deletes by id — which is what the sheet did, and is fine: this runs on
   * clear-outs and imports, not on anything a person waits for.
   */
  async deleteRowsWhere(tab, matches, auditReason) {
    return this.withTransaction(async (db) => {
      const all = await db.readTable(tab);
      const doomed = all.filter((r) => matches(r));
      if (!doomed.length) return 0;
      const m = mapFor(tab);
      await db.q('DELETE FROM ' + m.table + ' WHERE tenant_id = $1 AND id = ANY($2)',
        [db.tenant, doomed.map((r) => String(r.id))]);
      // One entry for the batch. Thousands would bury everything else in the log.
      await db.audit('Delete', tab, '(bulk)', '', String(doomed.length) + ' rows', '',
        auditReason);
      return doomed.length;
    });
  }

  /**
   * One audit row.
   *
   * Never throws, for the same reason the Apps Script one never did: the record must not be
   * able to roll back the business action it is recording. A lost audit line is bad. A
   * dispatch that failed because its audit line failed is worse.
   */
  async audit(action, tableName, recordId, fieldName, oldValue, newValue, reason) {
    try {
      await this.q(
        'INSERT INTO audit_log (tenant_id, id, "timestamp", user_email, action, table_name,' +
        ' record_id, field_name, old_value, new_value, reason)' +
        ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [this.tenant, generateId('AUD-'), new Date().toISOString(), this.actor,
          action, tableName, String(recordId || ''), fieldName || '',
          truncate(oldValue), truncate(newValue), reason || '']);
    } catch (err) {
      console.warn('Audit write failed: ' + err.message);
    }
  }
}

/** Audit values are a record of what changed, not a copy of the thing. */
function truncate(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return s.length > 500 ? s.slice(0, 497) + '…' : s;
}

/** The same shape of id the sheet minted, so existing rows and new ones look alike. */
function generateId(prefix) {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return (prefix || '') + hex() + hex();
}

/** Opens a pool and hands back a Db bound to one client's data. */
/**
 * How to talk to this database over TLS, decided in one place.
 *
 * A unix socket or localhost is the dev database on this machine and needs no TLS. Anything
 * else is across the internet and gets it — and the certificate is CHECKED.
 *
 * It was `rejectUnauthorized: false`, which encrypts the connection without authenticating
 * the other end: anybody positioned to intercept can present their own certificate, and what
 * they capture first is the password in the connection string, followed by PIE's prices and
 * every customer they have. Neon's certificates are issued by a public CA that Node already
 * trusts, so verifying costs nothing and the setting bought nothing.
 *
 * PGSSL_NO_VERIFY=1 turns the check off for a self-signed server. It is deliberately an
 * environment variable and deliberately not the default, so that running without
 * verification is a thing somebody did rather than a thing that happened.
 */
function sslFor(url) {
  if (/localhost|127\.0\.0\.1|\/var\/tmp|\/tmp|host=\//.test(url || '')) return false;
  if (process.env.PGSSL_NO_VERIFY === '1') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

/**
 * The connection string with `sslmode` taken out, because we decide that above.
 *
 * Neon hands out `...?sslmode=require`, and pg prints ten lines of deprecation warning about
 * it on every single run: today it treats `require` as `verify-full`, and in pg v9 it will
 * adopt libpq's weaker meaning instead. Neither matters here — sslFor() sets `ssl` explicitly
 * and that is what pg uses — but ten lines of SECURITY WARNING at the top of every import is
 * ten lines somebody has to look past to find the output they are checking, which is how a
 * real message gets missed.
 *
 * Removing the parameter rather than silencing the warning: the TLS decision is then
 * unambiguously ours, in one function, instead of half in a connection string somebody
 * pasted.
 */
function withoutSslMode(url) {
  if (!url) return url;
  return String(url)
    .replace(/([?&])sslmode=[^&]*&/i, '$1')
    .replace(/[?&]sslmode=[^&]*$/i, '');
}

function connect(options) {
  const opts = options || {};
  const url = opts.connectionString || process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: withoutSslMode(url),
    ssl: sslFor(url),
    max: opts.max || 10
  });
  return new Db(pool, opts.tenant || process.env.TENANT_ID);
}

module.exports = { connect, Db, generateId, mapFor, toRecord, coerce, sslFor,
  withoutSslMode, SCHEMA };
