// OSRP Gang Scanner -> CSV (robust word-box parsing for mobile/desktop)
// Drop-in app.js

const BUILD = "v15"; // bump when you deploy
document.title = `OSRP Gang Scanner → CSV (${BUILD})`;

const fileEl = document.getElementById("file");
const imgEl = document.getElementById("img");
const extractBtn = document.getElementById("extract");
const copyBtn = document.getElementById("copyCsvBtn");
const downloadBtn = document.getElementById("downloadCsvBtn");
const clearBtn = document.getElementById("clear");
const csvEl = document.getElementById("csv");
const rawEl = document.getElementById("raw");
const statusEl = document.getElementById("status");
const appendBtn = document.getElementById("appendImageBtn");

// Optional ranks UI (if present in your HTML)
const ranksEl = document.getElementById("ranks") || document.getElementById("gangRanks");
const saveRanksBtn = document.getElementById("saveRanksBtn");

let cropper = null;
let currentObjectUrl = null;
let appendMode = false;
let allRows = [];
let allRawBlocks = [];

function setStatus(t) { statusEl.textContent = t; }

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function cropCanvas(srcCanvas, x, y, w, h) {
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.floor(w));
  out.height = Math.max(1, Math.floor(h));
  const ctx = out.getContext("2d");
  ctx.drawImage(srcCanvas, x, y, w, h, 0, 0, out.width, out.height);
  return out;
}

function preprocessForText(srcCanvas) {
  const scale = 2.2;
  const w = Math.max(1, Math.floor(srcCanvas.width * scale));
  const h = Math.max(1, Math.floor(srcCanvas.height * scale));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;

  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const v = clamp((y - 128) * 1.35 + 128, 0, 255);
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return out;
}

