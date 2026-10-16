# The portal's typefaces

Two families, latin only, 77 KB for all three files. They are served by
`server/index.js` from `/fonts/`, and `src/Stylesheet.html` names each file there
first and Google's copy second.

| file | family | weights | bytes |
|---|---|---|---|
| `inter-latin-var.woff2` | Inter | 400–700 variable | 48,256 |
| `plexmono-latin-400.woff2` | IBM Plex Mono | 400 | 14,708 |
| `plexmono-latin-600.woff2` | IBM Plex Mono | 600 | 15,620 |

## Why they are in the repository

The stylesheet used to `@import` three families from `fonts.googleapis.com`. An
`@import` inside a `<style>` block is the slowest way there is to load a webfont:
the browser fetches the page, parses the style, fetches a stylesheet from Google,
and only then fetches the font — three serial round trips to a third party before
a heading can be drawn, on a system that is being rebuilt because it felt slow.

Serving them from the portal's own origin removes the third party from the
critical path, and removes a dependency on a service PIE does not control.

## The second source

Each `@font-face` lists the local file first and the Google URL second. Apps
Script cannot serve a file, so on the old portal the first URL 404s and the
browser falls through to the second — which is exactly what it does today. That
keeps the live system looking the same for as long as the cutover takes. Once
Apps Script is retired the second source can go.

The Google URLs name a font version (`v20`). If Google rotates it the URL will
404, and the browser falls back to the system stack named in `--font-sans` /
`--font-mono` — Segoe UI and Consolas on the Windows machines PIE uses. Nothing
breaks; it only looks different on the old portal.

## Subsetting

Latin only. The latin-ext subsets cover Central European diacritics and cost
another ~120 KB; nothing PIE quotes, invoices or dispatches needs them. The
`unicode-range` in the stylesheet matches what these files actually contain, so a
character outside it falls back rather than rendering as a blank box.

## Licence

Both families are under the SIL Open Font License 1.1, which permits
redistribution, including bundled with an application.

- Inter — Rasmus Andersson — https://github.com/rsms/inter
- IBM Plex Mono — IBM — https://github.com/IBM/plex

## Replacing one

Fetch the `latin` subset from the Google CSS API with a browser User-Agent (it
serves `.ttf` to anything it does not recognise), save it here, and update both
the filename and the `unicode-range` in `src/Stylesheet.html`. `tests/server-test.js`
checks every face the stylesheet names is reachable and really is a woff2;
`tests/browser-server-test.js` checks the browser actually used them rather than
falling back to something with the same name.
