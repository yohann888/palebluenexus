#!/usr/bin/env node
/**
 * Pale Blue Nexus — content auto-updater.
 *
 * Pulls the latest YouTube videos (@palebluenexus) and TikTok clips
 * (@palebluenexus) via the EnsembleData API, normalizes them into
 * data/feed.json with a cross-platform performance score, then regenerates:
 *   - the "Latest Drops" + "Top Performing" homepage sections (index.html)
 *   - the "Guests" showcase section (index.html)
 *   - per-guest branded promo share pages (share/guest/<slug>.html)
 *
 * It only rewrites content between HTML markers, so hand-written copy elsewhere
 * is never touched. Run on a schedule (GitHub Action); the commit it produces
 * triggers the existing Cloudflare Pages deploy.
 *
 * Required env: ENSEMBLE_API_KEY
 * Usage: node scripts/update-feed.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const ED_TOKEN = process.env.ENSEMBLE_API_KEY;
const ED_BASE = "https://ensembledata.com/apis";
const YT_CHANNEL_ID = "UCl4ECGuuMtmVdvtZr7duAIw"; // youtube.com/@palebluenexus
const TT_USERNAME = "palebluenexus";

const LATEST_COUNT = 6;
const TOP_COUNT = 6;

const log = (...a) => console.log("[update-feed]", ...a);

/* ---------------------------------------------------------------- helpers */

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtViews(n) {
  if (n == null) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

// "1.2M views" / "22K views" / "1,234" / "6 views" / "No views" -> number
function parseCount(text) {
  if (!text) return 0;
  const m = String(text).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  const unit = (m[2] || "").toUpperCase();
  if (unit === "K") n *= 1e3;
  else if (unit === "M") n *= 1e6;
  else if (unit === "B") n *= 1e9;
  return Math.round(n);
}

// "4 days ago" / "Streamed 2 weeks ago" / "1 month ago" -> approx Date
function parseRelativeDate(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+)\s+(second|minute|hour|day|week|month|year)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unitDays = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
  const days = n * (unitDays[m[2].toLowerCase()] || 1);
  return new Date(Date.now() - days * 86400 * 1000);
}

function ageDays(date) {
  if (!date) return 9999;
  return Math.max(0.25, (Date.now() - new Date(date).getTime()) / (86400 * 1000));
}

// views/day with a light engagement boost; comparable across platforms
function performanceScore({ views, likes = 0, comments = 0, publishedAt }) {
  const perDay = views / ageDays(publishedAt);
  const engagement = views > 0 ? (likes + comments) / views : 0;
  return perDay * (1 + Math.min(engagement, 0.5));
}

async function edFetch(path, params) {
  const url = new URL(ED_BASE + path);
  url.search = new URLSearchParams({ ...params, token: ED_TOKEN }).toString();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.detail) throw new Error(`${path} -> ${JSON.stringify(json.detail)}`);
  return json;
}

/* ---------------------------------------------------------------- sources */

async function fetchYouTube() {
  const json = await edFetch("/youtube/channel/videos", { browseId: YT_CHANNEL_ID, depth: 1 });
  const vids = json?.data?.videos || [];
  const items = [];
  for (const v of vids) {
    const r = v?.richItemRenderer?.content?.videoRenderer;
    if (!r?.videoId) continue;
    const views = parseCount(r?.viewCountText?.simpleText || r?.shortViewCountText?.simpleText);
    const publishedAt = parseRelativeDate(r?.publishedTimeText?.simpleText);
    const lengthLabel = r?.lengthText?.simpleText || "";
    const [mm, ss] = lengthLabel.split(":").map(Number);
    const seconds = lengthLabel.split(":").length === 3 ? 9999 : (mm || 0) * 60 + (ss || 0);
    const type = seconds > 0 && seconds <= 75 ? "clip" : "video";
    items.push({
      id: r.videoId,
      platform: "youtube",
      type,
      title: r?.title?.runs?.[0]?.text || "",
      url: `https://www.youtube.com/watch?v=${r.videoId}`,
      thumb: `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`,
      duration: lengthLabel,
      publishedAt: publishedAt ? publishedAt.toISOString() : null,
      views,
      likes: 0,
      comments: 0,
    });
  }
  return items;
}

