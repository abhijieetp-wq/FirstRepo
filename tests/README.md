# Tests

Node, no framework, no dependencies: `node tests/onesitting-test.js`.

Each file stubs the Apps Script globals a module touches — SpreadsheetApp over an in-memory
tab, LockService, CacheService, Utilities — then `vm.runInContext`s the real `.gs` files and
calls the real functions. Nothing is mocked that the code under test actually does; the sheet
is faked, the logic is not.

## Why these live here

They used to live in the session scratchpad, which is a container that gets reclaimed. It was,
with about a hundred and ninety test files in it. The code they covered is committed and
working, so nothing shipped was lost — but the regression protection was, and rebuilding it is
slower than never having lost it. Anything worth running twice belongs in the repository.

`.clasp.json` sets `rootDir: src`, so this folder is never pushed to the Apps Script project.

## Writing one

The harness at the top of `onesitting-test.js` is the pattern: copy it, change the module list,
seed the tabs you need. Two rules that have each cost a real bug here:

- Load every module whose functions are reached, not just the one under test. Apps Script puts
  every `.gs` in one shared scope, so a missing file shows up as `X is not defined` rather than
  anything useful.
- Assert what the code should do, not what it does. An assertion written from the current
  behaviour passes forever and catches nothing — twice in this project a test was "fixed" to
  match a bug.
