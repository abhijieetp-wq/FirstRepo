/**
 * The Postgres schema, generated from the Sheet's own declaration.
 *
 * `src/Schema.gs` has been the single source of truth for every tab and column since the
 * project started — Setup.gs reads it to build the spreadsheet, so the sheet can never drift
 * from what the code expects. The database inherits that property by being generated from
 * the same declaration rather than typed out beside it. A column added to SCHEMA.gs and not
 * to the database is then a build-time difference, not a runtime surprise six weeks later.
 *
 * What the declaration does not carry is types: the sheet has cells, and every cell is a
 * string until something reads it. So types are inferred from the naming conventions the
 * project has followed throughout and documented at the top of Schema.gs — ids are ids,
 * `*At` is a timestamp, `*Pct` and `price` are numeric, `active` is a flag. Every inference
 * is printed with its reason so it can be argued with, and anything unrecognised falls back
 * to TEXT, which is lossless and tightened later rather than guessed at now.
 *
 *   node migration/schema.js            print the DDL
 *   node migration/schema.js --report   print what was inferred and why
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/** Loads just the SCHEMA declaration out of the Apps Script source. */
function loadSchema() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Schema.gs'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'Schema.gs' });
  if (!sandbox.SCHEMA) throw new Error('SCHEMA not found in Schema.gs');
  return sandbox.SCHEMA;
}

/**
 * Columns the conventions get wrong, and the reason each one is an exception.
 *
 * This list is the honest part of the exercise. Two of these were caught by running the
 * report and reading it rather than by writing the rules carefully: `priceLevel` holds PIE
 * or ELGI and matched a rule meant for `reorderLevel`, and the audit log's `oldValue` and
 * `newValue` hold whatever changed — a status, a name, an address — and matched a rule meant
 * for money. Both would have imported as numbers and silently dropped every row they
 * described. Conventions are a good default and a bad authority.
 */
const OVERRIDES = {
  priceLevel: ['TEXT', 'PIE or ELGI, not a number — matched a rule meant for reorderLevel'],
  revision: ['TEXT', 'the quotation revision LABEL: R0, R1, R2. I put this in the INTEGER rule ' +
    'myself and it was wrong. Quotations.gs settles the argument — it reads the number out ' +
    'with String(r.revision).replace(/[^0-9]/g, \'\'), which it would not need to do for an ' +
    'integer. As INTEGER every revision came back blank, and the revision chain is what ' +
    'decides which offer is the live one'],
  oldValue: ['TEXT', 'audit log: whatever changed, which is usually not money'],
  newValue: ['TEXT', 'audit log: whatever changed, which is usually not money'],
  serialNos: ['TEXT', 'a list of serials in one cell, not one number'],

  at: ['TIMESTAMPTZ', 'the timing row\u2019s instant'],
  timestamp: ['TIMESTAMPTZ', 'an instant, named without the At suffix'],
  warrantyStart: ['DATE', 'a day'],
  warrantyEnd: ['DATE', 'a day'],
  date: ['DATE', 'a day'],

  amount: ['NUMERIC(14,2)', 'money'],
  amountReceived: ['NUMERIC(14,2)', 'money'],
  lineTotal: ['NUMERIC(14,2)', 'money'],
  freight: ['NUMERIC(14,2)', 'money'],
  creditLimit: ['NUMERIC(14,2)', 'money'],
  availableCredit: ['NUMERIC(14,2)', 'money'],
  openOrderExposure: ['NUMERIC(14,2)', 'money'],
  totalExposure: ['NUMERIC(14,2)', 'money'],
  probability: ['NUMERIC(14,2)', 'a percentage'],
  weightKg: ['NUMERIC(14,3)', 'a measurement'],
  motorKw: ['NUMERIC(14,3)', 'a measurement'],
  quantity: ['NUMERIC(14,3)', 'a quantity, which can be fractional'],
  sizeBytes: ['BIGINT', 'a file size'],
  lineNo: ['INTEGER', 'a position on the document'],

  poVerified: ['BOOLEAN', 'a flag whose name does not start with is/has/must'],
  deliveryConfirmed: ['BOOLEAN', 'a flag'],
  commitmentMet: ['BOOLEAN', 'a flag'],
  checklistComplete: ['BOOLEAN', 'a flag'],
  serviceNotified: ['BOOLEAN', 'a flag'],
  logoShowsName: ['BOOLEAN', 'a flag'],
  compatibilityConfirmed: ['BOOLEAN', 'a flag']
};