async function fetchTikTok(imagesDir) {
  const json = await edFetch("/tt/user/posts", { username: TT_USERNAME, depth: 1, oldest_createtime: 0 });
  const posts = json?.data || [];
  const items = [];
  for (const p of posts) {
    if (!p?.aweme_id) continue;
    const st = p.statistics || {};
    const coverUrl = p?.video?.cover?.url_list?.[0] || p?.video?.origin_cover?.url_list?.[0];
    const local = `images/feed/tt-${p.aweme_id}.jpg`;
    const localPath = join(imagesDir, `tt-${p.aweme_id}.jpg`);
    let thumb = existsSync(localPath) ? local : "";
    if (!thumb && coverUrl) {
      try {
        const res = await fetch(coverUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          writeFileSync(localPath, buf);
          thumb = local;
        }
      } catch (e) {
        log("tiktok thumb download failed", p.aweme_id, e.message);
      }
    }
    items.push({
      id: String(p.aweme_id),
      platform: "tiktok",
      type: "clip",
      title: (p.desc || "").split("#")[0].trim() || "TikTok clip",
      url: p.share_url || `https://www.tiktok.com/@${TT_USERNAME}/video/${p.aweme_id}`,
      thumb,
      duration: "",
      publishedAt: p.create_time ? new Date(p.create_time * 1000).toISOString() : null,
      views: st.play_count || 0,
      likes: st.digg_count || 0,
      comments: st.comment_count || 0,
    });
  }
  return items;
}

// The channel hosts an audio-only re-upload alongside each real video episode
// (same title, near-identical duration, but almost no views). Keep only the
// real video: dedupe by normalized title, preferring the higher-viewed (then
// longer) upload. Full episodes and Shorts survive; audio-only twins drop out.
function normalizeTitle(t = "") {
  return String(t)
    .toLowerCase()
    .replace(/\s*\|\s*pbn\s*ep\s*\d+\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function durationSeconds(label = "") {
  const parts = String(label).split(":").map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function dedupeYouTube(items) {
  const byTitle = new Map();
  for (const it of items) {
    const key = normalizeTitle(it.title);
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, it);
      continue;
    }
    const better =
      (it.views || 0) !== (existing.views || 0)
        ? (it.views || 0) > (existing.views || 0)
        : durationSeconds(it.duration) > durationSeconds(existing.duration);
    if (better) byTitle.set(key, it);
  }
  return [...byTitle.values()];
}

/* ----------------------------------------------------------- html rendering */

const PLATFORM_LABEL = { youtube: "YouTube", tiktok: "TikTok" };

function cardHtml(item, { rank } = {}) {
  const metric = item.views ? `${fmtViews(item.views)} views` : (item.duration || "");
  const badge = PLATFORM_LABEL[item.platform] || item.platform;
  const rankHtml = rank ? `<span class="feed-rank">#${rank}</span>` : "";
  const thumb = item.thumb || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
  const portrait = item.platform === "tiktok";
  const thumbInner = portrait
    ? `<span class="feed-thumb-bg" style="background-image:url('${esc(thumb)}')"></span>
            <img class="feed-thumb-portrait" src="${esc(thumb)}" alt="${esc(item.title)}" loading="lazy" />`
    : `<img src="${esc(thumb)}" alt="${esc(item.title)}" loading="lazy" />`;
  return `        <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" class="feed-card fade-up">
          <div class="feed-thumb${portrait ? " feed-thumb-vertical" : ""}">
            ${thumbInner}
            ${rankHtml}
            <span class="feed-badge feed-badge-${item.platform}">${badge}</span>
          </div>
          <p class="feed-title">${esc(item.title)}</p>
          <p class="feed-meta">${esc(metric)}</p>
        </a>`;
}

function latestDropsHtml(items) {
  const withDate = items.filter((i) => i.publishedAt);
  const latest = [...(withDate.length ? withDate : items)]
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, LATEST_COUNT);

  return `
  <!-- ════════ LATEST DROPS (auto-generated) ════════ -->
  <section class="feed-section" id="latest-drops">
    <div class="section-container">
      <div class="fade-up" style="text-align:center;max-width:680px;margin:0 auto;">
        <span class="section-eyebrow">Latest Drops</span>
        <h2 class="section-heading">Fresh from the feed.</h2>
        <p class="section-subheading">New videos and clips from YouTube and TikTok, updated automatically.</p>
      </div>
      <div class="feed-grid">
${latest.map((i) => cardHtml(i)).join("\n")}
      </div>
    </div>
  </section>
`;
}