function preprocessForDigits(srcCanvas) {
  const scale = 2.6;
  const w = Math.max(1, Math.floor(srcCanvas.width * scale));
  const h = Math.max(1, Math.floor(srcCanvas.height * scale));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;

  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  const mean = sum / (d.length / 4);
  const thr = clamp(mean - 18, 110, 210);

  for (let i = 0; i < d.length; i += 4) {
    const y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const v = y > thr ? 255 : 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return out;
}

let _worker = null;
async function getWorker(logger) {
  if (_worker) return _worker;

  if (Tesseract?.createWorker) {
    const w = await Tesseract.createWorker({ logger });
    await w.loadLanguage("eng");
    await w.initialize("eng");
    _worker = w;
    return _worker;
  }

  return null;
}

async function recognizeCanvas(canvas, { whitelist = null, logger = null } = {}) {
  const worker = await getWorker(logger);

  const options = {};
  if (whitelist) options.tessedit_char_whitelist = whitelist;

  if (worker) {
    const res = await worker.recognize(canvas, options);
    return res.data;
  }

  const res = await Tesseract.recognize(canvas, "eng", { logger, ...options });
  return res.data;
}

function parseFirstInt(text) {
  const m = String(text || "").match(/\d{1,3}/);
  return m ? parseInt(m[0], 10) : null;
}

function parseHonorInt(text) {
  const digits = String(text || "").match(/\d+/g);
  if (!digits) return 0;

  const nums = digits.map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
  const big = nums.filter(n => n >= 1000);
  if (big.length) return Math.max(...big);

  const stitched = parseInt(digits.join(""), 10);
  return Number.isFinite(stitched) ? stitched : 0;
}

function parseActivity(text) {
  const t = String(text || "").trim();
  if (!t) return "n/a";
  if (/\bonline\b/i.test(t)) return "Online";
  if (/^(on|0n|onl|0nl|onli|0nli)$/i.test(t.replace(/\s+/g, ""))) return "Online";

  const m = t.match(/\b(\d{1,2})\s*([mhd])\b/i);
  if (m) return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;

  return "n/a";
}

function cleanupImage() {
  if (cropper) { cropper.destroy(); cropper = null; }
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
  imgEl.style.display = "none";
  imgEl.src = "";
  extractBtn.disabled = true;
  copyBtn.disabled = true;
  downloadBtn.disabled = true;
  clearBtn.disabled = true;
  csvEl.value = "";
  rawEl.value = "";
  setStatus(`Waiting for image… (${BUILD})`);
  appendMode = false;
  allRows = [];
  allRawBlocks = [];
  if (appendBtn) appendBtn.disabled = true;
}

// ---------------------------
// Helpers
// ---------------------------
function titleCase(s) {
  return (s || "")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// IMPORTANT: blocks junk like "x30" from becoming 30
function digitsOnly(token) {
  const s = String(token || "").trim();
  if (!s) return null;
  if (/[A-Za-z]/.test(s)) return null; // reject letter+digit junk
  const d = s.replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : null;
}

function normalizeActivityFromTokens(tokens) {
  const joined = tokens.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return "n/a";

  // Direct Online variants first
  if (/\bonline\b/i.test(joined)) return "Online";
  if (/(^|\s)(on|0n|onl|0nl|onli|0nli)(\s|$)/i.test(joined)) return "Online";

  // Fix super common OCR: "Sh." meaning "5h" (do this BEFORE the letters-only fallback)
  const fixed = joined
    .replace(/\b[Ss]\s*h\.?\b/g, "5h")
    .replace(/\b[Ss]h\.?\b/g, "5h");

  // Time like 7h / 13 h. / 5 m. / 1 d.
  const m = fixed.match(/\b(\d{1,2})\s*([mhd])\.?\b/i);
  if (m) return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;

  // Letters-only fallback: OCR often turns Online into "SE", "SEE", "TERN", etc.
  const alpha = fixed.replace(/[^A-Za-z]/g, "");
  if (alpha.length >= 2 && alpha.length <= 10) return "Online";

  return "n/a";
}

function cleanName(words) {
  let s = words.join(" ")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/[|]/g, " ")
    .replace(/[@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip leading bullets/junk symbols
  s = s.replace(/^[^\w]+/g, "").trim();

  // Strip row index patterns: "3) Name", "3. Name", "3 - Name", "3: Name"
  s = s.replace(/^\d+\s*[\)\.\:\-—–]\s*/g, "");

  // Strip plain "3 Name"
  s = s.replace(/^\d+\s+/g, "");

  // Drop leading 1–2 letter junk tokens (OCR noise like "bo", "a", "z", "bh")
  let toks = s.split(/\s+/).filter(Boolean);
  while (toks.length && /^[A-Za-z]{1,2}$/.test(toks[0])) toks.shift();
  s = toks.join(" ");

  return s.trim();
}

// PATCH: drop 1–2 letter junk like Ey/Wy/NF + fix Donn/Boss OCR typos
function cleanRank(words) {
  const s = words.join(" ")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let cleaned = s
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Drop 1–2 letter junk tokens (badge/icon noise)
  cleaned = cleaned
    .split(" ")
    .filter(t => t.length >= 3)
    .join(" ")
    .trim();

  // Fix common OCR glitches
  cleaned = cleaned
    .replace(/\bPONN\b/g, "DONN")
    .replace(/\bPON\b/g, "DONN")
    .replace(/\bSOSS\b/g, "BOSS")
    .replace(/\bB0SS\b/g, "BOSS")
    .replace(/\bG0DFATHER\b/g, "GODFATHER");

  return titleCase(cleaned);
}

function rowsToCsv(rows) {
  const header = "name,lvl,rank,honor,activity";
  const lines = [header];
  for (const r of rows) {
    const q = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    lines.push([q(r.name), r.lvl, q(r.rank), r.honor, q(r.activity)].join(","));
  }
  return lines.join("\n");
}

// Simple Levenshtein for rank matching
function levenshtein(a, b) {
  a = (a || ""); b = (b || "");
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

function bestRankMatch(rankText, rankList) {
  const raw = (rankText || "").trim();
  if (!raw || !rankList?.length) return raw;

  const a = raw.toLowerCase().replace(/\s+/g, "");
  let best = null;
  let bestScore = Infinity;

  for (const r of rankList) {
    const b = r.toLowerCase().replace(/\s+/g, "");
    if (!b) continue;
    const d = levenshtein(a, b);
    if (d < bestScore) {
      bestScore = d;
      best = r;
    }
  }

  // Snap only if reasonably close
  if (best && bestScore <= 3) return best;
  return raw;
}

const DEFAULT_RANKS = [
  "Gang Leader",
  "Deputy",
  "Cutthroat",
  "Fighter",
  "Trainee",
  "Newbie",
  "Boss",
  "Donn",
  "Godfather",
  "Top Executives",
  "Generals",
  "Top Shooters",
  "Foot Soldiers",
];

function getRankList() {
  const user = (ranksEl?.value || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  // merge + de-dupe (case-insensitive)
  const seen = new Set();
  const out = [];
  for (const r of [...user, ...DEFAULT_RANKS]) {
    const k = r.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ---------------------------
// Preprocess
// ---------------------------
function preprocessCanvas(srcCanvas) {
  const scale = 2.2; // slightly lower helps avoid turning 6->8 sometimes
  const w = Math.max(1, Math.floor(srcCanvas.width * scale));
  const h = Math.max(1, Math.floor(srcCanvas.height * scale));

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;

  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  // Compute mean luminance for threshold
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = (r * 0.299 + g * 0.587 + b * 0.114);
    sum += y;
  }
  const mean = sum / (data.length / 4);
  const thr = Math.min(230, Math.max(120, mean - 18));

  // Binarize, but FORCE green-ish pixels (Online) to black so OCR sees them
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const isGreenText = (g > r + 25) && (g > b + 25) && (g > 90);

    const y = (r * 0.299 + g * 0.587 + b * 0.114);
    const v = (isGreenText || y < thr) ? 0 : 255;

    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return out;
}

// ---------------------------
// Word-box parsing
// ---------------------------
function normalizeWord(w) {
  const text = String(w.text || "").trim();
  if (!text) return null;

  const x0 = w.bbox?.x0 ?? w.x0 ?? 0;
  const x1 = w.bbox?.x1 ?? w.x1 ?? 0;
  const y0 = w.bbox?.y0 ?? w.y0 ?? 0;
  const y1 = w.bbox?.y1 ?? w.y1 ?? 0;

  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  const conf = (typeof w.confidence === "number") ? w.confidence : 100;
  return { text, x0, x1, y0, y1, cx, cy, conf };
}

function groupIntoRows(wordBoxes) {
  const words = wordBoxes
    .filter(w => w && w.text && w.conf >= 25)
    .slice()
    .sort((a, b) => a.cy - b.cy);

  if (!words.length) return [];

  const heights = words.map(w => Math.max(1, w.y1 - w.y0)).sort((a, b) => a - b);
  const mid = Math.floor(heights.length / 2);
  const median = heights.length % 2 === 0
    ? (heights[mid - 1] + heights[mid]) / 2
    : heights[mid];
  const threshold = Math.max(8, median * 0.7);

  const rows = [];
  for (const w of words) {
    const last = rows[rows.length - 1];
    if (!last) {
      rows.push({ cy: w.cy, words: [w] });
      continue;
    }

    if (Math.abs(w.cy - last.cy) <= threshold) {
      last.words.push(w);
      last.cy = (last.cy * (last.words.length - 1) + w.cy) / last.words.length;
    } else {
      rows.push({ cy: w.cy, words: [w] });
    }
  }

  return rows;
}

function findRowBandsFromCanvas(binCanvas) {
  const ctx = binCanvas.getContext("2d", { willReadFrequently: true });
  const w = binCanvas.width;
  const h = binCanvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;

  // blackFrac[y] = fraction of black pixels on that scanline
  const blackFrac = new Float32Array(h);

  for (let y = 0; y < h; y++) {
    let black = 0;
    const rowStart = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowStart + x * 4;
      // binarized: black is 0
      if (data[i] < 30) black++;
    }
    blackFrac[y] = black / w;
  }

  // Smooth it
  const smooth = new Float32Array(h);
  const win = 5;
  for (let y = 0; y < h; y++) {
    let s = 0;
    let c = 0;
    for (let k = -win; k <= win; k++) {
      const yy = y + k;
      if (yy < 0 || yy >= h) continue;
      s += blackFrac[yy];
      c++;
    }
    smooth[y] = s / c;
  }

  // Find "line" bands: contiguous y where smooth[y] is high
  const lineThreshold = 0.35; // row dividers are strong black spans
  const lineYs = [];
  let inBand = false;
  let bandStart = 0;

  for (let y = 0; y < h; y++) {
    const isLine = smooth[y] >= lineThreshold;
    if (isLine && !inBand) {
      inBand = true;
      bandStart = y;
    } else if (!isLine && inBand) {
      inBand = false;
      const bandEnd = y - 1;
      const center = Math.floor((bandStart + bandEnd) / 2);
      lineYs.push(center);
    }
  }
  if (inBand) {
    const center = Math.floor((bandStart + (h - 1)) / 2);
    lineYs.push(center);
  }

  // Build row bands between lines.
  // Add top & bottom guards.
  const cuts = [0, ...lineYs, h];
  cuts.sort((a, b) => a - b);

  const bands = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const y0 = cuts[i];
    const y1 = cuts[i + 1];
    const height = y1 - y0;

    // Filter out tiny bands (noise / header separators)
    if (height < Math.max(18, h * 0.04)) continue;

    bands.push({ y0, y1 });
  }

  return bands;
}

function parseRowsFromWordBoxes(wordBoxes, canvasWidth, rowBands) {
  const rankList = getRankList();

  // Fixed columns by percentage (stable even if header OCR shifts)
  const X = {
    nameRight: canvasWidth * 0.40,
    lvlLeft: canvasWidth * 0.40,
    lvlRight: canvasWidth * 0.52,
    rankLeft: canvasWidth * 0.52,
    rankRight: canvasWidth * 0.68,
    honorLeft: canvasWidth * 0.62,
    honorRight: canvasWidth * 0.88,
    activityLeft: canvasWidth * 0.84,
  };

  const out = [];

  for (const band of rowBands) {
    const w = wordBoxes
      .filter(x => x.cy >= band.y0 && x.cy <= band.y1)
      .filter(x => x && x.text && x.conf >= 25)
      .sort((a, b) => a.cx - b.cx);

    if (!w.length) continue;

    const line = w.map(x => x.text).join(" ").toLowerCase();
    const looksLikeHeader = /(members|lvl|member\s*ranks|honor|points|activity)/i.test(line);

    // Name
    const nameWords = w.filter(x => x.cx < X.nameRight).map(x => x.text);
    const name = cleanName(nameWords);
    if (!name || name.length < 2) continue;

    // LVL (digits only inside lvl band)
    const lvlCandidates = w
      .filter(x => x.cx >= X.lvlLeft && x.cx <= X.lvlRight)
      .map(x => digitsOnly(x.text))
      .filter(n => n !== null && n >= 1 && n <= 99);

    if (looksLikeHeader && !lvlCandidates.length) continue;
    if (!lvlCandidates.length) continue;
    const lvl = lvlCandidates[0];

    // Rank (letters inside rank band)
    const rankWords = w
      .filter(x => x.cx >= X.rankLeft && x.cx <= X.rankRight)
      .filter(x => /[A-Za-z]/.test(x.text))
      .map(x => x.text);

    let rank = cleanRank(rankWords);
    rank = bestRankMatch(rank, rankList);

    // Honor (stitch split numbers, take max)
    const honorTokens = w
      .filter(x => x.cx >= X.honorLeft && x.cx <= X.honorRight)
      .map(x => {
        const d = String(x.text || "").replace(/[^\d]/g, "");
        return d ? { cx: x.cx, d } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.cx - b.cx);

    const singleVals = honorTokens
      .map(t => (t.d.length >= 3 ? parseInt(t.d, 10) : null))
      .filter(v => v !== null);

    const stitchedVals = [];
    for (let i = 0; i < honorTokens.length - 1; i++) {
      const cur = honorTokens[i].d;
      const nxt = honorTokens[i + 1].d;
      const dx = honorTokens[i + 1].cx - honorTokens[i].cx;

      if (cur.length <= 2 && nxt.length === 3 && dx <= canvasWidth * 0.08) {
        stitchedVals.push(parseInt(cur + nxt, 10));
      }
    }

    const honor = Math.max(0, ...(singleVals.length ? singleVals : [0]), ...stitchedVals);

    // Activity (right side)
    const activityTokens = w
      .filter(x => x.cx >= X.activityLeft)
      .map(x => x.text);

    const activity = normalizeActivityFromTokens(activityTokens);

    out.push({ name, lvl, rank: rank || "", honor, activity });
  }

  // De-dup by name (best for your use case)
  const map = new Map();
  for (const r of out) {
    const k = (r.name || "").toLowerCase().trim();
    if (!k) continue;

    if (!map.has(k)) map.set(k, r);
    else {
      const prev = map.get(k);
      prev.honor = Math.max(prev.honor || 0, r.honor || 0);
      if (r.activity && r.activity !== "n/a") prev.activity = r.activity;
      if (r.rank && r.rank.trim()) prev.rank = r.rank;
      prev.lvl = r.lvl ?? prev.lvl;
    }
  }

  return Array.from(map.values());
}

// ---------------------------
// OCR
// ---------------------------
async function doOCR(canvas) {
  setStatus("OCR running…");
  const { data } = await Tesseract.recognize(canvas, "eng", {
    logger: (m) => {
      if (m.status) {
        const pct = m.progress ? ` (${Math.round(m.progress * 100)}%)` : "";
        setStatus(`${m.status}${pct}`);
      }
    },
  });
  return data;
}

// ---------------------------
// Ranks persistence
// ---------------------------
function loadRanks() {
  if (!ranksEl) return;
  const saved = localStorage.getItem("osrp_ranks") || "";

  const defaults = DEFAULT_RANKS.join("\n");

  if (saved.trim()) {
    ranksEl.value = saved.trim();
  } else if (!ranksEl.value.trim()) {
    ranksEl.value = defaults;
  }
}

function saveRanks() {
  if (!ranksEl) return;
  try {
    localStorage.setItem("osrp_ranks", (ranksEl.value || "").trim());
    setStatus("Ranks saved.");
  } catch (e) {
    console.error("localStorage blocked:", e);
    setStatus("Ranks NOT saved (browser blocked storage / private mode).");
  }
}

if (saveRanksBtn) saveRanksBtn.addEventListener("click", saveRanks);
loadRanks();

// ---------------------------
// CSV download
// ---------------------------
function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

downloadBtn?.addEventListener("click", () => {
  const csv = (csvEl.value || "").trim();
  if (!csv) {
    alert("No CSV to download.");
    return;
  }
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  downloadCsv(`members_${yyyy}-${mm}-${dd}.csv`, csv);
});

// ---------------------------
// UI wiring
// ---------------------------
if (appendBtn) {
  appendBtn.addEventListener("click", () => {
    appendMode = true;
    fileEl.click();
  });
}

fileEl.addEventListener("change", () => {
  const f = fileEl.files && fileEl.files[0];
  if (!f) return;

  if (!appendMode) {
    csvEl.value = "";
    rawEl.value = "";
    allRows = [];
    allRawBlocks = [];
  } else {
    setStatus("Appending image… crop and Extract to add rows.");
  }

  if (cropper) { cropper.destroy(); cropper = null; }
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);

  currentObjectUrl = URL.createObjectURL(f);
  imgEl.src = currentObjectUrl;
  imgEl.style.display = "block";
  setStatus("Image loaded. Crop to the table, then Extract.");

  imgEl.onload = () => {
    cropper = new Cropper(imgEl, {
      viewMode: 1,
      autoCropArea: 0.85,
      movable: true,
      zoomable: true,
      rotatable: false,
      scalable: false,
      responsive: true,
      background: false,
    });

    extractBtn.disabled = false;
    clearBtn.disabled = false;
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
    if (appendBtn) appendBtn.disabled = false;
  };
});

extractBtn.addEventListener("click", async () => {
  if (!cropper) return;

  extractBtn.disabled = true;
  copyBtn.disabled = true;
  downloadBtn.disabled = true;

  try {
    setStatus("Preparing crop…");
    const cropped = cropper.getCroppedCanvas({
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
    });

    const preText = preprocessForText(cropped);

    const data = await recognizeCanvas(preText, {
      logger: (m) => {
        if (m.status) {
          const pct = m.progress ? ` (${Math.round(m.progress * 100)}%)` : "";
          setStatus(`${m.status}${pct}`);
        }
      },
    });

    const rawBlock = (data.text || "").trim();
    if (appendMode) {
      if (rawBlock) allRawBlocks.push(rawBlock);
      rawEl.value = allRawBlocks.join("\n\n---\n\n");
    } else {
      allRawBlocks = rawBlock ? [rawBlock] : [];
      rawEl.value = rawBlock;
    }

    const wordBoxes = (data.words || []).map(normalizeWord).filter(Boolean);
    if (!wordBoxes.length) {
      setStatus("No OCR words found. Try a cleaner screenshot.");
      return;
    }

    const grouped = groupIntoRows(wordBoxes);
    if (!grouped.length) {
      setStatus("No rows detected. Crop tighter around the table.");
      return;
    }

    const W = cropped.width;
    const H = cropped.height;

    const COL = {
      nameL: 0.08,
      nameR: 0.43,
      lvlL: 0.43,
      lvlR: 0.52,
      rankL: 0.52,
      rankR: 0.70,
      honorL: 0.70,
      honorR: 0.87,
      actL: 0.87,
      actR: 0.995,
    };

    const rankList = getRankList();
    const out = [];

    setStatus("Reading rows…");

    for (const row of grouped) {
      const yTop = Math.max(0, Math.min(...row.words.map(w => w.y0)));
      const yBot = Math.min(preText.height, Math.max(...row.words.map(w => w.y1)));
      const line = row.words.map(w => w.text).join(" ").toLowerCase();
      const looksLikeHeader = /(members|lvl|member\s*ranks|honor|points|activity)/i.test(line);
      const hasANameToken = row.words.some(w => w.cx < preText.width * 0.35 && /[A-Za-z]/.test(w.text));
      if (looksLikeHeader && !hasANameToken) continue;

      const nameWords = row.words
        .filter(w => w.cx >= preText.width * COL.nameL && w.cx <= preText.width * COL.nameR)
        .map(w => w.text);

      const name = cleanName(nameWords);
      if (!name || name.length < 2) continue;

      const rankWords = row.words
        .filter(w => w.cx >= preText.width * COL.rankL && w.cx <= preText.width * COL.rankR)
        .filter(w => /[A-Za-z]/.test(w.text))
        .map(w => w.text);

      let rank = cleanRank(rankWords);
      rank = bestRankMatch(rank, rankList);

      const yScale = cropped.height / preText.height;
      const cyTop = Math.floor(yTop * yScale);
      const cyBot = Math.ceil(yBot * yScale);
      const padY = Math.floor((cyBot - cyTop) * 0.15);
      const rTop = clamp(cyTop - padY, 0, H - 1);
      const rBot = clamp(cyBot + padY, rTop + 1, H);
      const rowHeight = rBot - rTop;

      async function ocrCell(xL, xR, mode) {
        const x = Math.floor(W * xL);
        const w = Math.max(2, Math.floor(W * xR) - x);
        const cell = cropCanvas(cropped, x, rTop, w, rowHeight);

        if (mode === "digits") {
          const pre = preprocessForDigits(cell);
          const d = await recognizeCanvas(pre, { whitelist: "0123456789" });
          return (d.text || "").trim();
        }

        const pre = preprocessForText(cell);
        const d = await recognizeCanvas(pre, {
          whitelist: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.mhdONonli ",
        });
        return (d.text || "").trim();
      }

      const lvlText = await ocrCell(COL.lvlL, COL.lvlR, "digits");
      const honorText = await ocrCell(COL.honorL, COL.honorR, "digits");
      const actText = await ocrCell(COL.actL, COL.actR, "text");

      const lvl = parseFirstInt(lvlText);
      if (!lvl || lvl < 1 || lvl > 99) continue;

      const honor = parseHonorInt(honorText);
      const activity = parseActivity(actText);

      out.push({ name, lvl, rank: rank || "", honor, activity });
    }

    const map = new Map();
    for (const r of out) {
      const k = (r.name || "").toLowerCase().trim();
      if (!k) continue;
      if (!map.has(k)) map.set(k, r);
      else {
        const prev = map.get(k);
        prev.honor = Math.max(prev.honor || 0, r.honor || 0);
        prev.activity = (r.activity && r.activity !== "n/a") ? r.activity : prev.activity;
        prev.rank = (r.rank && r.rank.trim()) ? r.rank : prev.rank;
        prev.lvl = r.lvl ?? prev.lvl;
      }
    }

    const rows = Array.from(map.values());
    if (!rows.length) {
      setStatus("No rows detected. Crop tighter around ONLY the rows and try again.");
      return;
    }

    if (appendMode) {
      const merged = new Map(allRows.map(r => [(r.name || "").toLowerCase().trim(), r]));
      for (const r of rows) merged.set((r.name || "").toLowerCase().trim(), r);
      allRows = Array.from(merged.values());
    } else {
      allRows = rows.slice();
    }

    csvEl.value = rowsToCsv(allRows);
    setStatus(`Total ${allRows.length} row(s) in CSV. ${appendMode ? "Appended." : "Extracted."}`);
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
    appendMode = false;
  } catch (e) {
    console.error(e);
    setStatus("OCR failed. Try cropping tighter or use a clearer screenshot.");
  } finally {
    extractBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", async () => {
  const text = (csvEl.value || "").trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("CSV copied to clipboard.");
});

clearBtn.addEventListener("click", () => {
  fileEl.value = "";
  cleanupImage();
});

cleanupImage();
