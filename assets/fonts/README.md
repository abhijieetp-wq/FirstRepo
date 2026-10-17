# The portal's typefaces

Three families, latin only, 104 KB for all four files, served by `server/index.js` from
`/fonts/` with a one-year immutable cache. They are used by the new design
(`web/Stylesheet.html`), which only the Node server serves.

| file | family | weights | bytes | used for |
|---|---|---|---|---|
| `inter-latin-var.woff2` | Inter | 400–700 variable | 48,256 | reading text, tables, figures in tables |
| `jakarta-latin-var.woff2` | Plus Jakarta Sans | 500–800 variable | 27,348 | headings, headline numbers, the brand |
| `plexmono-latin-400.woff2` | IBM Plex Mono | 400 | 14,708 | part and document numbers |
| `plexmono-latin-600.woff2` | IBM Plex Mono | 600 | 15,620 | the same, emphasised |

## Why they are here and not fetched from Google

The classic stylesheet (`src/Stylesheet.html`, which Apps Script serves) `@import`s its
fonts from `fonts.googleapis.com`. An `@import` inside a `<style>` block is the slowest way
there is to load a webfont: the browser fetches the page, parses the style, fetches a
stylesheet from Google, and only then fetches the font — serial round trips to a third
party before a heading can be drawn. The new design names only these files, so the Node
portal never leaves its own origin. `tests/browser-server-test.js` checks exactly that.

The classic stylesheet is left alone: Apps Script cannot serve a file, and it stays as it
is until the cutover.

## Subsetting

Latin only. The latin-ext subsets cover Central European diacritics and cost far more
than they are worth here. The rupee sign (U+20B9) is outside every latin subset, so it
comes from the system font — Segoe UI on the Windows machines PIE uses, which has it.

## Licence

All three families are under the SIL Open Font License 1.1, which permits
redistribution, including bundled with an application.

- Inter — Rasmus Andersson — https://github.com/rsms/inter
- Plus Jakarta Sans — Tokotype — https://github.com/tokotype/PlusJakartaSans
- IBM Plex Mono — IBM — https://github.com/IBM/plex

## Replacing one

Fetch the `latin` subset from the Google CSS API with a browser User-Agent (it serves
`.ttf` to anything it does not recognise), save it here, and update the filename in
`web/Stylesheet.html`. `tests/server-test.js` checks the files are served;
`tests/browser-server-test.js` checks the browser actually used them rather than falling
back to something with the same name.