function topPerformingHtml(items) {
  const top = [...items].sort((a, b) => b.score - a.score).slice(0, TOP_COUNT);

  return `
  <!-- ════════ TOP PERFORMING (auto-generated) ════════ -->
  <section class="feed-section feed-section-top" id="top-performing">
    <div class="section-container">
      <div class="fade-up" style="text-align:center;max-width:680px;margin:0 auto;">
        <span class="section-eyebrow">Top Performing</span>
        <h2 class="section-heading">The clips that travelled.</h2>
        <p class="section-subheading">Ranked by reach over time across platforms. The moments resonating most right now.</p>
      </div>
      <div class="feed-grid">
${top.map((i, idx) => cardHtml(i, { rank: idx + 1 })).join("\n")}
      </div>
    </div>
  </section>
`;
}

function guestCardHtml(g, item) {
  const isPub = g.status === "published";
  const href = isPub && g.episodeSlug ? `/episodes/${g.episodeSlug}/` : (g.linkedin || g.website || "#");
  const ext = !(isPub && g.episodeSlug);
  const views = item && item.views ? `&middot; ${fmtViews(item.views)} views` : "";
  const tag = isPub ? `${esc(g.episode)} ${views}` : esc(g.episode);
  return `        <a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""} class="guest-show-card fade-up">
          <div class="guest-show-photo"><img src="${esc(g.photo)}" alt="${esc(g.name)}" loading="lazy" /></div>
          <div class="guest-show-body">
            <span class="guest-show-tag">${tag}</span>
            <p class="guest-show-name">${esc(g.name)}</p>
            <p class="guest-show-role">${esc(g.role)}</p>
            ${g.quote ? `<p class="guest-show-quote">&ldquo;${esc(g.quote)}&rdquo;</p>` : ""}
            <span class="guest-show-promo">Promo kit &rarr;</span>
          </div>
        </a>`;
}

function guestsSectionHtml(guests, byGuest) {
  const published = guests.filter((g) => g.status === "published");
  const upcoming = guests.filter((g) => g.status !== "published");
  const ordered = [...published, ...upcoming];
  return `
  <!-- ════════ GUESTS SHOWCASE (auto-generated) ════════ -->
  <section class="guests-showcase" id="guests">
    <div class="section-container">
      <div class="fade-up" style="text-align:center;max-width:680px;margin:0 auto;">
        <span class="section-eyebrow">Guests</span>
        <h2 class="section-heading">The operators at the mic.</h2>
        <p class="section-subheading">Founders, investors, and operators at the frontier of AI, space, and emerging tech. Each guest has a ready-to-share promo kit.</p>
      </div>
      <div class="guests-show-grid">
${ordered.map((g) => guestCardHtml(g, byGuest[g.slug])).join("\n")}
      </div>
    </div>
  </section>
`;
}

/* --------------------------------------------------- per-guest promo pages */

