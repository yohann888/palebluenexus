---
name: testing-guests-and-episodes
description: Test the /guests/ directory (search box + field selector + infinite scroll) and episode promo-kit pages (breadcrumb, SRT/TXT/Word transcript downloads, stats, key moments, clips) on Pale Blue Nexus. Use when verifying UI changes to guests/index.html, episodes/*/index.html, or scripts/update-feed.mjs.
---

# Testing the guests directory & episode promo-kit pages

Pale Blue Nexus is a static site on Cloudflare Pages. All these features are frontend/static — **no login or secrets needed**. Test against the live deploy at https://palebluenexus.com once merged to `main` (Cloudflare rebuilds automatically), or serve locally with `python3 -m http.server` from the repo root.

## What is generated vs static
- `guests/index.html` is a real page; the guest cards' JSON is injected by `scripts/update-feed.mjs` between `<!-- AUTO-GUESTS-DATA:start -->` / `end` markers. The search/scroll JS is static in the file.
- Episode pages (`episodes/<slug>/index.html`) are mostly static; only the `AUTO-EP-KIT` block (stats, channel links, transcript row, key moments, clips) is injected by the updater. The breadcrumb is in the static hero, so editing it requires touching each page + the `newEpisodePageHtml` template.
- Transcript derivatives live in `transcripts/<slug>.{en.srt,txt,docx}`. `writeTranscriptDerivatives()` only writes `.txt`/`.docx` when missing — to regenerate after changing paragraphing logic you must delete the existing files first, then run `node scripts/update-feed.mjs`.

## Guests directory checks
- Grid renders cards (photo, name, role, `Episode NN · <N> views & listens`, `Promo kit →`).
- Infinite scroll: initial batch is **12** cards; scrolling loads the rest. With 13 public guests, the 13th (highest episode number) only appears after a scroll — good proof the batching works. A `fill()` loop keeps rendering while the `#guest-sentinel` stays in view (fixes a stall on tall viewports / few results).
- Search box + `#guest-field` selector (All / First name / Last name / Company). Verify each field scopes correctly: e.g. Last name "rogers" → only Jim Rogers; Company "markup" → only the guest whose website hostname contains markup. A non-matching query shows `No guests match your search.`
- The native `<select>` dropdown can render oddly in the test browser; selecting options via keyboard (click select, arrow keys, Enter) is more reliable than clicking the rendered option.

## Episode promo-kit checks
- Breadcrumb `Guests / <name>` must sit **in the hero above the episode eyebrow**, NOT pinned over the logo. It's a `<div role="navigation" class="ep-breadcrumb">` (was a `<nav>`, which inherited the header's `nav{position:fixed}` rule and overlapped the logo — regression to watch for). Clicking `Guests` should navigate to `/guests/`.
- Transcript row: `Download transcript` label + `SRT` / `TXT` / `Word` anchors with the `download` attribute. Because of `download`, clicking triggers a download; to view content in-browser navigate directly to `…/transcripts/<slug>.txt`.
- Transcript readability: the `.txt` should be a title + multiple readable paragraphs, never one giant blob. `transcriptParagraphs()` splits on `>>` speaker markers AND sentence-groups any chunk over ~600 chars, so sparse-marker transcripts (few `>>`) still break up. Quick check: `curl -s <txt-url> | wc -l` and inspect the longest line length.

## Devin Secrets Needed
None for runtime UI testing. (The scheduled updater itself uses `SUPADATA_API_KEY`, `ANTHROPIC_API_KEY`, `ENSEMBLE_API_KEY` as GitHub Actions secrets, but these are not required to test the rendered pages.)
