# Deploying the portal

What this gets you: PIE's ERP on a web address, running on Neon, with quotation PDFs,
attachments and e-mail working. About an hour, most of it waiting.

Everything here is done once. After it, a deployment is `git push`.

> **Before you start:** the data in Neon is the export from 16 October. PIE have been
> working in the Sheet since, so this deployment is for *you and PIE to look at and try* —
> not for real work. Everything entered into it is replaced at cutover. Tell whoever you
> show it.

---

## 1. What you need first

| | |
|---|---|
| A host account | Under `engage@imcglobal.in`, not a personal address. The ERP outlives whoever set it up. |
| The Neon connection string | The non-pooled one, the same as for the import. Neon → your project → Connection string → untick **Connection pooling**. |
| A domain or subdomain | e.g. `erp.premierindia.in`, or use the host's free subdomain to start. |
| A mailbox for quotations | Optional at first. Everything else works without it. |

**Railway** is the suggested host: it builds from a Dockerfile, has persistent volumes,
and has a Singapore region close to your Neon project. Render and Fly work the same way;
the variables below are identical, only the buttons differ.

---

## 2. Create the service

1. Railway → **New Project** → **Deploy from GitHub repo** → `abhijieetp-wq/FirstRepo`.
2. Settings → **Branch**: `claude/elgi-spares-erp-phase-1-854czo`.
3. Settings → **Deploy** → **Region**: Singapore (`asia-southeast1`). **Check this; it
   matters more than it looks.** Railway defaults to US East (`iad`), and with Neon in
   Singapore every single query would cross the Pacific — roughly 230ms each, on a portal
   that makes several per screen. That one setting is the difference between the speed
   this was rebuilt for and something slower than the spreadsheet was. If the region is
   locked on your plan, move the Neon database to a US region instead; what matters is
   that the two are near each other.
4. Settings → **Deploy** → **Healthcheck Path**: `/health`. Railway then waits for the
   server to answer before sending it traffic, and rolls back a deployment that never does.
5. It will find the `Dockerfile` at the repository root on its own. Do not set a build or
   start command — the Dockerfile has both.

The first build takes five to ten minutes, mostly installing Chromium. Later builds are
quicker.

---

## 3. Add a volume — before the first deploy finishes

Railway → your service → **Variables / Volumes** → **New Volume**, mount path `/data/files`.

The Dockerfile deliberately contains no `VOLUME` instruction — Railway rejects a Dockerfile
that has one (*"docker VOLUME at Line 60 is not supported, use Railway Volumes"*), which
cost one failed build before it was taken out. Storage is attached here, in the dashboard,
and nowhere else.

This is where purchase orders, delivery photographs and generated PDFs go. **It is not in
the database, so a Neon backup does not contain it.** Without a volume, every attachment
is lost on each deployment, and nothing will warn you until somebody looks for a PO.

---

## 4. Set the variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | the non-pooled Neon string, in full |
| `ERP_BASE_URL` | `https://erp.premierindia.in` — whatever address people will type |
| `TENANT_ID` | `pie` |
| `ERP_FILE_SECRET` | any long random string; generate one and keep it. Changing it later invalidates attachment links that are already open on somebody's screen. |

`PORT`, `ERP_FILES_DIR` and `ERP_CHROMIUM` are already set correctly by the Dockerfile.
Do not override them.

For e-mail, when you have a mailbox:

| Variable | Value |
|---|---|
| `SMTP_URL` | `smtps://smtp.gmail.com:465` for Google Workspace, `smtps://smtp.zoho.in:465` for Zoho |
| `SMTP_USER` | the full address, e.g. `office@premierindia.in` |
| `SMTP_PASSWORD` | an **app password**, not the account password. Google and Zoho both require one when two-factor is on. |
| `SMTP_FROM` | usually the same as `SMTP_USER` |

---

## 5. Point the domain

Railway → Settings → **Networking** → **Custom Domain** → enter the name. It gives you a
CNAME. Add that record wherever the domain's DNS lives. TLS is issued automatically once
the record resolves, which is usually minutes but can be an hour.

Then make sure `ERP_BASE_URL` matches the final address exactly — scheme and all.

---

## 6. Check it

Open `https://your-address/health`. You should see:

```json
{
  "ok": true,
  "build": "2026-10-17.5",
  "look": "web",
  "database": "4ms",
  "attachments": { "state": "ok", "dir": "/data/files/pie", "held": 0 },
  "pdfs":        { "state": "ok", "chromium": "/usr/bin/chromium" },
  "email":       { "state": "ok" },
  "googleGate":  "off"
}
```

Read every line before moving on:

| What it says | What to do |
|---|---|
| `attachments: NOT WRITABLE: EACCES` | The volume is there but the container cannot write to it. Railway → Volume → remount, or redeploy. This is the most common first-deploy problem. |
| `attachments: dir` is not under `/data` | The volume is not mounted. Attachments are going into the container and will vanish. |
| `pdfs: unavailable` | Chromium is missing from the image. The build probably failed partway — check the build log. |
| `email: unconfigured` | Expected until you set the three SMTP variables. |
| `database` over ~200ms | The service and Neon are in different regions — almost always Railway defaulting to `iad` while Neon is in Singapore. Fix the region; do not accept it. |

Then sign in and try, in this order: open a quotation → **PDF** (proves Chromium), attach
a file to a sales order and reopen it (proves the volume), and if e-mail is configured,
send a quotation to your own address.

---

## 7. The Google sign-in — last, and only after the domain works

The portal can demand a company Google account before the password. **Do not switch it on
before this is done, or nobody can get in**, including you.

1. Google Cloud Console → the project that owns the OAuth client → **Credentials** → your
   OAuth 2.0 Client ID.
2. Under **Authorised redirect URIs**, add your address exactly: `https://erp.premierindia.in`.
   No trailing slash, no path. It must match `ERP_BASE_URL` character for character.
3. In the portal: Settings → the Google gate → paste the client id and secret, list the
   accounts that may enter, and only then switch it on.
4. Sign out and sign in again in a private window to prove it works before telling anybody.

If it locks you out: set `GOOGLE_GATE` to `off` in the `settings` table in Neon
(`UPDATE settings SET value='off' WHERE key='GOOGLE_GATE'`) and reload. That is the way
back, and it is worth knowing before you need it.

---

## Rolling back

Railway keeps every deployment. Pick the previous one → **Redeploy**. It takes a minute and
does not touch the database.

If something is wrong with the *data* rather than the code, that is the cutover procedure,
not this one.

## What is still manual

- **Tally.** Set the endpoint in Settings → Tally Connection. Tally normally sits on the
  office LAN, and a server in a Singapore data centre cannot reach a machine in Pune
  without a tunnel. Expect this one to need a network answer, not a code change.
- **Backups.** Neon handles the database. The volume at `/data/files` is yours to back up —
  it holds every purchase order and delivery photograph.
- **Keeping it warm.** Not needed: unlike Apps Script, the process stays up.