function promoSvg(g) {
  const wrap = (txt, max) => {
    const words = String(txt).split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > max) {
        lines.push(line.trim());
        line = w;
      } else line = (line + " " + w).trim();
    }
    if (line) lines.push(line.trim());
    return lines.slice(0, 4);
  };
  const quoteLines = g.quote ? wrap(`\u201C${g.quote}\u201D`, 34) : wrap(g.bio, 40);
  const quoteTspans = quoteLines
    .map((l, i) => `<tspan x="600" dy="${i === 0 ? 0 : 58}">${esc(l)}</tspan>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
<rect width="1200" height="630" fill="#04060e"/>
<rect x="40" y="40" width="1120" height="550" rx="16" fill="none" stroke="#D4A84B" stroke-width="1" stroke-opacity="0.35"/>
<text x="600" y="120" font-family="Inter,Arial,sans-serif" font-size="20" letter-spacing="4" fill="#7EB8DA" text-anchor="middle">PALE BLUE NEXUS</text>
<text x="600" y="280" font-family="Georgia,serif" font-size="44" font-style="italic" fill="#ffffff" text-anchor="middle">${quoteTspans}</text>
<text x="600" y="480" font-family="Montserrat,Arial,sans-serif" font-size="30" fill="#D4A84B" text-anchor="middle">${esc(g.name)}</text>
<text x="600" y="520" font-family="Inter,Arial,sans-serif" font-size="20" fill="#A6D2E6" text-anchor="middle">${esc(g.role)}</text>
<text x="600" y="565" font-family="Inter,Arial,sans-serif" font-size="18" fill="#7EB8DA" text-anchor="middle">palebluenexus.com</text>
</svg>`;
  return svg;
}

