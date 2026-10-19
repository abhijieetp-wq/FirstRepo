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

The portal goes on a **subdomain of IMC Global's domain** — for example
`pie.erp.<imc-domain>` — never on the bare domain, which carries IMC's own website and
mail. A subdomain also gives each later client a name of its own on the same pattern.

1. Railway → the service → Settings → **Networking** → **Custom Domain** → type the full
   name (`pie.erp.<imc-domain>`). Railway shows a **CNAME** target, something like
   `xxxx.up.railway.app`, and may show a **TXT** record to prove the domain is yours.
2. Wherever IMC's DNS is managed (GoDaddy, Cloudflare, the registrar's panel): add a
   **CNAME** record. Name: `pie.erp` (the part before the domain). Value: the target from
   step 1. If Railway showed a TXT record, add that too, exactly as shown.
3. Back in Railway, wait for the domain to show a green tick. TLS is issued automatically
   once the record resolves — usually minutes, occasionally an hour.
4. Railway → Variables → set `ERP_BASE_URL` to the final address, scheme and all:
   `https://pie.erp.<imc-domain>`. No trailing slash. Railway redeploys on save.
5. Open `https://pie.erp.<imc-domain>/health` and check it says `"ok": true`.

The old `…up.railway.app` address keeps working. Once the new one is confirmed, stop
using the old one so links in e-mails all carry the same name.

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
| `attachments: NOT WRITABLE: EACCES` | Should not happen any more — the server fixes this itself at start-up (it hands the mounted volume to its own user, then drops out of root before opening a socket). If it does appear, the start-up log says why; as a last resort set `ERP_RUN_AS=root`, which at least makes it a decision rather than an accident. |
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
2. Under **Authorised redirect URIs**, add your address exactly: `https://pie.erp.<imc-domain>`.
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

A release that adds a column or a table brings the database up to date by itself when it
starts — the log says `[schema] added …` — and only ever adds. Rolling the code back
afterwards leaves the new column in place, unused and harmless; nothing has to be undone by
hand.

If something is wrong with the *data* rather than the code, that is the cutover procedure,
not this one.

## What is still manual

- **Tally.** PIE's IT have confirmed the server can reach their Tally. In the portal:
  Settings → Tally Connection → enter the address they give you (it looks like
  `http://<their address>:9000`) → **Test Connection**. It should say *Tally answered* and
  how many companies it can see. Then open one issued invoice → **Send to Tally** and check
  it appears in Tally before relying on it.

  **Ask IT one question first:** is Tally's port open to the whole internet, or only to
  this server? Tally's XML port has no password — anybody who can reach it can read and
  post into PIE's books. It must accept connections from this server's address only (a
  fixed outgoing IP from Railway, or a VPN/tunnel between the two). An open port is not a
  setting to leave "for now".
- **Backups.** Neon handles the database. The volume at `/data/files` is yours to back up —
  it holds every purchase order and delivery photograph.
- **Keeping it warm.** Not needed: unlike Apps Script, the process stays up.
