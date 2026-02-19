function parseInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  return { url: text };
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function parseVideoId(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.pathname.startsWith("/watch")) return u.searchParams.get("v") || "";
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || "";
    if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || "";
  } catch {
    return "";
  }
  return "";
}

function extractJsonByPrefix(text, prefix) {
  const start = text.indexOf(prefix);
  if (start < 0) return null;
  const braceStart = text.indexOf("{", start + prefix.length);
  if (braceStart < 0) return null;
  let inStr = false;
  let escape = false;
  let depth = 0;
  for (let i = braceStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inStr = false;
      }
      continue;
    }
    if (ch === "\"") {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = text.slice(braceStart, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function pickTrack(captionTracks, languages) {
  if (!Array.isArray(captionTracks) || !captionTracks.length) return null;
  const prefs = Array.isArray(languages) && languages.length ? languages.map(String) : ["zh-Hans", "zh-Hant", "zh", "en"];
  for (const lang of prefs) {
    const hit = captionTracks.find((t) => String(t?.languageCode || "").toLowerCase() === lang.toLowerCase());
    if (hit) return hit;
  }
  return captionTracks[0];
}

function parseJson3Transcript(json, maxSegments) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const segments = [];
  for (const e of events) {
    const segs = Array.isArray(e?.segs) ? e.segs : [];
    if (!segs.length) continue;
    const text = decodeHtmlEntities(
      segs
        .map((x) => String(x?.utf8 || ""))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!text) continue;
    segments.push({
      startMs: Number(e?.tStartMs || 0),
      durationMs: Number(e?.dDurationMs || 0),
      text
    });
    if (segments.length >= maxSegments) break;
  }
  return segments;
}

export async function run(input) {
  const payload = parseInput(input);
  const url = String(payload.url || "").trim();
  if (!url) return JSON.stringify({ ok: false, error: "missing_url" }, null, 2);
  const videoId = parseVideoId(url);
  if (!videoId) return JSON.stringify({ ok: false, error: "invalid_youtube_url" }, null, 2);

  const maxSegments = Math.max(1, Number(payload.maxSegments || 800));
  const joinText = payload.joinText !== false;
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  try {
    const resp = await fetch(watchUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    const html = await resp.text();
    const player = extractJsonByPrefix(html, "ytInitialPlayerResponse =");
    const tracks =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
      player?.captions?.playerCaptionsRenderer?.captionTracks ||
      [];
    const track = pickTrack(tracks, payload.languages);
    if (!track?.baseUrl) {
      return JSON.stringify(
        {
          ok: false,
          videoId,
          error: "no_captions_available"
        },
        null,
        2
      );
    }

    const timedUrl = new URL(String(track.baseUrl));
    timedUrl.searchParams.set("fmt", "json3");
    const capResp = await fetch(String(timedUrl));
    const capJson = await capResp.json();
    const segments = parseJson3Transcript(capJson, maxSegments);
    const out = {
      ok: true,
      videoId,
      language: String(track.languageCode || ""),
      trackName: String(track.name?.simpleText || track.name?.runs?.[0]?.text || ""),
      segmentCount: segments.length,
      segments
    };
    if (joinText) {
      out.text = segments.map((s) => s.text).join("\n");
    }
    return JSON.stringify(out, null, 2);
  } catch (error) {
    return JSON.stringify(
      {
        ok: false,
        videoId,
        error: String(error?.message || error)
      },
      null,
      2
    );
  }
}