function promoPageHtml(g, item) {
  const ogImg = "data:image/svg+xml," + encodeURIComponent(promoSvg(g));
  const ogUrl = `https://palebluenexus.com/images/promo/${g.slug}.svg`;
  const isPub = g.status === "published";
  const epUrl = isPub && g.episodeSlug ? `https://palebluenexus.com/episodes/${g.episodeSlug}/` : "https://palebluenexus.com/";
  const watchUrl = item ? item.url : (g.youtubeId ? `https://www.youtube.com/watch?v=${g.youtubeId}` : epUrl);
  const embed = g.youtubeId
    ? `<div class="promo-embed"><iframe src="https://www.youtube.com/embed/${esc(g.youtubeId)}" title="${esc(g.name)} on Pale Blue Nexus" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;web-share" allowfullscreen loading="lazy"></iframe></div>`
    : "";
  const viewsLine = item && item.views ? `${fmtViews(item.views)} views and counting` : "";
  const caption = isPub
    ? `Honored to be on the Pale Blue Nexus podcast with Yohann Calpu. A conversation on AI, building, and what comes next. Watch the full episode: ${epUrl}`
    : `Excited to be joining Yohann Calpu on the Pale Blue Nexus podcast soon. Stay tuned: https://palebluenexus.com/`;
  const title = `${g.name} - Pale Blue Nexus`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(g.name)}, ${esc(g.role)}. On the Pale Blue Nexus podcast. Share kit and promo card." />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(g.quote || g.bio)}" />
  <meta property="og:image" content="${ogUrl}" />
  <meta property="og:url" content="https://palebluenexus.com/share/guest/${esc(g.slug)}.html" />
  <meta property="og:type" content="article" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${ogUrl}" />
  <link rel="canonical" href="https://palebluenexus.com/share/guest/${esc(g.slug)}.html" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,400;1,500&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
  <link rel="icon" type="image/png" href="../../images/favicon.png" />
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
    :root{--bg-deep:#04060e;--accent-warm:#D4A84B;--accent-blue:#7EB8DA;--text-2:#A6D2E6;--border:rgba(255,255,255,0.08);}
    body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg-deep);color:#fff;min-height:100vh;padding:2.5rem 1.25rem;}
    .promo-wrap{max-width:720px;margin:0 auto;}
    .promo-eyebrow{font-size:.78rem;letter-spacing:.22em;text-transform:uppercase;color:var(--accent-blue);text-align:center;}
    .promo-photo{width:120px;height:120px;border-radius:50%;object-fit:cover;border:2px solid var(--accent-warm);display:block;margin:1.5rem auto 1rem;}
    h1{font-family:'Cormorant Garamond',Georgia,serif;font-size:2.4rem;text-align:center;font-weight:600;}
    .promo-role{text-align:center;color:var(--text-2);margin-top:.35rem;}
    .promo-quote{font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:1.5rem;text-align:center;color:#fff;margin:1.75rem auto;max-width:560px;line-height:1.4;}
    .promo-views{text-align:center;color:var(--accent-warm);font-size:.9rem;letter-spacing:.05em;margin-bottom:1.5rem;}
    .promo-embed{position:relative;padding-bottom:56.25%;height:0;border-radius:12px;overflow:hidden;border:1px solid var(--border);margin:1.5rem 0;}
    .promo-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}
    .promo-card-img{width:100%;border-radius:12px;border:1px solid var(--border);display:block;margin:1.5rem 0 .75rem;}
    .promo-actions{display:flex;gap:.75rem;flex-wrap:wrap;justify-content:center;margin:1.25rem 0;}
    .promo-btn{appearance:none;cursor:pointer;border:1px solid var(--accent-warm);background:transparent;color:var(--accent-warm);font-family:'Inter',sans-serif;font-size:.85rem;font-weight:500;letter-spacing:.04em;padding:.7rem 1.2rem;border-radius:999px;text-decoration:none;transition:background .2s,color .2s;}
    .promo-btn:hover{background:var(--accent-warm);color:#04060e;}
    .promo-btn-primary{background:var(--accent-warm);color:#04060e;}
    .promo-caption{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;padding:1rem 1.1rem;color:var(--text-2);font-size:.92rem;line-height:1.55;margin-top:1rem;}
    .promo-foot{text-align:center;color:rgba(166,210,230,.6);font-size:.8rem;margin-top:2rem;}
    .promo-foot a{color:var(--accent-blue);}
  </style>
</head>
<body>
  <div class="promo-wrap">
    <p class="promo-eyebrow">As seen on Pale Blue Nexus</p>
    <img class="promo-photo" src="../../${esc(g.photo)}" alt="${esc(g.name)}" />
    <h1>${esc(g.name)}</h1>
    <p class="promo-role">${esc(g.role)}</p>
    ${g.quote ? `<p class="promo-quote">&ldquo;${esc(g.quote)}&rdquo;</p>` : `<p class="promo-quote">${esc(g.bio)}</p>`}
    ${viewsLine ? `<p class="promo-views">${esc(viewsLine)}</p>` : ""}
    ${embed}
    <img class="promo-card-img" id="promo-card" src="${ogImg}" alt="${esc(g.name)} promo card" crossorigin="anonymous" />
    <div class="promo-actions">
      <a class="promo-btn promo-btn-primary" href="${esc(watchUrl)}" target="_blank" rel="noopener noreferrer">${isPub ? "Watch the episode" : "Visit the show"}</a>
      <button class="promo-btn" id="dl-card">Download promo card</button>
      <button class="promo-btn" id="copy-caption">Copy caption</button>
    </div>
    <div class="promo-caption" id="caption-text">${esc(caption)}</div>
    <p class="promo-foot"><a href="/">Pale Blue Nexus</a> &middot; Making sense of the future, from right here.</p>
  </div>
  <script>
    document.getElementById('dl-card').addEventListener('click', function(){
      var img = document.getElementById('promo-card');
      var c = document.createElement('canvas');
      c.width = 1200; c.height = 630;
      var ctx = c.getContext('2d');
      var i = new Image(); i.crossOrigin = 'anonymous';
      i.onload = function(){
        ctx.drawImage(i,0,0,1200,630);
        try {
          var a = document.createElement('a');
          a.download = '${esc(g.slug)}-pbn-promo.png';
          a.href = c.toDataURL('image/png');
          a.click();
        } catch(e){ window.open(img.src,'_blank'); }
      };
      i.onerror = function(){ window.open(img.src,'_blank'); };
      i.src = img.src;
    });
    document.getElementById('copy-caption').addEventListener('click', function(){
      var t = document.getElementById('caption-text').innerText;
      navigator.clipboard.writeText(t).then(function(){
        var b = document.getElementById('copy-caption');
        var o = b.innerText; b.innerText = 'Copied!';
        setTimeout(function(){ b.innerText = o; }, 1600);
      });
    });
  </script>
</body>
</html>
`;
}

/* --------------------------------------------------------------- injection */

function injectBetween(html, marker, replacement) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  const block = `${start}${replacement}\n  ${end}`;
  if (!re.test(html)) throw new Error(`marker ${marker} not found in index.html`);
  return html.replace(re, () => block);
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (!ED_TOKEN) throw new Error("ENSEMBLE_API_KEY is not set");

  const guestsCfg = JSON.parse(readFileSync(join(ROOT, "data/guests.json"), "utf8"));
  const guests = guestsCfg.guests;

  const imagesDir = join(ROOT, "images/feed");
  mkdirSync(imagesDir, { recursive: true });
  writeFileSync(join(imagesDir, ".gitkeep"), "");

  let yt = [];
  let tt = [];
  try {
    yt = await fetchYouTube();
    const beforeDedupe = yt.length;
    yt = dedupeYouTube(yt);
    log(`youtube: ${yt.length} videos (deduped from ${beforeDedupe}, dropped audio-only re-uploads)`);
  } catch (e) {
    log("youtube fetch failed:", e.message);
  }
  try {
    tt = await fetchTikTok(imagesDir);
    log(`tiktok: ${tt.length} clips`);
  } catch (e) {
    log("tiktok fetch failed:", e.message);
  }

  let items = [...yt, ...tt];
  if (!items.length) throw new Error("no items fetched from any platform; aborting without rewriting");

  // map youtube + tiktok posts -> guests; compute scores
  const ytIdToGuest = {};
  const ttIdToGuest = {};
  for (const g of guests) {
    if (g.youtubeId) ytIdToGuest[g.youtubeId] = g.slug;
    for (const id of g.tiktokIds || []) ttIdToGuest[String(id)] = g.slug;
  }
  for (const it of items) {
    it.guestSlug = (it.platform === "youtube" ? ytIdToGuest[it.id] : ttIdToGuest[it.id]) || null;
    it.score = Math.round(performanceScore(it));
  }
  items.sort((a, b) => b.score - a.score);

  // best-performing item per guest (their episode video if present)
  const byGuest = {};
  for (const g of guests) {
    const own = items.filter((i) => i.guestSlug === g.slug).sort((a, b) => b.score - a.score);
    if (own[0]) byGuest[g.slug] = own[0];
    else if (g.youtubeId) byGuest[g.slug] = items.find((i) => i.id === g.youtubeId) || null;
  }

  // write feed.json
  const feed = {
    generatedAt: new Date().toISOString(),
    source: { youtube: `@${"palebluenexus"}`, tiktok: `@${TT_USERNAME}` },
    count: items.length,
    items,
  };
  writeFileSync(join(ROOT, "data/feed.json"), JSON.stringify(feed, null, 2) + "\n");
  log(`wrote data/feed.json (${items.length} items)`);

  // inject homepage sections
  let html = readFileSync(join(ROOT, "index.html"), "utf8");
  html = injectBetween(html, "AUTO-LATEST", latestDropsHtml(items));
  html = injectBetween(html, "AUTO-TOP", topPerformingHtml(items));
  html = injectBetween(html, "AUTO-GUESTS", guestsSectionHtml(guests, byGuest));
  writeFileSync(join(ROOT, "index.html"), html);
  log("updated index.html sections");

  // per-guest promo og:image cards (hosted SVG, fetchable by social crawlers)
  const promoImgDir = join(ROOT, "images/promo");
  mkdirSync(promoImgDir, { recursive: true });
  for (const g of guests) {
    writeFileSync(join(promoImgDir, `${g.slug}.svg`), promoSvg(g));
  }

  // per-guest promo pages
  const promoDir = join(ROOT, "share/guest");
  mkdirSync(promoDir, { recursive: true });
  for (const g of guests) {
    writeFileSync(join(promoDir, `${g.slug}.html`), promoPageHtml(g, byGuest[g.slug]));
  }
  log(`wrote ${guests.length} promo pages to share/guest/`);
}

main().catch((e) => {
  console.error("[update-feed] FAILED:", e.message);
  process.exit(1);
});
