# Tests

One command: `./tests/run.sh`

Server suites need nothing installed. The browser suite needs Playwright once:

```
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
```

Chromium is already on the machine at `/opt/pw-browsers/chromium`; set `CHROMIUM` to point
somewhere else.

## The two kinds

**Server** (`tests/*-test.js`) — `harness.js` fakes the Apps Script globals over an in-memory
spreadsheet, loads the real `.gs` files into a `vm` context, and calls the real functions.
The sheet is a fake; the logic is not.

**Browser** (`tests/*-ui-test.js`) — `build-preview.js` stitches the real `Index.html`,
`Stylesheet.html` and `JavaScript.html` into one page with a fixture wedged in where the
stylesheet include sits. The fixture defines `google.script.run`, which is the only door the
client goes through, so the client under test is the real one rather than a copy that has
drifted. Every call is recorded in `window.__calls`, which is how a test asserts both what was
sent and how many round trips a screen costs.

## Why they live here

They used to live in the session scratchpad — a container that gets reclaimed. It was, with
about a hundred and ninety files in it. Nothing shipped was lost, because the code they covered
is committed; the regression protection was. Anything worth running twice belongs in the
repository.

`.clasp.json` sets `rootDir: src`, so this folder is never pushed to the Apps Script project.

## Writing one

Copy the shape of an existing file. Four rules, each of which has cost a real bug here:

- **Load every module whose functions get reached**, not just the one under test. Apps Script
  puts every `.gs` in one shared scope, so a missing file surfaces as `X is not defined` from
  somewhere that looks unrelated.
- **Assert what the code should do, not what it does.** An assertion written from current
  behaviour passes forever and catches nothing. Twice in this project a test was "fixed" to
  match a bug.
- **Never let a stub quietly do nothing.** `clearContent()` was a no-op in the harness, which
  made a working bulk delete look broken. A stub that disagrees with the platform is worse
  than no test, because it is believed.
- **Give the fixture an answer for every call the screen makes.** A missing one returns null,
  the client throws inside its own success handler where the failure handler cannot see it,
  and the screen renders empty with nothing anywhere saying why. `base.html` warns to the
  console when it is asked something it has no answer for.
