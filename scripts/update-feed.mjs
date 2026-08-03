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

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const ED_TOKEN = process.env.ENSEMBLE_API_KEY;
const ED_BASE = "https://ensembledata.com/apis";
const YT_CHANNEL_ID = "UCl4ECGuuMtmVdvtZr7duAIw"; // youtube.com/@palebluenexus
const TT_USERNAME = "palebluenexus";

const LATEST_COUNT = 6;
const TOP_COUNT = 10;
const SHOW_LINKS = {
  youtube: "https://www.youtube.com/@palebluenexus",
  apple: "https://podcasts.apple.com/ca/podcast/pale-blue-nexus/id1529530113",
  spotify: "https://open.spotify.com/show/6xY4m0p3646gZGMCb33Z3d",
  tiktok: "https://www.tiktok.com/@palebluenexus",
};

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
      descSnippet: r?.descriptionSnippet?.runs?.map((run) => run.text).join("") || "",
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

let imageMagickCommand;

function resolveImageMagick() {
  if (imageMagickCommand !== undefined) return imageMagickCommand;
  try {
    execFileSync("convert", ["-version"], { stdio: "ignore" });
    imageMagickCommand = { command: "convert", prefix: [] };
  } catch {
    try {
      execFileSync("magick", ["-version"], { stdio: "ignore" });
      imageMagickCommand = { command: "magick", prefix: ["convert"] };
    } catch {
      imageMagickCommand = null;
      log("warning: ImageMagick unavailable; audio-only filtering is disabled");
    }
  }
  return imageMagickCommand;
}

async function isAudioOnlyThumb(id) {
  const imageMagick = resolveImageMagick();
  if (!imageMagick) return false;

  const tempPath = join(tmpdir(), `pbn-thumb-${id}.jpg`);
  try {
    const res = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    if (!res.ok) return false;
    writeFileSync(tempPath, Buffer.from(await res.arrayBuffer()));
    const measure = (gravity) => {
      const args = [
        ...imageMagick.prefix,
        tempPath,
        "-gravity",
        gravity,
        "-crop",
        "6%x60%+0+0",
        "+repage",
        "-colorspace",
        "Gray",
        "-format",
        "%[fx:mean]",
        "info:",
      ];
      return parseFloat(execFileSync(imageMagick.command, args, { encoding: "utf8" }).trim());
    };
    const left = measure("West");
    const right = measure("East");
    return left < 0.02 && right < 0.02;
  } catch (e) {
    log("audio-only thumbnail check failed", id, e.message);
    return false;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup; the thumbnail check remains fail-open.
    }
  }
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

function podcastKey(t = "") {
  return String(t).toLowerCase().split("|")[0].replace(/[^a-z0-9]+/g, " ").trim();
}

