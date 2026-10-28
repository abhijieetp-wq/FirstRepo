# ERP 2.0

ERP 2.0 is a third face of the same portal, built screen by screen over ERP 1:

| face | files |
|---|---|
| **2.0** (`v2`) | `web/Stylesheet.html` + **`web2/Theme.html`**, `src/JavaScript.html`, `web/Shell.html` + **`web2/Shell.html`** |
| new design (`web`, the default) | `web/Stylesheet.html`, `src/JavaScript.html`, `web/Shell.html` |
| classic | `src/` only — what Apps Script serves |

Same markup, same behaviour, same server. Every screen, rule, permission, bulk import and
printed or e-mailed quotation is ERP 1's own; 2.0 changes how it looks and, screen by screen
from here, how it is laid out. Nothing in `web2/` can reach Apps Script (`clasp` pushes `src/`).

## Switching it on

- **One browser:** add `?look=2` to any address. That browser keeps 2.0 until `?look=web`
  (back to the new design) or `?look=default` (whatever the server serves everyone). Nobody
  else's screen changes. The menu has a "Back to the current look" link at its foot.
- **Everyone:** `ERP_UI=v2`. Unset it to go back. No deployment of code either way.

## What is in each file

**`Theme.html`** — ERP 2's look as tokens over the new design's: the green rail, the lime
accent, greenish neutrals, Archivo and IBM Plex Sans (self-hosted, `assets/fonts/`), flatter
corners. A handful of rules re-colour the places `web/Stylesheet.html` wrote a colour out in
full. The nineteen custom-property names `JavaScript.html` reads keep their names.

**`Shell.html`** — runs after `web/Shell.html`, through the DOM only, like it. Today: names the
Service Due Calls screen **SDR** (menu, heading, breadcrumb, browser tab, command palette),
marks the app's name "2.0", and adds the way back.

## The rule for each screen that moves to 2.0

A screen takes ERP 2's layout only when it keeps everything ERP 1's version of it does — the
ERP 1 column of the gap audit is the checklist. The quotation that is printed or sent stays
`QuotationDocument.gs`'s, unchanged.

## Tests

- `tests/v2-ui-test.js` — what 2.0 adds, and that the bulk imports and every screen survive it.
- `tests/run.sh` runs every screen suite against the 2.0 face as well as the other two.
- `tests/server-test.js` — `ERP_UI=v2`, `?look=`, and the cookie.
