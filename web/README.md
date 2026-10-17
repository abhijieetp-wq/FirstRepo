# The new design

The portal has two faces over the same markup and the same behaviour:

| face | who serves it | files |
|---|---|---|
| **new design** | the Node server (`server/index.js`) | `src/Index.html` + `src/JavaScript.html`, dressed by `web/Stylesheet.html`, extended by `web/Shell.html` |
| **classic** | Apps Script — and the Node server with `ERP_UI=classic` | `src/` only |

`server/page.js` assembles both. The design lives here rather than in `src/` because
`clasp push` pushes `src/` and nothing else (`.clasp.json` → `rootDir: "src"`). So the
live Apps Script portal stays on the classic look however often `clasp push` runs, until
the cutover — it is a property of where the files are, not something to remember.

## What is in each file

**`Stylesheet.html`** — the whole look. A dark sidebar (the old top bar, laid out down the
side: same element, same buttons, same click handlers), a workspace bar, icon tiles on
every screen heading, cards, tables, status pills, forms that open as sheets from the right,
the split sign-in screen, the command palette. Nineteen of its custom properties are read by
name from `src/JavaScript.html`; the list is at the top of the file.

**`Shell.html`** — what a stylesheet cannot do alone. It adds icons, section labels, the
breadcrumb, the command palette (`Ctrl K`), the phone drawer, the sidebar fold, the
sign-in panel, and the class that pins each form's buttons to the bottom of its sheet. It
reaches the portal only through the DOM — it presses the same buttons a person presses and
watches for the menu and the dashboard being drawn — and every part is wrapped so a fault
costs a decoration, never a screen.

## Switching back

```
ERP_UI=classic node server/index.js
```

serves exactly what Apps Script serves. No deployment, nothing lost; unset it to return.

## Looking at it without a database

```
node tests/build-preview.js tests/fixtures/showcase.html /tmp/show.html --ui=web --title="ELGi Sales ERP"
```

builds a standalone copy against invented but realistic data. Open it in a browser served
over HTTP with `/fonts/` mapped to `assets/fonts/` to see the real typefaces; opened as a
file it falls back to system fonts.

## Tests

- `tests/shell-ui-test.js` — everything the shell adds, in Chromium.
- `tests/portal-ui-test.js` — the portal's behaviour; `tests/run.sh` runs it against both faces.
- `tests/server-test.js` — the server serves the new face by default and the classic one when switched.
- `tests/browser-server-test.js` — signing in against the real server, with every font fetched from its own origin.

Icons are [Lucide](https://lucide.dev) path data (ISC licence), embedded in `Shell.html`.
