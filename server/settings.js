/**
 * The settings that used to be Script Properties.
 *
 * Seven keys matter on the server: the Google gate's four (whether it is demanded, which
 * accounts, the client id and secret), the telemetry switch, and Tally's endpoint and
 * company. On Apps Script they lived in a key-value store attached to the script project.
 * Here they were an empty object in memory, which had two consequences nobody would have
 * noticed:
 *
 *   - whatever PIE set was forgotten on the next restart, and a deployment restarts;
 *   - the Google gate reads as off when its key is missing, so a portal that demands a
 *     Google account on Apps Script quietly did not on the server.
 *
 * The second is why this exists now rather than later. It is not a bug in GoogleGate.gs —
 * that code is correct and refuses properly when the key says on. It is a setting that had
 * nowhere to live.
 *
 * READS ARE SYNCHRONOUS, because PropertiesService is: `googleGateProp_` calls
 * getProperty() with no `await` and cannot be changed without re-converting the modules
 * that call it. So the whole table is read into memory once before the server answers
 * anything, and reads are served from there. Writes go to memory first — so the next read
 * in the same request sees them — and to the database behind them. A write that fails to
 * reach the database is logged loudly rather than swallowed: the setting will be right
 * until the next restart and wrong after it, which is exactly the failure worth shouting
 * about.
 *
 * ONE INSTANCE. Two servers sharing a database would not see each other's writes until
 * they restarted. That is fine for one process serving PIE and is written down here so
 * that whoever first runs two of these knows what to fix.
 */
'use strict';

const DDL = `CREATE TABLE IF NOT EXISTS settings (
  tenant_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, key)
)`;

/**
 * @param db        a Db, already bound to a tenant
 * @param defaults  values to use for keys the database does not have — ERP_PROPERTIES,
 *                  so a secret can come from the environment instead if that is preferred
 * @param onError   told about a write that did not reach the database
 */
function settingsStore(db, defaults, onError) {
  const props = Object.assign({}, defaults || {});
  const complain = onError || ((message) => console.error(message));
  let loaded = false;

  /** Reads the table into memory. Must finish before the server answers anything. */
  async function load() {
    await db.q(DDL);
    const rows = await db.q('SELECT key, value FROM settings WHERE tenant_id = $1', [db.tenant]);
    for (const r of rows.rows) props[r.key] = r.value;
    loaded = true;
    return Object.keys(props).length;
  }

  function persist(key, value, who) {
    const sql = value === null
      ? 'DELETE FROM settings WHERE tenant_id = $1 AND key = $2'
      : `INSERT INTO settings (tenant_id, key, value, updated_at, updated_by)
         VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (tenant_id, key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    const params = value === null ? [db.tenant, key] : [db.tenant, key, String(value), who || ''];
    // Not awaited: getProperty and setProperty are synchronous on Apps Script and the
    // portal calls them that way. The write is in flight when this returns.
    Promise.resolve(db.q(sql, params)).catch((err) => {
      complain('[settings] "' + key + '" was changed but could not be saved: ' +
        (err && err.message) + ' — it will be lost when this server restarts.');
    });
  }

  /** The PropertiesService store, with the methods the portal calls. */
  function store(actor) {
    const self = {
      getProperty: (k) => {
        if (!loaded) {
          // Only reachable if something asks before load() finished, which the server
          // prevents. Saying so beats quietly answering "not set", which for the Google
          // gate means "off".
          throw new Error('Settings have not been read yet.');
        }
        return Object.prototype.hasOwnProperty.call(props, k) ? String(props[k]) : null;
      },
      setProperty: (k, v) => { props[k] = String(v); persist(k, String(v), actor); return self; },
      deleteProperty: (k) => { delete props[k]; persist(k, null, actor); return self; },
      getProperties: () => Object.assign({}, props),
      setProperties: (obj) => {
        for (const [k, v] of Object.entries(obj || {})) self.setProperty(k, v);
        return self;
      },
      getKeys: () => Object.keys(props)
    };
    return self;
  }

  return { load, store, props, isLoaded: () => loaded };
}

module.exports = { settingsStore, DDL };
