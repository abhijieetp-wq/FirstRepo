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

### 6. Switch

Railway → Variables → `DATABASE_URL` → change `neondb` to `erp_live` in the string. Save.
Railway redeploys on its own.

When it comes back, open `/health`:

- `database` should be about 30ms
- `attachments` should say `ok`
- `settings` will say `0 held` — the Google gate and Tally settings live in the old
  database. Set them again in Settings, or copy the `settings` table across.

Then open the portal and check the Control Tower shows the same figures you just verified.

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
- **Script Properties.** The Google gate's settings and the Tally endpoint live in the
  `settings` table of whichever database is connected. Re-enter them, or:
  `INSERT INTO settings SELECT * FROM ...` across the two databases.
- **Anything typed into the Sheet after the freeze.** Which is why the freeze is a
  permission change and not an announcement.
