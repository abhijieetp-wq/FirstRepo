# The cutover

Switching PIE from the Google Sheet to the new portal. One evening, about an hour, most of
it checking rather than doing.

This has been rehearsed end to end at PIE's scale — 115,049 rows exported, imported and
checked — so the timings below are measured, not guessed.

## The shape of it

**Nothing is overwritten.** The new data goes into a *second* database, and the switch is
one environment variable. Rollback is changing it back and redeploying: two minutes, and
the old database is untouched the whole time.

```
    Neon: neondb          the 16 October snapshot — stays exactly as it is
    Neon: erp_live        the final export goes here
    Railway DATABASE_URL  points at one or the other.  That is the switch.
```

## Timings, measured

| Step | Time | Who |
|---|---|---|
| Export in Apps Script | ~5 min | the script, you watch |
| Download and unzip from Drive | ~3 min | you |
| Create the tables | 1 s | command |
| Import, checks only | 1 s | command |
| Import, for real | 5 s | command |
| Print the figures | 1 s | command |
| **Check the figures against the Sheet** | **10–20 min** | you, carefully |
| Switch and redeploy | ~2 min | Railway |

The machine takes about eight seconds. Everything else is you reading. Budget an hour and
you will not be rushed.

---

## Before the day

1. **Tell PIE when.** After close of business. Nobody in the Sheet from that moment.
2. **Create the second database.** Neon → your project → **Databases** → New, called
   `erp_live`. (A Neon *branch* works too and is tidier, if your plan allows one.)
3. **Have the figures from the Sheet ready to compare against.** Open the Control Tower in
   the old portal and screenshot it: outstanding, open order book, invoiced this month,
   collected this month, open quotations. Those are the numbers that must match.
4. **Decide who is told what afterwards.** The URL changes. People have the old one
   bookmarked.
