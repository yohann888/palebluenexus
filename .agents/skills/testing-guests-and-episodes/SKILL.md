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
- Chrome downloads land in `~/Downloads`; after clicking SRT/TXT/Word verify sanity there (SRT has `00:00:03,274 --> ...` timecodes, TXT starts with the episode title, `.docx` is a valid zip — `python3 -c "import zipfile;print(zipfile.ZipFile('x.docx').namelist())"`).
- Key moments: each row is an anchor to `youtube.com/watch?v=<episode id>&t=<seconds>`; check the seconds match the displayed `M:SS` and the opened video title matches the guest's episode (YouTube may show a bot/consent interstitial — the URL + title are enough).

## Clip attribution checks (clips grid on promo kits)
- Clip→guest mapping comes from the layered classifier in `scripts/update-feed.mjs` (curated `tiktokIds` / full-name caption → unique first-or-last name + corroboration → YouTube ID or @mention → BM25 transcript relevance → cached high-confidence Claude only). Ground-truth expected counts per guest quickly with:
  `python3 -c "import json,collections;d=json.load(open('data/feed.json'));print(collections.Counter(i['guestSlug'] for i in d['items'] if i['platform']=='tiktok'))"`
- The rendered hero reach stat = sum of views of ALL items owned by the guest (incl. attributed TikToks) + podcast listens, so attributing clips changes that number; compare against `git show main:episodes/<slug>/index.html` to prove the delta.
- Highest-value check is plausibility, not counts: read each caption and the thumbnail face. Some clips are host-narrated (host's face, caption names the guest) — that is still correct. Corroborate a doubtful attribution with `grep -lio <distinctive term> transcripts/*.txt`; if only that guest's transcript contains it, the attribution is right.
- `data/attribution-cache.json` may hold medium-confidence Claude guesses that are deliberately ignored; a mismatch between the cache and `feed.json` is not a bug.
- Beware topic-overlapping guests (two investors, two neuro guests) — those are where misattribution would show up.

## Viewport testing
- Chrome on this box refuses to shrink below ~532px window width, so a true 390px viewport is not reachable by resizing. Workaround: shrink the window (`wmctrl -r :ACTIVE: -b remove,maximized_vert,maximized_horz; xdotool getactivewindow windowsize 400 1150`) then apply page zoom (`ctrl+equal`, note plain `ctrl+plus` may not register) and confirm the effective width with `window.innerWidth` — 125% zoom yields ~400 CSS px, close enough for the mobile single-column check. Re-maximize with `wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz` and `ctrl+0` afterwards.

## Devin Secrets Needed
None for runtime UI testing. (The scheduled updater itself uses `SUPADATA_API_KEY`, `ANTHROPIC_API_KEY`, `ENSEMBLE_API_KEY` as GitHub Actions secrets, but these are not required to test the rendered pages.)
