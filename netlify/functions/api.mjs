// Z-downloder backend (Netlify Functions v2, Node 18+)
// GET /api/scan?platform=tiktok|instagram|pinterest&url=...  -> info media (JSON)
// GET /api/dl?url=...&name=...                               -> stream file sebagai attachment
export const config = { path: "/api/*" };

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function headSize(url) {
  try {
    const r = await fetch(url, { method: "HEAD", headers: UA, signal: AbortSignal.timeout(5000) });
    const n = Number(r.headers.get("content-length"));
    return n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/* ---------------- TikTok (tikwm) ---------------- */
async function tiktok(url) {
  const r = await fetch("https://www.tikwm.com/api/?hd=1&url=" + encodeURIComponent(url), {
    headers: UA,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!j || j.code !== 0 || !j.data) throw new Error(j?.msg || "TikTok tidak ditemukan");
  const d = j.data;
  const abs = (u) => (u && u.startsWith("/") ? "https://www.tikwm.com" + u : u);
  const base = {
    platform: "tiktok",
    title: d.title || "(tanpa deskripsi)",
    author: d.author?.nickname || d.author?.unique_id || "",
    duration: d.duration || 0,
    thumb: abs(d.cover || d.origin_cover),
  };
  if (Array.isArray(d.images) && d.images.length) {
    return { ...base, kind: "slide", items: d.images.map((u, i) => ({ type: "image", url: abs(u), label: `Slide ${i + 1}`, size: 0 })) };
  }
  const v = abs(d.hdplay || d.play);
  return {
    ...base,
    kind: "video",
    items: [{ type: "video", url: v, label: d.hdplay ? "Video HD" : "Video", size: d.hd_size || d.size || 0 }],
  };
}

/* ---------------- Instagram (azbry) ---------------- */
async function instagram(url) {
  const r = await fetch("https://api.azbry.com/api/download/instagram?url=" + encodeURIComponent(url), {
    headers: UA,
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json();
  const videos = j?.videos || [];
  const images = j?.images || [];
  if (!j?.status || (!videos.length && !images.length)) throw new Error("Media Instagram tidak ditemukan (akun privat atau link salah)");
  const items = [
    ...videos.map((u, i) => ({ type: "video", url: u, label: videos.length > 1 ? `Video ${i + 1}` : "Video", size: 0 })),
    ...images.map((u, i) => ({ type: "image", url: u, label: `Foto ${i + 1}`, size: 0 })),
  ];
  if (items[0]) items[0].size = await headSize(items[0].url);
  return {
    platform: "instagram",
    kind: videos.length ? "video" : items.length > 1 ? "slide" : "image",
    title: "",
    author: "",
    duration: 0,
    thumb: j.thumb || (images[0] ?? null),
    items,
  };
}

/* ---------------- Pinterest (port dari pinsdowloder.py) ---------------- */
const meta = (h, p) => {
  const a = h.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)["']`, "i"));
  const b = h.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, "i"));
  const m = a || b;
  return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null;
};
function videoFromJson(h) {
  const found = [...h.matchAll(/"url":"(https:[^"]+?\.mp4[^"]*)"/g)].map((m) => {
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/"); }
  });
  if (!found.length) return null;
  for (const t of ["V_HLSV4", "V_720P", "V_EXP7", "V_480P", "V_360P"]) {
    const hit = found.find((c) => c.includes(t));
    if (hit) return hit;
  }
  return found[0];
}
async function pinterest(url) {
  const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("Halaman Pinterest tidak bisa dibuka (" + r.status + ")");
  const page = await r.text();
  let video = videoFromJson(page);
  if (!video) {
    const og = meta(page, "og:video:secure_url") || meta(page, "og:video");
    if (og) video = /\.m3u8/.test(og) ? og.replace("/hls/", "/720p/").replace(/\.m3u8.*$/, ".mp4") : og;
  }
  const image = meta(page, "og:image");
  const base = {
    platform: "pinterest",
    title: meta(page, "og:description") || meta(page, "og:title") || "(tanpa deskripsi)",
    author: "",
    duration: 0,
    thumb: image,
  };
  if (video) {
    return { ...base, kind: "video", items: [{ type: "video", url: video, label: "Video", size: await headSize(video) }] };
  }
  if (image) {
    const orig = image.replace(/\/\d+x(?:\d+)?\//, "/originals/");
    return { ...base, kind: "image", items: [{ type: "image", url: orig, label: "Gambar", size: await headSize(orig) }] };
  }
  throw new Error("Media tidak ditemukan. Pin privat, terhapus, atau tidak didukung.");
}

/* ---------------- Download proxy ---------------- */
function safeTarget(u) {
  let x;
  try { x = new URL(u); } catch { return null; }
  if (x.protocol !== "https:") return null;
  const h = x.hostname;
  if (h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".internal") || h.endsWith(".local")) return null;
  return x;
}
async function dl(params) {
  const x = safeTarget(params.get("url") || "");
  if (!x) return json({ error: "URL file tidak valid" }, 400);
  const name = (params.get("name") || "z-downloder").replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const up = await fetch(x, { headers: UA, redirect: "follow" });
  if (!up.ok || !up.body) return json({ error: "Sumber menolak permintaan (" + up.status + ")" }, 502);
  const h = new Headers({
    "content-type": up.headers.get("content-type") || "application/octet-stream",
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "no-store",
  });
  const len = up.headers.get("content-length");
  if (len) { h.set("content-length", len); h.set("x-file-size", len); }
  return new Response(up.body, { status: 200, headers: h });
}

export default async (req) => {
  const u = new URL(req.url);
  const route = u.pathname.replace(/^\/api\/?/, "").replace(/^\.netlify\/functions\/api\/?/, "");
  try {
    if (route === "dl") return await dl(u.searchParams);
    if (route === "scan") {
      const url = (u.searchParams.get("url") || "").trim();
      const platform = u.searchParams.get("platform");
      if (!/^https?:\/\//i.test(url)) return json({ error: "Masukkan URL lengkap diawali https://" }, 400);
      const fn = { tiktok, instagram, pinterest }[platform];
      if (!fn) return json({ error: "Platform tidak dikenal" }, 400);
      return json(await fn(url));
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e?.message || "Terjadi kesalahan" }, 502);
  }
};