5. **Have the data pack on the PC.** `PIE-data-pack-<date>.zip` — every file PIE shared
   while the website was built, and the upload files made from them. Its folder
   `2-upload-after-cutover` holds the three files step 6 uploads. The pack is not in git
   (ELGi's prices and spec sheets are confidential) and the cloud machine that made it is
   temporary, so the copy on the PC or in engage@'s private Drive is the only one.

---

## On the day

### 1. Freeze the Sheet

Tell everyone to stop. Then make it real rather than a request: open the Sheet →
**Share** → change the team from Editor to Viewer. Anything typed after this point is lost,
and the point of the freeze is that nothing is.

### 2. Export

In the Apps Script editor, run `exportForMigration()`. It writes one folder to Drive.
Wait for "Export complete".

If it stops partway, run it again — it carries on from where it stopped. If it says it is
starting again in a new folder, let it: that means the build changed and mixing two formats
in one folder is the one thing it will not do.

### 3. Download

Download that folder from Drive, unzip it, and note the path. It will look like
`...\PIE ERP migration export 2026-11-02-19-14-03`.

### 4. Load it

In cmd, in the project folder. Set the connection string for the **new** database:

```
set "DATABASE_URL=postgresql://neondb_owner:PASSWORD@ep-xxxx.ap-southeast-1.aws.neon.tech/erp_live?sslmode=require"
```

Then:

```
node migration\apply-schema.js
node migration\import.js "C:\path\to\the\export folder"
```

The second command writes nothing. It recomputes every row's digest, recomputes every tab's
digest, checks every column has somewhere to go, and checks every timestamp can be read.
**If it does not end with "Checks passed", stop and send me the output.** Nothing has been
touched yet, so stopping here costs nothing.

Then, for real:

```
node migration\import.js "C:\path\to\the\export folder" --write
```

It ends with *"Every row and every field made the trip."* — it reads every row back out and
compares it field by field. If it reports differences, read them: `rounded` and `retyped`
are usually fine, `lost` never is.

### 5. Check the figures — the part that matters

```
node migration\headline.js
```

This prints what the portal itself believes, using the same code the Control Tower uses.
Compare it against the screenshot from step 3 of the preparation:

- outstanding, and how much of it is overdue
- open order book, and the number of orders
- invoiced and collected this month
- open quotations and their value
- spares on the catalogue, price rows, customers

**They should match.** Small differences in the month-to-date figures are expected if the
Sheet's day rolled over; a difference in outstanding or the catalogue count is not. If
anything is off, stop — nothing has been switched, and the Sheet is still the system of
record.

> If every figure is zero, the tenant is wrong, not the data. `import.js` and
> `headline.js` both take `--tenant` and both default to `pie`; they must agree.

### 5b. Bring the website's own settings across

The Google client, the Gmail connection quotations are sent through, whether Google sign-in is
demanded and for whom, and the Tally address were set on the website, not in the Sheet — they
are in the **old** database's settings table and nowhere else. Copy them before switching, or
the website comes up without them and Gmail has to be connected again by PIE's account holder.

```
set "FROM_DATABASE_URL=<the OLD connection string — the one with neondb>"
set "DATABASE_URL=<the NEW connection string — the one with erp_live>"
node migration\copy-settings.js
node migration\copy-settings.js --write
```

The first run lists what it would copy and writes nothing. Secrets show only as *(set, N
characters — not shown)*. The second copies them and ends with *"Switch DATABASE_URL in Railway
now"*. It must run before the switch: the server reads its settings when it starts.

### 6. Switch

Railway → Variables → `DATABASE_URL` → change `neondb` to `erp_live` in the string. Save.
Railway redeploys on its own.

When it comes back, open `/health`:

- `database` should be about 30ms
- `attachments` should say `ok`
- `settings` should say the same number held as before (step 5b copied them), and `email`
  should say `via: gmail`. If `settings` says `0 held`, step 5b was skipped: run it, then
  redeploy.

Then open the portal and check the Control Tower shows the same figures you just verified.

Then upload the compressor specifications once more: Catalog → Products (Compressors) → Bulk
Upload → `ELGi-compressor-specs-upload.csv` (kept in `imports/`, never in git). Everything in it
came across with the Sheet except the specific power (SPC) column, which the Apps Script upload
does not know and skipped; the model picker ranks energy use by it. The preview should say
**0 new, 32 updated, 0 price changes** — anything else, stop and look before confirming.

Then the second file the same way: `ELGi-units-modelwise-upload.csv` (67 models — EG 55/55PM/75/75SP,
EN5, EN11, the EQ VFD range and EQ2–EQ7; also in `imports/`). If it was uploaded to the Sheet before
the freeze, expect **0 new, 67 updated**; if not, **67 new**. Built from ELGi's model-wise spec
workbook by `migration/elgi-specs-to-upload.py`, which converts later workbooks in the same layout.

Then the accessories' specification tables: Catalog → Spares → Bulk Upload →
`ELGi-accessory-specs-upload.csv` (also in `imports/`). The Sheet has no columns for them, so
nothing came across. Expect **0 new, 6 updated, 0 price changes** — more if PIE has added rows
to the file since. Its description column is blank on purpose: a blank never overwrites, so the
parts keep their own descriptions. Anything typed into a part's *Specification table* on the
website before the switch is in the old database only, and needs typing again or adding to
this file.

Standard quotation text the Sheet never had — the EG's scope of supply, and the wording of
PIE's compressor price schedule — is installed on the first load after the switch, because
step 5b leaves the build stamp behind. Settings → Quotation Text should list two *Scope of
supply* rows, one marked *EG series*, and a *Wording on the document* row for Compressor Sales.
Wording edited on the website before the switch (not in the Sheet) has to be edited again.

### 7. Hand over

- Send PIE the new address.
- Leave the Sheet read-only. Do not delete it — it is the only thing that can settle an
  argument about what the data looked like before.
- Delete the export folder from Drive once you are happy. It holds PIE's whole business in
  plain JSON.

---

## If something is wrong afterwards

**Within minutes:** Railway → Variables → put `neondb` back in `DATABASE_URL`. Two minutes
and you are exactly where you started. Unfreeze the Sheet and tell people to carry on there.

**After PIE have done a day's work in it:** rolling back now means losing that day. Fix
forward instead — tell me what is wrong. The old database is still there and still correct
as of the cutover, which is what makes a comparison possible.

## What does not come across

- **Attachments uploaded while testing.** Anything you attached to the 16 October snapshot
  is still on the volume but belongs to rows that no longer exist. Harmless. Clear the
  volume if you want it tidy.
- **The website's own settings** — Google client, Gmail connection, sign-in requirement,
  Tally address — only if step 5b is skipped. They live in the `settings` table of whichever
  database is connected; `migration/copy-settings.js` carries them across.
- **Anything typed into the Sheet after the freeze.** Which is why the freeze is a
  permission change and not an announcement.