/**
 * Columns I am not confident about, which the export will settle by looking at the data.
 *
 * Naming them is better than quietly picking one. TEXT holds whatever is actually in the
 * cell, so an import cannot lose anything while the question is open; tightening a column
 * afterwards is a migration, and losing the values is not recoverable.
 */
const UNSURE = {
  advanceRequired: 'a flag, or the amount required? TEXT until the data says.',
  advanceReceived: 'a flag, or the amount received? TEXT until the data says.',
  poVarianceNotes: 'free text, assumed',
  availabilityNote: 'free text, assumed'
};

/**
 * Type rules, most specific first.
 *
 * Order matters: `createdAt` must be caught as a timestamp before `*By`-style text rules,
 * and `maxDiscountPct` as numeric before anything generic. Each rule carries the reason it
 * fired so --report can defend every column rather than presenting a wall of types.
 */
const RULES = [
  { when: (c) => c === 'id', type: 'TEXT', why: 'surrogate key, e.g. SP-1042' },

  { when: (c) => /(^|[a-z])At$/.test(c) || c === 'lockedUntil',
    type: 'TIMESTAMPTZ', why: 'instant — stored as an ISO string on the sheet' },

  { when: (c) => /Date$/.test(c) || /^effective(From|To)$/.test(c) || c === 'validUntil',
    type: 'DATE', why: 'calendar day, yyyy-MM-dd on the sheet' },

  { when: (c) => /(Pct|Price|Amt|Amount|Value|Rate)$/.test(c) ||
                 ['price', 'grand', 'subtotal', 'total', 'balance', 'cost'].indexOf(c) !== -1,
    type: 'NUMERIC(14,2)', why: 'money or percentage — never a float' },

  { when: (c) => /^qty/.test(c) || /Qty$/.test(c) || c === 'qty',
    type: 'NUMERIC(14,3)', why: 'quantity, which can be fractional (metres, litres)' },

  { when: (c) => /(Days|Months|Count|Level|Stock|Order|Attempts|Iterations)$/.test(c) ||
                 ['ms', 'tabsRead', 'rowsRead'].indexOf(c) !== -1,
    type: 'INTEGER', why: 'whole number' },

  { when: (c) => /^(is|has|must|can)[A-Z]/.test(c) ||
                 ['active', 'locked', 'enforced', 'creditHold'].indexOf(c) !== -1,
    type: 'BOOLEAN', why: 'flag — TRUE/FALSE text on the sheet' },

  { when: (c) => /Id$/.test(c), type: 'TEXT', why: 'foreign key, an id not a name' },

  { when: (c) => /(Email|By)$/.test(c), type: 'TEXT', why: 'person, recorded by address' },
];

function typeFor(column) {
  if (OVERRIDES.hasOwnProperty(column)) {
    return { type: OVERRIDES[column][0], why: OVERRIDES[column][1], override: true };
  }
  if (UNSURE.hasOwnProperty(column)) {
    return { type: 'TEXT', why: UNSURE[column], unsure: true };
  }
  for (const rule of RULES) {
    if (rule.when(column)) return { type: rule.type, why: rule.why };
  }
  return { type: 'TEXT', why: 'no convention matched — TEXT loses nothing and tightens later' };
}

/** snake_case, because a Postgres identifier that needs quoting is a Postgres identifier
 *  everybody eventually gets wrong. */
function snake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
}

