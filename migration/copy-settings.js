/**
 * Carries the server's own settings from the old database to the new one at cutover.
 *
 * The cutover loads PIE's records into a fresh database (erp_live) and switches the website to
 * it. The records come from the Sheet; the server's settings do not — they were set on the
 * website and live in its `settings` table: the Google client id and secret, whether Google
 * sign-in is demanded and for which accounts, the Gmail connection quotations are sent through,
 * the Tally address. Without this step the website would come up on the new database with all
 * of them blank, and connecting Gmail again means getting PIE's account holder back with their
 * phone. With it, nothing needs redoing.
 *
 * It looks first and writes only when told to, like import.js. Values that are secrets are never
 * printed — not to the screen, not to a log — only that they exist and how long they are.
 *
 * Run it BEFORE switching DATABASE_URL in Railway: the server reads its settings once, when it
 * starts, and the switch is what restarts it.
 *
 *   set "FROM_DATABASE_URL=<the OLD database's connection string>"
 *   set "DATABASE_URL=<the NEW database's connection string>"
 *   node migration\copy-settings.js            shows what would be copied, writes nothing
 *   node migration\copy-settings.js --write    copies them
 *
 * --tenant, like import.js and headline.js, defaults to 'pie'.
 */
'use strict';

const path = require('path');
const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { DDL } = require(path.join(__dirname, '..', 'server', 'settings.js'));

const SECRET = /SECRET|TOKEN|PASSWORD|CREDENTIAL|KEY$/i;

/** What may be shown of a value: all of it, unless it is a secret. */
function shown(key, value) {
  const v = String(value === null || value === undefined ? '' : value);
  if (SECRET.test(key)) return v ? '(set, ' + v.length + ' characters — not shown)' : '(empty)';
  return v.length > 80 ? v.slice(0, 77) + '...' : (v || '(empty)');
}

/** Which database a connection string points at, without the password. */
function where(url) {
  try {
    const u = new URL(url);
    return (u.hostname || 'local socket') + ' / ' + (u.pathname.replace(/^\//, '') || '?');
  } catch (err) {
    return '(unreadable connection string)';
  }
}

async function copySettings(opts) {
  const o = opts || {};
  const from = connect({ connectionString: o.from, tenant: o.tenant });
  const to = connect({ connectionString: o.to, tenant: o.tenant });
  const say = o.say || console.log;
  try {
    say('From: ' + where(o.from));
    say('To:   ' + where(o.to));
    say('Tenant: ' + o.tenant + '\n');

    let source;
    try {
      source = await from.q('SELECT key, value, updated_by FROM settings WHERE tenant_id = $1 ' +
        'ORDER BY key', [o.tenant]);
    } catch (err) {
      throw new Error('Could not read settings from the old database: ' + err.message);
    }
    if (!source.rows.length) {
      say('The old database has no settings for "' + o.tenant + '". Nothing to copy.');
      return { copied: 0, rows: [] };
    }

    await to.q(DDL);
    const existing = await to.q('SELECT key, value FROM settings WHERE tenant_id = $1', [o.tenant]);
    const there = {};
    existing.rows.forEach((r) => { there[r.key] = r.value; });

    const plan = source.rows.map((r) => ({
      key: r.key, value: r.value, by: r.updated_by,
      action: !Object.prototype.hasOwnProperty.call(there, r.key) ? 'add'
        : there[r.key] === r.value ? 'same' : 'replace'
    }));
    const width = Math.max.apply(null, plan.map((p) => p.key.length));
    plan.forEach((p) => say('  ' + p.action.padEnd(8) + p.key.padEnd(width + 2) + shown(p.key, p.value)));
    const toWrite = plan.filter((p) => p.action !== 'same');
    say('');

    if (!o.write) {
      say(toWrite.length + ' setting(s) would be copied. Nothing written — add --write to copy them.');
      return { copied: 0, rows: plan };
    }

    await to.withTransaction(async (tx) => {
      for (const p of toWrite) {
        await tx.q(`INSERT INTO settings (tenant_id, key, value, updated_at, updated_by)
          VALUES ($1, $2, $3, now(), $4)
          ON CONFLICT (tenant_id, key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [o.tenant, p.key, p.value, 'copy-settings' + (p.by ? ' (set by ' + p.by + ')' : '')]);
      }
    });
    say(toWrite.length + ' setting(s) copied. Switch DATABASE_URL in Railway now: the server ' +
      'reads them when it starts.');
    return { copied: toWrite.length, rows: plan };
  } finally {
    await from.pool.end();
    await to.pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--tenant');
  const tenant = at !== -1 ? args[at + 1] : 'pie';
  const fromUrl = process.env.FROM_DATABASE_URL;
  const toUrl = process.env.DATABASE_URL;
  if (!fromUrl || !toUrl) {
    console.log('Set both connection strings first:\n' +
      '  FROM_DATABASE_URL  the OLD database, where the settings are now\n' +
      '  DATABASE_URL       the NEW database, where they are going');
    process.exit(1);
  }
  if (fromUrl === toUrl) {
    console.log('FROM_DATABASE_URL and DATABASE_URL are the same database. Nothing to copy.');
    process.exit(1);
  }
  await copySettings({ from: fromUrl, to: toUrl, tenant, write: args.indexOf('--write') !== -1 });
}

if (require.main === module) {
  main().catch((err) => { console.log('STOPPED: ' + err.message); process.exit(1); });
}

module.exports = { copySettings, shown };