function guestNameKey(name = "") {
  const stripped = String(name)
    .replace(/^\s*(?:dr|mr|mrs|ms|prof)\.?\s+/i, "")
    .replace(/\s*,\s*(?:phd|cfa|md|jd|esq|mba)\s*$/i, "")
    .trim();
  const tokens = stripped.split(/\s+/).filter(Boolean);
  return tokens.length >= 2 ? `${tokens[0]} ${tokens.at(-1)}` : "";
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

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function looksLikePersonName(value) {
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 5 &&
    words.slice(0, 2).every((word) => /^[A-Z][A-Za-z.'’-]*$/.test(word));
}

function parseDraftGuestName(title) {
  const pipeParts = String(title).split(/\s*\|\s*/);
  const pipeCandidate = pipeParts.length > 1
    ? pipeParts.at(-1).replace(/\s*,.*$/, "").replace(/\s*PBN\s*EP\s*\d+.*$/i, "").trim()
    : "";
  if (looksLikePersonName(pipeCandidate)) return pipeCandidate;

  const withMatch = String(title).match(/\bwith\s+([A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){1,4})/);
  const withCandidate = withMatch ? withMatch[1].replace(/\s*,.*$/, "").trim() : "";
  return looksLikePersonName(withCandidate) ? withCandidate : "";
}

function parseSnippetGuestName(snippet) {
  const match = String(snippet || "").match(/^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z.'’-]+){1,2})\s*,/);
  const candidate = match ? match[1].trim() : "";
  return looksLikePersonName(candidate) ? candidate : "";
}

function parseGuestRole(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  const patterns = [
    /\b(Co-founder\s*&\s*CEO|Founder\s+and\s+CEO|Managing Partner|General Partner|CEO|CTO|COO|President|Founder)\s+(?:of|at)\s+([A-Z][^.!?;\n|]{1,70}?)(?=\s*(?:[,.;!?|]|$))/i,
    /\b(Co-founder\s*&\s*CEO|Founder\s+and\s+CEO|Managing Partner|General Partner|CEO|CTO|COO|President|Founder)\s*,\s*([A-Z][^.!?;\n|]{1,70}?)(?=\s*(?:[,.;!?|]|$))/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const role = match[1].replace(/\s+/g, " ").trim();
    const company = match[2].replace(/\s+/g, " ").replace(/[,:;.!?]+$/, "").trim();
    if (!company) continue;
    const result = `${role}, ${company}`;
    if (result.length <= 60) return result;
    return `${result.slice(0, 60).replace(/\s+\S*$/, "").replace(/[,:;.!?]+$/, "")}`;
  }
  const roleOnly = source.match(/\b(Co-founder\s*&\s*CEO|Founder\s+and\s+CEO|Managing Partner|General Partner|CEO|CTO|COO|President|Founder)\s*[.!?]?\s*$/i);
  if (roleOnly) return roleOnly[1].replace(/\s+/g, " ").trim();
  const descriptor = source.match(/\b(?:legendary\s+)?(investor(?:\s+and\s+author)?|entrepreneur|author|scientist|executive)\b/i);
  return descriptor
    ? descriptor[1].replace(/\s+/g, " ").trim().replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\bAnd\b/g, "and")
    : "";
}

async function fetchGuestHeadshot(name, slug) {
  fetchGuestHeadshot.lastBio = "";
  const userAgent = "PaleBlueNexus/1.0 (https://palebluenexus.com)";
  const outputPath = join(ROOT, "images", `guest-${slug}.jpg`);
  const tempPath = join(tmpdir(), `pbn-headshot-${slug}-${Date.now()}`);
  let success = false;
  try {
    const summaryRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`,
      { headers: { "User-Agent": userAgent, accept: "application/json" } },
    );
    if (!summaryRes.ok) return null;
    const summary = await summaryRes.json();
    if (summary.type === "disambiguation") return null;
    if (String(summary.title || "").trim().toLowerCase() !== String(name).trim().toLowerCase()) return null;
    const sourceText = `${summary.extract || ""} ${summary.description || ""}`;
    if (!/\b(founder|co-?founder|ceo|cto|coo|president|investor|entrepreneur|author|executive|scientist|venture|chief|partner)\b/i.test(sourceText)) {
      return null;
    }
    const imageUrl = summary.originalimage?.source || summary.thumbnail?.source;
    if (!imageUrl) return null;
    let imageUrlObject;
    try {
      imageUrlObject = new URL(imageUrl);
    } catch {
      return null;
    }
    if (
      imageUrlObject.protocol !== "https:" ||
      !(imageUrlObject.hostname === "upload.wikimedia.org" || imageUrlObject.hostname.endsWith(".wikimedia.org"))
    ) {
      return null;
    }
    const imageRes = await fetch(imageUrl, { headers: { "User-Agent": userAgent } });
    if (!imageRes.ok || !String(imageRes.headers.get("content-type") || "").toLowerCase().startsWith("image/")) return null;
    const contentLength = Number(imageRes.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 5_000_000) return null;
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
    if (imageBuffer.length > 5_000_000) return null;
    writeFileSync(tempPath, imageBuffer);
    mkdirSync(join(ROOT, "images"), { recursive: true });
    const imageMagick = resolveImageMagick();
    if (imageMagick) {
      const convertArgs = [
        ...imageMagick.prefix,
        tempPath,
        "-auto-orient",
        "-strip",
        "-quality",
        "88",
        outputPath,
      ];
      execFileSync(imageMagick.command, convertArgs, { stdio: "ignore" });
      try {
        const identifyCommand = imageMagick.command === "magick" ? "magick" : "identify";
        const identifyArgs = imageMagick.command === "magick"
          ? ["identify", "-format", "%w %h", outputPath]
          : ["-format", "%w %h", outputPath];
        const [width, height] = execFileSync(identifyCommand, identifyArgs, { encoding: "utf8" })
          .trim()
          .split(/\s+/)
          .map(Number);
        if (!(width >= 200 && height >= 200)) return null;
      } catch (error) {
        if (error.code !== "ENOENT") return null;
      }
    } else {
      writeFileSync(outputPath, readFileSync(tempPath));
    }
    const extract = String(summary.extract || "").trim();
    fetchGuestHeadshot.lastBio = extract.split(/(?<=[.!?])\s+/)[0].slice(0, 240).trim();
    success = true;
    return `images/guest-${slug}.jpg`;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tempPath); } catch {}
    if (!success) {
      try { unlinkSync(outputPath); } catch {}
    }
  }
}

fetchGuestHeadshot.lastBio = "";

function nextEpisodeNumber(guests) {
  const maxEpisode = guests.reduce((max, guest) => {
    const number = parseInt(String(guest.episode || "").match(/\d+/)?.[0] || "0", 10);
    return Math.max(max, number);
  }, 0);
  return `Episode ${String(maxEpisode + 1).padStart(2, "0")}`;
}

function guestPlaceholderSvg(name) {
  const initials = String(name).trim().split(/\s+/).filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "PBN";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
<rect width="400" height="400" fill="#04060e"/>
<circle cx="200" cy="200" r="150" fill="none" stroke="#D4A84B" stroke-width="3" stroke-opacity=".75"/>
<text x="200" y="220" fill="#D4A84B" font-family="Inter,Arial,sans-serif" font-size="82" letter-spacing="6" text-anchor="middle">${esc(initials)}</text>
<text x="200" y="275" fill="#7EB8DA" font-family="Inter,Arial,sans-serif" font-size="16" letter-spacing="4" text-anchor="middle">PALE BLUE NEXUS</text>
</svg>
`;
}

async function syncUnrecognizedEpisodes(yt, guests, guestsCfg) {
  const knownIds = new Set(guests.map((guest) => guest.youtubeId).filter(Boolean));
  const knownSlugs = new Set(guests.map((guest) => guest.slug).filter(Boolean));
  const drafts = [];
  const published = [];
  for (const item of yt) {
    if (item.type !== "video" || knownIds.has(item.id)) continue;
    const name = parseDraftGuestName(item.title) || parseSnippetGuestName(item.descSnippet);
    const titleSlug = slugify(item.title).split("-").slice(0, 8).join("-");
    const baseSlug = name ? slugify(name) : `episode-${titleSlug || item.id}`;
    const slug = knownSlugs.has(baseSlug)
      ? `${baseSlug}-${String(item.id).slice(-6).toLowerCase()}`
      : baseSlug;
    knownSlugs.add(slug);
    const role = parseGuestRole(`${item.title} ${item.descSnippet || ""}`);
    const canPublish = Boolean(name && role);
    const photo = canPublish ? await fetchGuestHeadshot(name, slug) : null;
    if (canPublish) {
      const publicPhoto = photo || `images/guest-${slug}.svg`;
      if (!photo) {
        writeFileSync(join(ROOT, "images", `guest-${slug}.svg`), guestPlaceholderSvg(name));
      }
      const guest = {
        slug,
        name,
        role,
        photo: publicPhoto,
        linkedin: "",
        website: "",
        status: "published",
        episode: nextEpisodeNumber(guests),
        episodeSlug: slug,
        youtubeId: item.id,
        tiktokIds: [],
        quote: "",
        bio: fetchGuestHeadshot.lastBio || "",
        date: item.publishedAt ? item.publishedAt.slice(0, 10) : "",
        episodeTitle: item.title,
        duration: item.duration || "",
        ...(photo ? {} : { needsPhoto: true }),
      };
      guests.push(guest);
      mkdirSync(join(ROOT, "episodes", slug), { recursive: true });
      writeFileSync(join(ROOT, "episodes", slug, "index.html"), newEpisodePageHtml(guest));
      published.push(guest);
      log(`auto-published ${slug}${photo ? "" : " (monogram)"}`);
    } else {
      const guest = {
        slug,
        name,
        role: "",
        photo: `images/guest-${slug}.svg`,
        linkedin: "",
        website: "",
        status: "upcoming",
        episode: "Coming Soon",
        episodeSlug: "",
        youtubeId: item.id,
        tiktokIds: [],
        quote: "",
        bio: "",
        date: item.publishedAt ? item.publishedAt.slice(0, 10) : "",
        needsReview: true,
        needsPhoto: true,
      };
      guests.push(guest);
      drafts.push(guest);
    }
    knownIds.add(item.id);
  }
  if (!drafts.length && !published.length) return [];
  writeFileSync(join(ROOT, "data/guests.json"), JSON.stringify(guestsCfg, null, 2) + "\n");
  if (drafts.length) log(`added episode drafts: ${drafts.map((draft) => draft.slug).join(", ")}`);
  return [...drafts, ...published];
}

function newEpisodePageHtml(g) {
  const episodeTitle = String(g.episodeTitle || "").trim();
  const pageTitle = `${g.name} - Pale Blue Nexus ${g.episode}`;
  const description = `${episodeTitle}. ${g.role}.`;
  const canonical = `https://palebluenexus.com/episodes/${g.episodeSlug}/`;
  const image = `https://img.youtube.com/vi/${g.youtubeId}/maxresdefault.jpg`;
  const episodeSchema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "PodcastSeries",
        "@id": "https://palebluenexus.com/#podcast",
        name: "Pale Blue Nexus",
        url: "https://palebluenexus.com/",
      },
      {
        "@type": "PodcastEpisode",
        "@id": `${canonical}#episode`,
        name: pageTitle,
        description,
        url: canonical,
        image,
        datePublished: g.date || "",
        partOfSeries: { "@id": "https://palebluenexus.com/#podcast" },
        guest: {
          "@type": "Person",
          name: g.name,
          jobTitle: g.role,
        },
        associatedMedia: { "@id": `${canonical}#video` },
      },
      {
        "@type": "VideoObject",
        "@id": `${canonical}#video`,
        name: pageTitle,
        description,
        thumbnailUrl: image,
        uploadDate: g.date || "",
        contentUrl: `https://www.youtube.com/watch?v=${g.youtubeId}`,
        embedUrl: `https://www.youtube.com/embed/${g.youtubeId}`,
      },
    ],
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(pageTitle)}</title>
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="description" content="${esc(description)}" />
  <meta property="og:title" content="${esc(pageTitle)}" /><meta property="og:description" content="${esc(description)}" /><meta property="og:type" content="video.episode" /><meta property="og:url" content="${esc(canonical)}" /><meta property="og:image" content="${esc(image)}" />
  <meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(pageTitle)}" /><meta name="twitter:description" content="${esc(description)}" /><meta name="twitter:image" content="${esc(image)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin /><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&amp;family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&amp;family=Inter:wght@300;400;500;600&amp;display=swap" rel="stylesheet" />
  <script type="application/ld+json">${JSON.stringify(episodeSchema).replace(/</g, "\\u003c")}</script>
  <link rel="icon" type="image/png" href="/images/favicon.png" />
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--bg:#04060e;--border:rgba(255,255,255,.06);--gold:#D4A84B;--secondary:#A6D2E6;--muted:rgba(146,196,222,.7)}html{scroll-behavior:smooth}body{font-family:Montserrat,sans-serif;background:var(--bg);color:#fff;line-height:1.7}nav{position:fixed;top:0;left:0;right:0;z-index:2;padding:1.25rem 2.5rem}nav.scrolled{background:rgba(4,6,14,.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}.nav-logo{display:flex}.nav-logo img{height:40px}.section-container{max-width:900px;margin:auto;padding:0 2rem}section{padding:7rem 2rem}.eyebrow{font-size:.75rem;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);display:block;margin-bottom:1rem}h1,h2{font-family:"Cormorant Garamond",serif;line-height:1.15}h1{font-size:clamp(2rem,4vw,2.8rem);margin-bottom:1rem}h2{font-size:2.4rem;margin-bottom:1rem}.hero{min-height:60vh;display:flex;align-items:flex-end;padding:8rem 0 4rem}.photo{width:120px;height:120px;border-radius:50%;object-fit:cover;border:2px solid var(--gold);margin-bottom:1.5rem}.meta{display:flex;gap:1.5rem;color:var(--muted);font-size:.85rem;margin:1rem 0 1.5rem}.share{display:inline-flex;padding:.5rem 1rem;border:1px solid var(--border);border-radius:100px;color:var(--secondary);text-decoration:none;font-size:.8rem}.embed{aspect-ratio:16/9;border-radius:12px;overflow:hidden;border:1px solid var(--border)}iframe{width:100%;height:100%;border:0}.bio{color:var(--secondary);max-width:640px}footer{padding:3rem 2rem;text-align:center;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem}.fade{animation:fade .8s ease forwards}@keyframes fade{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}@media(max-width:600px){nav{padding:1rem 1.25rem}.section-container{padding:0 1rem}section{padding-left:1rem;padding-right:1rem}}
  </style>
</head>
<body><nav id="nav"><a href="/" class="nav-logo"><img src="/images/pbn-logo.png" alt="Pale Blue Nexus" /></a></nav>
  <section class="hero"><div class="section-container"><div class="fade"><span class="section-eyebrow eyebrow">${esc(g.episode)}</span><img class="guest-photo photo" src="../../${esc(g.photo)}" alt="${esc(g.name)}" /><h1>${esc(g.name)}</h1><p style="font-size:1.1rem;color:var(--secondary);max-width:600px">${esc(episodeTitle)}</p><div class="episode-meta meta"><span>${esc(g.episode)}</span></div><a class="share-btn share" href="https://www.youtube.com/watch?v=${esc(g.youtubeId)}" target="_blank" rel="noopener noreferrer">Watch on YouTube</a></div></div></section>
  <!-- AUTO-EP-KIT:start --><!-- AUTO-EP-KIT:end -->
  <section style="padding-top:0"><div class="section-container"><div class="embed fade"><iframe src="https://www.youtube.com/embed/${esc(g.youtubeId)}" title="${esc(episodeTitle)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe></div></div></section>
  <section style="background:linear-gradient(180deg,rgba(10,14,28,1) 0%,var(--bg) 100%)"><div class="section-container"><span class="section-eyebrow eyebrow fade">About the Guest</span><h2 class="fade">${esc(g.name)}.</h2><p class="guest-bio bio fade">${esc(g.bio || "")}</p></div></section>
  <footer><p>Pale Blue Nexus. Making sense of the future, from right here.</p></footer><script>window.addEventListener('scroll',()=>document.getElementById('nav').classList.toggle('scrolled',window.scrollY>50));</script>
</body></html>
`;
}

function removeDuplicateGuestVideos(guests) {
  const ownerById = new Map();
  const kept = [];
  let removed = 0;

  for (const guest of guests) {
    if (!guest.youtubeId) {
      kept.push(guest);
      continue;
    }

    const existing = ownerById.get(guest.youtubeId);
    if (!existing) {
      ownerById.set(guest.youtubeId, guest);
      kept.push(guest);
      continue;
    }

    if (existing.needsReview && !guest.needsReview) {
      kept[kept.indexOf(existing)] = guest;
      ownerById.set(guest.youtubeId, guest);
      removed += 1;
    } else if (guest.needsReview) {
      removed += 1;
    } else {
      kept.push(guest);
      log(`warning: duplicate curated guest video id ${guest.youtubeId}`);
    }
  }

  guests.splice(0, guests.length, ...kept);
  return removed;
}

/* ----------------------------------------------------------- html rendering */

const PLATFORM_LABEL = { youtube: "YouTube", tiktok: "TikTok" };

function reachTotal(item) {
  const listens = item.platform === "youtube" ? (item.listens || 0) : 0;
  return (item.views || 0) + listens;
}

function cardHtml(item, { rank } = {}) {
  const listens = item.platform === "youtube" ? (item.listens || 0) : 0;
  const total = (item.views || 0) + listens;
  let metric;
  if (total > 0) {
    metric = `${fmtViews(total)} ${listens > 0 ? "views & listens" : "views"}`;
  } else {
    metric = item.duration || "";
  }
  const badge = PLATFORM_LABEL[item.platform] || item.platform;
  const rankHtml = rank ? `<span class="feed-rank">#${rank}</span>` : "";
  const thumb = item.thumb || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
  const thumbUrl = /^https?:\/\//i.test(thumb) || thumb.startsWith("/")
    ? thumb
    : `/${thumb.replace(/^\.?\//, "")}`;
  const portrait = item.platform === "tiktok";
  const thumbInner = portrait
    ? `<span class="feed-thumb-bg" style="background-image:url('${esc(thumbUrl)}')"></span>
            <img class="feed-thumb-portrait" src="${esc(thumbUrl)}" alt="${esc(item.title)}" loading="lazy" />`
    : `<img src="${esc(thumbUrl)}" alt="${esc(item.title)}" loading="lazy" />`;
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

function episodeKitHtml(g, { item, reach = {}, clips = [] } = {}) {
  const total = (reach.views || 0) + (reach.listens || 0);
  const combinedStat = total > 0 ? `${fmtViews(total)} ${reach.listens > 0 ? "views & listens" : "views"}` : "";
  const episodeUrl = `https://www.youtube.com/watch?v=${esc(g.youtubeId)}`;
  const clipBlocks = clips.length
    ? `<div class="ep-kit-clips">
        <h2 class="ep-kit-heading">Clips</h2>
        <div class="ep-kit-grid">
${clips.map((clip) => {
  const thumb = clip.thumb || `https://i.ytimg.com/vi/${clip.id}/hqdefault.jpg`;
  const thumbUrl = /^https?:\/\//i.test(thumb) || thumb.startsWith("/") ? thumb : `/${thumb.replace(/^\.?\//, "")}`;
  const platform = PLATFORM_LABEL[clip.platform] || clip.platform;
  return `          <a href="${esc(clip.url)}" target="_blank" rel="noopener noreferrer" class="ep-kit-card">
            <div class="ep-kit-thumb"><img src="${esc(thumbUrl)}" alt="${esc(clip.title)}" loading="lazy" /><span class="ep-kit-badge">${esc(platform)}</span></div>
            <div class="ep-kit-body"><p class="ep-kit-clip-title">${esc(clip.title)}</p><p class="ep-kit-clip-meta">${fmtViews(clip.views || 0)} views</p></div>
          </a>`;
}).join("\n")}
        </div>
      </div>`
    : "";
  return `
  <style>
    .ep-kit{padding:0 0 2rem}.ep-kit-shell{background:linear-gradient(180deg,rgba(10,14,28,1) 0%,#04060e 100%);border-top:1px solid rgba(255,255,255,0.08);border-bottom:1px solid rgba(255,255,255,0.08)}.ep-kit-row{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1rem}.ep-kit-stat{color:#A6D2E6;font-size:1rem}.ep-kit-links{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}.ep-kit-heading{font-family:'Cormorant Garamond',Georgia,serif;font-size:2rem;line-height:1.15;margin-bottom:1rem}.ep-kit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-top:1rem}.ep-kit-card{display:block;color:inherit;text-decoration:none;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;transition:transform .3s,border-color .3s}.ep-kit-card:hover{transform:translateY(-3px);border-color:rgba(212,168,75,.5)}.ep-kit-thumb{aspect-ratio:16/9;position:relative;background:#0a0f1e}.ep-kit-thumb img{width:100%;height:100%;object-fit:cover}.ep-kit-badge{position:absolute;left:.65rem;bottom:.65rem;background:rgba(4,6,14,.85);color:#7EB8DA;padding:.2rem .45rem;border-radius:999px;font-size:.65rem}.ep-kit-body{padding:.9rem}.ep-kit-clip-title{font-size:.82rem;line-height:1.4;color:#fff}.ep-kit-clip-meta{font-size:.75rem;color:rgba(166,210,230,0.6);margin-top:.35rem}
  </style>
  <section class="ep-kit ep-kit-shell">
    <div class="section-container">
${combinedStat ? `      <p class="ep-kit-stat fade-up">${combinedStat}</p>\n` : ""}      <div class="ep-kit-links fade-up">
        <a href="${episodeUrl}" target="_blank" rel="noopener noreferrer" class="share-btn share">Watch on YouTube</a>
        <a href="${SHOW_LINKS.apple}" target="_blank" rel="noopener noreferrer" class="share-btn share">Listen on Apple Podcasts</a>
        <a href="${SHOW_LINKS.spotify}" target="_blank" rel="noopener noreferrer" class="share-btn share">Listen on Spotify</a>
      </div>${clipBlocks ? `\n      ${clipBlocks}` : ""}
    </div>
  </section>`;
}

function episodeIndexCardsHtml(guests, items) {
  const published = guests
    .filter((g) => g.status === "published" && g.episodeSlug && g.youtubeId)
    .sort((a, b) => {
      const aNumber = parseInt(String(a.episode).match(/\d+/)?.[0] || "0", 10);
      const bNumber = parseInt(String(b.episode).match(/\d+/)?.[0] || "0", 10);
      return bNumber - aNumber;
    });
  return `\n${published.map((g) => {
    const item = items.find((i) => i.id === g.youtubeId);
    const duration = g.duration || item?.duration || "";
    const thumb = `https://img.youtube.com/vi/${esc(g.youtubeId)}/hqdefault.jpg`;
    const meta = duration
      ? `<span>${esc(duration)}</span><span>&middot;</span><span>YouTube</span>`
      : "<span>YouTube</span>";
    return `        <a href="/episodes/${esc(g.episodeSlug)}/" class="episode-card fade-up">
          <div class="episode-thumb"><img src="${thumb}" alt="${esc(g.name)}: Pale Blue Nexus ${esc(g.episode)}" loading="lazy" /></div>
          <div class="episode-info"><p class="episode-number">${esc(g.episode)}</p><h3 class="episode-title">${esc(g.name)}</h3><p class="episode-desc">${esc(g.episodeTitle || item?.title || "")}</p><div class="episode-meta-row">${meta}</div></div>
        </a>`;
  }).join("\n")}`;
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
  const top = topPerformingItems(items, TOP_COUNT);

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

function topPerformingItems(items, count) {
  return [...items]
    .sort((a, b) => reachTotal(b) - reachTotal(a) || b.score - a.score)
    .slice(0, count);
}

// Channel-level totals across YouTube (regular + Shorts) and TikTok.
async function fetchChannelStats() {
  const stats = { generatedAt: new Date().toISOString() };

  const yt = await edFetch("/youtube/channel/detailed-info", { browseId: YT_CHANNEL_ID });
  const about = yt?.data?.metadata?.aboutChannelViewModel || {};
  stats.youtube = {
    views: parseCount(about.viewCountText),
    subscribersText: String(about.subscriberCountText || "").replace(/\s*subscribers?$/i, "").trim(),
    videos: parseInt(String(about.videoCountText || "").replace(/[^0-9]/g, ""), 10) || 0,
  };
  if (!about.viewCountText || !about.subscriberCountText) {
    throw new Error("youtube about block missing viewCountText/subscriberCountText");
  }

  const info = await edFetch("/tt/user/info", { username: TT_USERNAME });
  const s = info?.data?.stats || {};
  const posts = (await edFetch("/tt/user/posts", { username: TT_USERNAME, depth: 5, oldest_createtime: 0 }))?.data || [];
  let ttViews = 0;
  for (const p of posts) ttViews += p?.statistics?.play_count || 0;
  stats.tiktok = {
    views: ttViews,
    followers: s.followerCount || 0,
    videos: s.videoCount || posts.length || 0,
  };

  stats.totalViews = stats.youtube.views + stats.tiktok.views;
  return stats;
}

// Cumulative reach band, injected high on the homepage.
function statsBandHtml(stats, podcastTotal = 0) {
  if (!stats) return "";
  const videos = (stats.youtube?.videos || 0) + (stats.tiktok?.videos || 0);
  const totalReach = (stats.totalViews || 0) + podcastTotal;
  const items = [
    { n: fmtViews(totalReach), l: "Views &amp; listens across YouTube, TikTok &amp; podcast" },
    { n: esc(stats.youtube?.subscribersText || fmtViews(stats.youtube?.subscribers || 0)), l: "YouTube subscribers" },
    { n: String(videos), l: "Videos &amp; clips published" },
  ];
  return "\n      <div class=\"reach-grid\">\n" +
    items.map((i) => `        <div class="reach-item fade-up"><div class="reach-number">${i.n}</div><div class="reach-label">${i.l}</div></div>`).join("\n") +
    "\n      </div>";
}

// Subscriber + combined-views stats on the /book/ proof band.
function bookStatsHtml(stats, podcastTotal = 0) {
  if (!stats) return "";
  const subs = stats.youtube?.subscribersText || fmtViews(stats.youtube?.subscribers || 0);
  const totalReach = (stats.totalViews || 0) + podcastTotal;
  return "\n          " +
    `<div class="proof-item fade-up"><div class="proof-number">${esc(subs)}</div><div class="proof-label">YouTube subscribers</div></div>\n          ` +
    `<div class="proof-item fade-up"><div class="proof-number">${fmtViews(totalReach)}</div><div class="proof-label">Views &amp; listens across all channels and growing</div></div>`;
}

function bookTopHtml(items) {
  const top = topPerformingItems(items, 10);
  return `
  <!-- ════════ BOOKING PAGE TOP CLIPS (auto-generated) ════════ -->
  <section class="feed-section" id="best-clips">
    <div class="section-container">
      <div class="section-head fade-up">
        <span class="section-eyebrow">Best Moments</span>
        <h2 class="section-heading">The clips that travelled.</h2>
        <p class="section-subheading">A few conversations that found their audience across the feed.</p>
      </div>
      <div class="book-feed-strip">
${top.map((i, idx) => cardHtml(i, { rank: idx + 1 })).join("\n")}
      </div>
    </div>
  </section>
`;
}

function guestCardHtml(g, item, reach = {}, { isLatest = false } = {}) {
  const isPub = g.status === "published";
  const href = isPub && g.episodeSlug
    ? `/episodes/${g.episodeSlug}/`
    : (g.linkedin || g.website || (g.youtubeId ? `https://www.youtube.com/watch?v=${g.youtubeId}` : "#"));
  const ext = !(isPub && g.episodeSlug);
  const reachTotal = (reach.views || 0) + (reach.listens || 0);
  const reachLabel = reach.listens > 0 ? "views &amp; listens" : "views";
  const reachTag = reachTotal > 0 ? ` &middot; ${fmtViews(reachTotal)} ${reachLabel}` : "";
  const tag = isPub ? `${esc(g.episode)}${reachTag}` : esc(g.episode);
  const statusClass = isPub ? "guest-show-status-published" : "guest-show-status-upcoming";
  const statusLabel = isPub ? "Published" : "Coming soon";
  const tagHtml = isPub ? `<span class="guest-show-tag">${tag}</span>` : "";
  const latest = isLatest ? '<span class="guest-show-latest">Latest</span>' : "";
  const quoteHtml = g.quote ? `<p class="guest-show-quote">&ldquo;${esc(g.quote)}&rdquo;</p>` : "";
  return `        <a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""} class="guest-show-card${isLatest ? " guest-show-card-latest" : ""} fade-up">
          <div class="guest-show-photo"><img src="${esc(g.photo)}" alt="${esc(g.name)}" loading="lazy" /></div>
          <div class="guest-show-body">
            <div class="guest-show-status-row">${tagHtml}<span class="guest-show-status ${statusClass}"><span class="guest-show-status-dot"></span>${statusLabel}</span>${latest}</div>
            <p class="guest-show-name">${esc(g.name)}</p>
            <p class="guest-show-role">${esc(g.role)}</p>${quoteHtml}<span class="guest-show-promo">Promo kit &rarr;</span>
          </div>
        </a>`;
}

// Auto-detected episode drafts (needsReview / needsPhoto) and any entry without
// a real name are held back from all public output until a human supplies a real
// name and photo, so a card is never rendered against a non-existent image.
function isPublicGuest(g) {
  return !g.needsReview && !g.needsPhoto && !!(g.name && g.name.trim());
}

function guestsSectionHtml(guests, byGuest, guestReach) {
  const renderable = guests.filter(isPublicGuest);
  const published = renderable.filter((g) => g.status === "published");
  const upcoming = renderable.filter((g) => g.status !== "published");
  const ordered = [...published, ...upcoming];
  const latestPublished = published.reduce((latest, guest) => {
    if (!latest) return guest;
    const episodeNumber = Number((guest.episode || "").match(/\d+/)?.[0] || 0);
    const latestEpisodeNumber = Number((latest.episode || "").match(/\d+/)?.[0] || 0);
    if (episodeNumber !== latestEpisodeNumber) {
      return episodeNumber > latestEpisodeNumber ? guest : latest;
    }
    return (guest.date || "") > (latest.date || "") ? guest : latest;
  }, null);
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
${ordered.map((g) => guestCardHtml(g, byGuest[g.slug], guestReach[g.slug], { isLatest: g.slug === latestPublished?.slug })).join("\n")}
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
  const guestsCfg = JSON.parse(readFileSync(join(ROOT, "data/guests.json"), "utf8"));
  const guests = guestsCfg.guests;
  const feedPath = join(ROOT, "data/feed.json");
  const existingFeed = JSON.parse(readFileSync(feedPath, "utf8"));
  let podcast = { totalStreams: 0, episodes: [] };
  try {
    podcast = JSON.parse(readFileSync(join(ROOT, "data/podcast.json"), "utf8"));
  } catch (e) {
    log("podcast.json missing/invalid; listens disabled", e.message);
  }
  const streamsById = new Map();
  const streamsByKey = new Map();
  for (const episode of podcast.episodes || []) {
    const streams = Number(episode.streams) || 0;
    if (episode.youtubeId) streamsById.set(String(episode.youtubeId), streams);
    else if (episode.title) streamsByKey.set(podcastKey(episode.title), streams);
  }

  const imagesDir = join(ROOT, "images/feed");
  mkdirSync(imagesDir, { recursive: true });
  writeFileSync(join(imagesDir, ".gitkeep"), "");

  let items = existingFeed.items || [];
  let stats = existingFeed.stats || null;
  if (ED_TOKEN) {
    let yt = [];
    let tt = [];
    try {
      yt = await fetchYouTube();
      const audioIds = new Set();
      for (const item of yt) {
        if (await isAudioOnlyThumb(item.id)) audioIds.add(item.id);
      }

      const videoTwins = new Map();
      for (const item of yt) {
        if (audioIds.has(item.id)) continue;
        const title = normalizeTitle(item.title);
        if (title && !videoTwins.has(title)) videoTwins.set(title, item.id);
      }
      const audioToVideo = new Map();
      for (const item of yt) {
        if (audioIds.has(item.id)) {
          const videoTwin = videoTwins.get(normalizeTitle(item.title));
          if (videoTwin) audioToVideo.set(item.id, videoTwin);
        }
      }
      let remappedGuests = 0;
      for (const guest of guests) {
        const videoTwin = audioToVideo.get(guest.youtubeId);
        if (videoTwin) {
          guest.youtubeId = videoTwin;
          remappedGuests += 1;
        }
      }
      const removedDuplicateGuests = removeDuplicateGuestVideos(guests);
      if (remappedGuests || removedDuplicateGuests) {
        writeFileSync(join(ROOT, "data/guests.json"), JSON.stringify(guestsCfg, null, 2) + "\n");
      }
      yt = yt.filter((item) => !audioIds.has(item.id));
      const beforeDedupe = yt.length;
      yt = dedupeYouTube(yt);
      log(`youtube: ${yt.length} videos (dropped ${audioIds.size} audio-only re-uploads, deduped from ${beforeDedupe})`);
      if (remappedGuests) log(`remapped ${remappedGuests} guest audio references to video twins`);
      if (removedDuplicateGuests) log(`removed ${removedDuplicateGuests} duplicate auto-detected guest records`);
      try {
        await syncUnrecognizedEpisodes(yt, guests, guestsCfg);
      } catch (e) {
        log("warning: episode draft sync failed:", e.message);
      }
    } catch (e) {
      log("youtube fetch failed:", e.message);
    }
    try {
      tt = await fetchTikTok(imagesDir);
      log(`tiktok: ${tt.length} clips`);
    } catch (e) {
      log("tiktok fetch failed:", e.message);
    }
    try {
      stats = await fetchChannelStats();
      log(`channel stats: ${fmtViews(stats.totalViews)} combined views`);
    } catch (e) {
      log("channel stats fetch failed:", e.message);
    }
    if (yt.length || tt.length) items = [...yt, ...tt];
    else log("no fresh items fetched; reusing existing data/feed.json");
  } else {
    log("ENSEMBLE_API_KEY is not set; reusing existing data/feed.json");
  }
  if (!items.length) throw new Error("no feed items available; aborting without rewriting");

  // map youtube + tiktok posts -> guests; compute scores
  const ytIdToGuest = {};
  const ttIdToGuest = {};
  for (const g of guests) {
    if (g.youtubeId) ytIdToGuest[g.youtubeId] = g.slug;
    for (const id of g.tiktokIds || []) ttIdToGuest[String(id)] = g.slug;
  }
  for (const it of items) {
    it.guestSlug = (it.platform === "youtube" ? ytIdToGuest[it.id] : ttIdToGuest[it.id]) || null;
    if (it.platform === "youtube") {
      it.listens = streamsById.get(it.id) ?? streamsByKey.get(podcastKey(it.title)) ?? 0;
    } else {
      delete it.listens;
    }
    it.score = Math.round(performanceScore(it));
  }
  let guestsChanged = false;
  for (const g of guests) {
    const episodeItem = g.youtubeId ? items.find((item) => item.id === g.youtubeId) : null;
    if (episodeItem?.duration && g.duration !== episodeItem.duration) {
      g.duration = episodeItem.duration;
      guestsChanged = true;
    }
  }
  if (guestsChanged) {
    writeFileSync(join(ROOT, "data/guests.json"), JSON.stringify(guestsCfg, null, 2) + "\n");
  }

  const publishedGuests = guests.filter((g) => g.status === "published");
  for (const it of items) {
    if (it.platform !== "tiktok" || it.guestSlug) continue;
    const matches = publishedGuests.filter((g) => {
      const name = guestNameKey(g.name);
      if (!name) return false;
      const escaped = name.split(" ").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      return new RegExp(`\\b${escaped}\\b`, "i").test(it.title || "");
    });
    if (matches.length === 1) it.guestSlug = matches[0].slug;
  }
  items.sort((a, b) => b.score - a.score);

  // best-performing item per guest (their episode video if present)
  const byGuest = {};
  const guestReach = {};
  for (const g of guests) {
    const own = items.filter((i) => i.guestSlug === g.slug).sort((a, b) => b.score - a.score);
    const preferred = items.find((i) => i.id === g.youtubeId) ||
      own.find((i) => i.platform === "youtube") ||
      own[0] ||
      (g.youtubeId ? items.find((i) => i.id === g.youtubeId) : null);
    byGuest[g.slug] = preferred || null;
    guestReach[g.slug] = {
      views: own.reduce((total, item) => total + (item.views || 0), 0),
      listens: streamsById.get(g.youtubeId) ?? 0,
    };
  }
  const totalReach = stats ? (stats.totalViews || 0) + (Number(podcast.totalStreams) || 0) : 0;

  // write feed.json
  const feed = {
    generatedAt: new Date().toISOString(),
    source: { youtube: `@${"palebluenexus"}`, tiktok: `@${TT_USERNAME}` },
    count: items.length,
    stats,
    items: items.map(({ descSnippet, ...item }) => item),
  };
  if (ED_TOKEN) {
    writeFileSync(feedPath, JSON.stringify(feed, null, 2) + "\n");
    log(`wrote data/feed.json (${items.length} items)`);
  }

  // inject homepage sections
  let html = readFileSync(join(ROOT, "index.html"), "utf8");
  html = injectBetween(html, "AUTO-LATEST", latestDropsHtml(items));
  html = injectBetween(html, "AUTO-TOP", topPerformingHtml(items));
  html = injectBetween(html, "AUTO-GUESTS", guestsSectionHtml(guests, byGuest, guestReach));
  if (stats) html = injectBetween(html, "AUTO-STATS", statsBandHtml(stats, Number(podcast.totalStreams) || 0));
  writeFileSync(join(ROOT, "index.html"), html);
  log("updated index.html sections");

  const bookPath = join(ROOT, "book/index.html");
  let bookHtml = readFileSync(bookPath, "utf8");
  bookHtml = injectBetween(bookHtml, "AUTO-BOOK-TOP", bookTopHtml(items));
  if (stats) bookHtml = injectBetween(bookHtml, "AUTO-BOOK-STATS", bookStatsHtml(stats, Number(podcast.totalStreams) || 0));
  writeFileSync(bookPath, bookHtml);
  log("updated book/index.html clips section");

  const partnerPath = join(ROOT, "partner/index.html");
  let partnerHtml = readFileSync(partnerPath, "utf8");
  if (stats) {
    const subs = esc(stats.youtube?.subscribersText || fmtViews(stats.youtube?.subscribers || 0));
    partnerHtml = injectBetween(partnerHtml, "AUTO-PARTNER-HERO-SUBS", subs);
    partnerHtml = injectBetween(partnerHtml, "AUTO-PARTNER-HERO-VIEWS", fmtViews(totalReach));
    partnerHtml = injectBetween(partnerHtml, "AUTO-PARTNER-AUD-SUBS", subs);
    partnerHtml = injectBetween(partnerHtml, "AUTO-PARTNER-AUD-VIEWS", fmtViews(totalReach));
  }
  writeFileSync(partnerPath, partnerHtml);
  log("updated partner/index.html audience stats");

  const episodeGuests = guests.filter((g) => g.status === "published" && g.episodeSlug && g.youtubeId && isPublicGuest(g));
  for (const g of episodeGuests) {
    const episodeItem = items.find((i) => i.id === g.youtubeId) || byGuest[g.slug];
    const clips = items
      .filter((i) => i.guestSlug === g.slug && i.type === "clip")
      .sort((a, b) => b.score - a.score);
    const episodePath = join(ROOT, "episodes", g.episodeSlug, "index.html");
    if (!existsSync(episodePath)) {
      log(`warning: no episode page for ${g.slug}; skipping kit injection`);
      continue;
    }
    const episodeHtml = readFileSync(episodePath, "utf8");
    if (!episodeHtml.includes("<!-- AUTO-EP-KIT:start -->")) {
      log(`warning: ${g.episodeSlug}/index.html has no AUTO-EP-KIT markers; skipping`);
      continue;
    }
    writeFileSync(
      episodePath,
      injectBetween(episodeHtml, "AUTO-EP-KIT", episodeKitHtml(g, { item: episodeItem, reach: guestReach[g.slug], clips })),
    );
  }
  const episodesIndexPath = join(ROOT, "episodes/index.html");
  let episodesIndexHtml = readFileSync(episodesIndexPath, "utf8");
  episodesIndexHtml = injectBetween(episodesIndexHtml, "AUTO-EPISODES", episodeIndexCardsHtml(episodeGuests, items));
  writeFileSync(episodesIndexPath, episodesIndexHtml);
  log(`updated ${episodeGuests.length} episode pages and episodes/index.html`);

  // per-guest promo og:image cards (hosted SVG, fetchable by social crawlers)
  const promoImgDir = join(ROOT, "images/promo");
  mkdirSync(promoImgDir, { recursive: true });
  for (const g of guests.filter(isPublicGuest)) {
    writeFileSync(join(promoImgDir, `${g.slug}.svg`), promoSvg(g));
  }

  // per-guest promo pages
  const promoDir = join(ROOT, "share/guest");
  mkdirSync(promoDir, { recursive: true });
  const publicGuests = guests.filter(isPublicGuest);
  for (const g of publicGuests) {
    writeFileSync(join(promoDir, `${g.slug}.html`), promoPageHtml(g, byGuest[g.slug]));
  }
  log(`wrote ${publicGuests.length} promo pages to share/guest/`);
}

main().catch((e) => {
  console.error("[update-feed] FAILED:", e.message);
  process.exit(1);
});