function build() {
  const SCHEMA = loadSchema();
  const tables = Object.keys(SCHEMA);
  const ddl = [];
  const report = [];

  ddl.push('-- Generated from src/Schema.gs by migration/schema.js. Do not hand-edit:');
  ddl.push('-- add the column to Schema.gs and regenerate, so the sheet and the database');
  ddl.push('-- cannot disagree while both are live during the cutover.');
  ddl.push('');
  ddl.push('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  ddl.push('');

  tables.forEach((tab) => {
    const cols = SCHEMA[tab].columns;
    const lines = [];

    // Every table carries the tenant from the first migration. PIE is the first client and
    // the intention is to sell this to others; adding this column later means touching 52
    // tables, every query and every index at a point when real customers' data is in them.
    lines.push('  tenant_id   TEXT NOT NULL');

    cols.forEach((c) => {
      const t = typeFor(c);
      const { type, why } = t;
      // Carry the flags through. Dropping `unsure` here meant the review list computed
      // correctly and then printed nothing, which is the quietest way for a check to fail.
      report.push({ table: tab, column: c, type, why, unsure: !!t.unsure, override: !!t.override });
      const name = snake(c);
      const pad = ' '.repeat(Math.max(1, 12 - name.length));
      lines.push('  ' + name + pad + type + (c === 'id' ? ' NOT NULL' : ''));
    });

    lines.push('  PRIMARY KEY (tenant_id, id)');

    ddl.push('CREATE TABLE IF NOT EXISTS ' + snake(tab) + ' (');
    ddl.push(lines.join(',\n'));
    ddl.push(');');

    // The sheet reads whole tabs and filters in memory because that is all it can do. The
    // database does not have to, and these are the filters the code actually applies.
    const indexable = cols.filter((c) =>
      /Id$/.test(c) || ['itemType', 'status', 'partNo', 'productCode', 'productGroup',
        'businessStream', 'active', 'priceLevel', 'email', 'username'].indexOf(c) !== -1);
    //
    // Named, and IF NOT EXISTS, so that applying this twice is harmless. Unnamed, every run of
    // migration/dev-db.sh added another full set: the CREATE TABLEs failed on tables that were
    // already there, the CREATE INDEXes did not, and a local database reached 2,773 indexes
    // where there should be 212, with every insert maintaining seventeen copies of each.
    //
    // The name is the one Postgres chooses for itself when none is given, so the indexes
    // already on Neon — created unnamed, once, by apply-schema.js — are the same indexes and
    // a re-apply there recognises them rather than adding a second set.
    indexable.forEach((c) => {
      const name = snake(tab) + '_tenant_id_' + snake(c) + '_idx';
      // Postgres cuts identifiers at 63 bytes without complaint. Two long names that agree in
      // their first 63 would then be one name, and IF NOT EXISTS would quietly skip the second
      // index. Every name today is 60 or under; this keeps it that way.
      if (name.length > 63) throw new Error('index name too long for Postgres: ' + name);
      ddl.push('CREATE INDEX IF NOT EXISTS ' + name + ' ON ' + snake(tab) +
        ' (tenant_id, ' + snake(c) + ');');
    });
    ddl.push('');
  });

  return { ddl: ddl.join('\n'), report, tables };
}

/**
 * Also a module. `server/db.js` needs the same three answers this file already works out —
 * which tabs exist, what each column is called in Postgres, and what type it holds — and a
 * second copy of those rules would drift from this one within a month. One source, used by
 * the thing that creates the schema and the thing that reads it.
 */
module.exports = { loadSchema, typeFor, snake, build, OVERRIDES, UNSURE };

if (require.main !== module) return;

const { ddl, report, tables } = build();

if (process.argv.indexOf('--report') !== -1) {
  // Grouped by type AND reason. Grouping by type alone printed 616 TEXT columns under
  // whichever reason the first of them happened to carry, which made the report look
  // authoritative while saying nothing — the opposite of what it is for.
  const groups = {};
  report.forEach((r) => {
    const key = r.type + '\u0000' + r.why;
    (groups[key] = groups[key] || []).push(r.column);
  });
  console.log(tables.length + ' tables, ' + report.length + ' columns\n');
  Object.keys(groups).sort().forEach((key) => {
    const [type, why] = key.split('\u0000');
    const names = Array.from(new Set(groups[key])).sort();
    console.log(type + '  (' + names.length + ' distinct)  \u2014 ' + why);
    console.log('    ' + names.join(', ') + '\n');
  });
  const unsure = report.filter((r) => r.unsure);
  if (unsure.length) {
    console.log('NEEDS A LOOK AT THE DATA BEFORE THE TYPES ARE TIGHTENED');
    Array.from(new Set(unsure.map((r) => r.column))).sort().forEach((c) => {
      console.log('  ' + c + ' \u2014 ' + UNSURE[c]);
    });
  }
} else {
  console.log(ddl);
}
