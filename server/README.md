# Running the portal

```
DATABASE_URL=postgres://... node server/index.js
```

That is enough to serve every screen. The four things below are only needed for the
features that reach outside the database, and each one refuses in words naming its own
variable until it is set — nothing fails silently.

## Settings

| variable | what it does |
|---|---|
| `DATABASE_URL` | required; Neon's non-pooled string |
| `PORT` | default 3000 |
| `TENANT_ID` | default `pie` |
| `ERP_UI` | `classic` serves what Apps Script serves; omit for the new design |
| `ERP_BASE_URL` | what this server calls itself, e.g. `https://erp.pie.in`. Needed for the Google sign-in, which must match a redirect URI registered with Google. Derived from the request when unset. |
| `ERP_FILES_DIR` | where attachments go; default `var/files` beside the code |
| `ERP_CHROMIUM` | path to Chromium, for PDFs; found automatically in the usual places |
| `SMTP_URL` | e.g. `smtps://smtp.gmail.com:465` |
| `SMTP_USER` / `SMTP_PASSWORD` | the mailbox, and an app password where the provider wants one |
| `SMTP_FROM` | what the customer sees; defaults to `SMTP_USER` |
| `ERP_FILE_SECRET` | signs attachment links; derived from `DATABASE_URL` when unset |
| `ERP_PROPERTIES` | JSON seeding settings the database does not have yet |
| `ANTHROPIC_API_KEY` | turns on 2.0's Ask bar (`server/ai.js`); never stored anywhere but the environment |
| `ERP_AI_MODEL` | the Claude model the Ask bar uses; default `claude-opus-5-5` |

## The four outside things, and what each one needs

**Attachments** (purchase orders, invoices, delivery photographs, service proofs) go to
`ERP_FILES_DIR`. **That directory must be on a disk that survives a restart and must be in
the backup** — it is not in the database, so a Neon backup does not contain it. A volume on
Railway or Render; an ordinary directory on a VPS. See `server/files.js` for why the
filesystem and not Postgres (the portal calls Drive synchronously and a database write in
Node is not).

**PDFs** need a Chromium binary. The first render builds a font cache and takes several
seconds; later ones take about half of one, during which this process does nothing else.
That is a deliberate trade — see `server/pdf.js`.

**E-mail** needs an SMTP mailbox. Any provider: the message is built here and handed to
curl. Unset, sending a quotation refuses and says the quotation itself is saved.

**Tally** needs `TALLY_ENDPOINT` and `TALLY_COMPANY`, set from Settings → Tally Connection
in the portal, and a Tally that this server can actually reach. Tally normally sits on the
office LAN, so a server in a data centre may not be able to see it at all; that is a
network question, not a code one.

## Settings that stick

The Google gate, the telemetry switch and the Tally connection live in a `settings` table,
created automatically. They used to be Apps Script's Script Properties and were briefly an
object in memory here, which meant they were forgotten on every restart — and because a
missing Google-gate setting reads as *off*, a portal that demanded a Google account on Apps
Script quietly did not on the server. Both halves of that are fixed: the setting persists,
and the sign-in it demands is served. Only one instance of this server should run against
one database; see `server/settings.js`.

## Attachment links

Rows hold `/files/<id>`. The server signs each one on its way out, so what the browser gets
is good for a day. A signed link is as good as a password for that one file until it
expires — the same bargain as a Drive "anyone with the link" share, which is why it is short.
