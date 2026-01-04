// OSRP Gang Scanner -> CSV (mobile-stable v18)
// Key changes:
// - ONE Tesseract worker only (no Tesseract.recognize())
// - Row detection from horizontal divider lines (less crop sensitivity)
// - "Online" detected by green pixels (OCR-independent)
// - Otsu threshold for digits (reduces 6->8 flips)
// - Auto-detect table start even if menu leaks into crop

const BUILD = "v18";
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

const ranksEl = document.getElementById("ranks") || document.getElementById("gangRanks");
const saveRanksBtn = document.getElementById("saveRanksBtn");

let cropper = null;
let currentObjectUrl = null;
let appendMode = false;
let allRows = [];
let allRawBlocks = [];

function setStatus(t) {
  statusEl.textContent = t;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function cleanupImage() {
  if (cropper) {
    cropper.destroy();
    cropper = null;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
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
// Text helpers
// ---------------------------
function titleCase(s) {
  return (s || "")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function cleanName(words) {
  let s = words
    .join(" ")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  s = s.replace(/^[^\w]+/g, "").trim();
  s = s.replace(/^\d+\s*[\)\.\:\-—–]\s*/g, "");
  s = s.replace(/^[A-Za-z]{1,2}\s*[\)\.\:\-—–]\s*/g, "");
  s = s.replace(/^\d+\s+/g, "");
  return s.trim();
}

function cleanRank(words) {
  const s = words
    .join(" ")
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

  cleaned = cleaned.split(" ").filter(t => t.length >= 3).join(" ").trim();

  cleaned = cleaned
    .replace(/\bPONN\b/g, "DONN")
    .replace(/\bPON\b/g, "DONN")
    .replace(/\bSOSS\b/g, "BOSS")
    .replace(/\bB0SS\b/g, "BOSS")
    .replace(/\bG0DFATHER\b/g, "GODFATHER");

  return titleCase(cleaned);
}

function digitsOnly(token) {
  const s = String(token || "").trim();
  if (!s) return null;
  if (/[A-Za-z]/.test(s)) return null;
  const d = s.replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : null;
}

function levenshtein(a, b) {
  a = a || "";
  b = b || "";
  const m = a.length;
  const n = b.length;
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

function isOnlineLike(text) {
  const t = String(text || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return false;
  if (t.includes("online")) return true;
  // common OCR: orline / onl1ne / onlinc / onlne / orlne
  const d = levenshtein(t, "online");
  return d <= 2;
}

function normalizeActivityFromTokens(tokens) {
  const joined = tokens.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return "n/a";

  if (/\bonline\b/i.test(joined)) return "Online";
  if (isOnlineLike(joined)) return "Online";

  const fixed = joined
    .replace(/\b[Ss]\s*h\.?\b/g, "5h")
    .replace(/\b[Ss]h\.?\b/g, "5h");

  const m = fixed.match(/\b(\d{1,2})\s*([mhd])\.?\b/i);
  if (m) return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;

  // If OCR splits "Or" "ine"
  const alpha = fixed.replace(/[^A-Za-z]/g, "");
  if (alpha.length >= 4 && alpha.length <= 10 && isOnlineLike(alpha)) return "Online";

  return "n/a";
}

function rowsToCsv(rows) {
  const header = "name,lvl,rank,honor,activity";
  const lines = [header];
  for (const r of rows) {
    const q = v => `"${String(v ?? "").replaceAll('"', '""')}"`;
    lines.push([q(r.name), r.lvl, q(r.rank), r.honor, q(r.activity)].join(","));
  }
  return lines.join("\n");
}

// ---------------------------
// Ranks
// ---------------------------
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
  "Youngan",
];

function getRankList() {
  const user = (ranksEl?.value || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

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
  if (best && bestScore <= 3) return best;
  return raw;
}

function loadRanks() {
  if (!ranksEl) return;
  const saved = localStorage.getItem("osrp_ranks") || "";
  const defaults = DEFAULT_RANKS.join("\n");
  if (saved.trim()) ranksEl.value = saved.trim();
  else if (!ranksEl.value.trim()) ranksEl.value = defaults;
}

function saveRanks() {
  if (!ranksEl) return;
  try {
    localStorage.setItem("osrp_ranks", (ranksEl.value || "").trim());
    setStatus("Ranks saved.");
  } catch (e) {
    console.error(e);
    setStatus("Ranks NOT saved (browser blocked storage / private mode).");
  }
}

if (saveRanksBtn) saveRanksBtn.addEventListener("click", saveRanks);
loadRanks();

// ---------------------------
// Canvas utilities
// ---------------------------
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  return c;
}

function drawCropFromCropper() {
  // Avoid Cropper.getCroppedCanvas() hangs on iPad by doing manual crop.
  // cropper.getData(true) is in the image's natural coordinate space.
  const d = cropper.getData(true);
  const sx = Math.max(0, d.x);
  const sy = Math.max(0, d.y);
  const sw = Math.max(1, d.width);
  const sh = Math.max(1, d.height);

  const out = makeCanvas(sw, sh);
  const ctx = out.getContext("2d");
  ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

function resizeForOCR(srcCanvas) {
  // Keep iPad Safari stable (limit pixels)
  const MAX_W = 1400;
  const MAX_H = 900;
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const scale = Math.min(MAX_W / sw, MAX_H / sh, 1);
  const w = Math.max(1, Math.floor(sw * scale));
  const h = Math.max(1, Math.floor(sh * scale));
  const out = makeCanvas(w, h);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return out;
}

function toGrayscaleCanvas(srcCanvas, contrast = 1.25) {
  const out = makeCanvas(srcCanvas.width, srcCanvas.height);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(srcCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const v = clamp((y - 128) * contrast + 128, 0, 255);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function otsuThreshold(grayCanvas) {
  const ctx = grayCanvas.getContext("2d", { willReadFrequently: true });
  const { width: w, height: h } = grayCanvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;

  const total = w * h;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let varMax = 0;
  let threshold = 140;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) {
      varMax = varBetween;
      threshold = t;
    }
  }
  return clamp(threshold, 90, 210);
}

function binarizeWithOtsu(grayCanvas) {
  const out = makeCanvas(grayCanvas.width, grayCanvas.height);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(grayCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const thr = otsuThreshold(grayCanvas);
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function cropCanvas(src, x, y, w, h) {
  const out = makeCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.drawImage(src, x, y, w, h, 0, 0, out.width, out.height);
  return out;
}

// ---------------------------
// Green "Online" detector (OCR-independent)
// ---------------------------
function greenOnlineInRect(srcCanvas, x, y, w, h) {
  x = clamp(x, 0, srcCanvas.width - 1);
  y = clamp(y, 0, srcCanvas.height - 1);
  w = clamp(w, 1, srcCanvas.width - x);
  h = clamp(h, 1, srcCanvas.height - y);

  const ctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(x, y, w, h).data;

  let greenCount = 0;
  let total = 0;

  // Sample every 2px to keep it fast on iPad
  const stride = 8; // 2px * 4 channels
  for (let i = 0; i < data.length; i += stride) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    total++;
    // bright-ish green and clearly greener than red/blue
    if (g > 130 && g > r + 35 && g > b + 35) greenCount++;
  }

  const frac = total ? greenCount / total : 0;
  return frac > 0.012; // tuned for your screenshots
}

// ---------------------------
// Tesseract worker (single pipeline)
// ---------------------------
let _worker = null;
let _busy = false;

async function getWorker(logger) {
  if (_worker) return _worker;
  const w = await Tesseract.createWorker({ logger });
  await w.load();
  await w.loadLanguage("eng");
  await w.initialize("eng");
  // stable defaults
  await w.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "6",
  });
  _worker = w;
  return _worker;
}

async function recognize(canvas, params = {}, logger = null) {
  const worker = await getWorker(logger);
  while (_busy) await new Promise(r => setTimeout(r, 20));
  _busy = true;
  try {
    await worker.setParameters(params);
    const res = await worker.recognize(canvas);
    return res.data;
  } finally {
    _busy = false;
  }
}

// ---------------------------
// Word-box + row parsing
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

  const conf = typeof w.confidence === "number" ? w.confidence : 100;
  return { text, x0, x1, y0, y1, cx, cy, conf };
}

function detectTableStartX(words, canvasWidth) {
  // If the left menu leaks into crop, find the biggest gap in x-centers
  // and treat right side as table start (works well on your screenshots).
  const xs = words
    .filter(w => w.conf >= 25 && w.text && /[A-Za-z0-9]/.test(w.text))
    .map(w => w.cx)
    .sort((a, b) => a - b);

  if (xs.length < 20) return 0;

  let bestGap = 0;
  let bestAt = 0;

  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    // ignore far-right whitespace gaps
    if (xs[i] > canvasWidth * 0.55) continue;
    if (gap > bestGap) {
      bestGap = gap;
      bestAt = xs[i];
    }
  }

  if (bestGap > canvasWidth * 0.08) {
    return clamp(bestAt - canvasWidth * 0.01, 0, canvasWidth * 0.5);
  }
  return 0;
}

function findRowBands(binCanvas, xStart, xEnd) {
  const ctx = binCanvas.getContext("2d", { willReadFrequently: true });
  const W = binCanvas.width;
  const H = binCanvas.height;
  xStart = clamp(Math.floor(xStart), 0, W - 1);
  xEnd = clamp(Math.floor(xEnd), xStart + 1, W);

  const img = ctx.getImageData(xStart, 0, xEnd - xStart, H).data;
  const sliceW = xEnd - xStart;

  const blackFrac = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let black = 0;
    const rowStart = y * sliceW * 4;
    for (let x = 0; x < sliceW; x++) {
      const i = rowStart + x * 4;
      if (img[i] < 30) black++;
    }
    blackFrac[y] = black / sliceW;
  }

  // smooth
  const smooth = new Float32Array(H);
  const win = 5;
  for (let y = 0; y < H; y++) {
    let s = 0;
    let c = 0;
    for (let k = -win; k <= win; k++) {
      const yy = y + k;
      if (yy < 0 || yy >= H) continue;
      s += blackFrac[yy];
      c++;
    }
    smooth[y] = s / c;
  }

  // detect divider lines
  const lineThreshold = 0.25;
  const lineYs = [];
  let inBand = false;
  let bandStart = 0;
  for (let y = 0; y < H; y++) {
    const isLine = smooth[y] >= lineThreshold;
    if (isLine && !inBand) {
      inBand = true;
      bandStart = y;
    } else if (!isLine && inBand) {
      inBand = false;
      lineYs.push(Math.floor((bandStart + (y - 1)) / 2));
    }
  }
  if (inBand) lineYs.push(Math.floor((bandStart + (H - 1)) / 2));

  // Build row bands between divider lines; filter tiny bands
  const cuts = [0, ...lineYs, H].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const y0 = cuts[i];
    const y1 = cuts[i + 1];
    const h = y1 - y0;
    if (h < Math.max(22, H * 0.05)) continue;
    bands.push({ y0, y1 });
  }
  return bands;
}

function parseHonorFromWords(tokens, canvasWidth) {
  const honorTokens = tokens
    .map(x => {
      const d = String(x.text || "").replace(/[^\d]/g, "");
      return d ? { cx: x.cx, d } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.cx - b.cx);

  const honorCandidates = [];
  for (let i = 0; i < honorTokens.length; i++) {
    const cur = honorTokens[i].d;
    if (cur.length >= 3) honorCandidates.push(parseInt(cur, 10));

    if (cur.length <= 2 && i + 1 < honorTokens.length) {
      const nxt = honorTokens[i + 1].d;
      const dx = honorTokens[i + 1].cx - honorTokens[i].cx;
      if (nxt.length >= 3 && dx <= canvasWidth * 0.08) {
        honorCandidates.push(parseInt(cur + nxt, 10));
      }
    }
  }

  return honorCandidates.length ? Math.max(...honorCandidates) : 0;
}

function parseLvlFromWords(tokens) {
  const nums = tokens
    .map(x => digitsOnly(x.text))
    .filter(n => n !== null && n >= 1 && n <= 99);
  return nums.length ? nums[0] : null;
}

// ---------------------------
// UI / file handling
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
  if (!csv) return alert("No CSV to download.");
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  downloadCsv(`members_${yyyy}-${mm}-${dd}.csv`, csv);
});

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

  if (cropper) {
    cropper.destroy();
    cropper = null;
  }
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
    await new Promise(r => setTimeout(r, 0)); // let UI paint (iPad)

    const cropped = drawCropFromCropper();
    const scaled = resizeForOCR(cropped);

    setStatus("Preprocessing…");
    const gray = toGrayscaleCanvas(scaled, 1.28);
    const bin = binarizeWithOtsu(gray);

    setStatus("OCR…");
    const data = await recognize(
      gray,
      {
        tessedit_pageseg_mode: "6",
        // allow full text/digits
        tessedit_char_whitelist: "",
        preserve_interword_spaces: "1",
      },
      m => {
        if (m?.status) {
          const pct = m.progress ? ` (${Math.round(m.progress * 100)}%)` : "";
          setStatus(`${m.status}${pct}`);
        }
      },
    );

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
      setStatus("No OCR words found. Use a clearer screenshot (send as file, not compressed).");
      return;
    }

    // Auto-detect table start (handles accidental left-menu crop)
    const tableStartX = detectTableStartX(wordBoxes, gray.width);
    const tableEndX = gray.width; // crop should include right side
    const tableWidth = tableEndX - tableStartX;

    // Column layout relative to table area
    const COL = {
      nameR: tableStartX + tableWidth * 0.40,
      lvlL: tableStartX + tableWidth * 0.40,
      lvlR: tableStartX + tableWidth * 0.52,
      rankL: tableStartX + tableWidth * 0.52,
      rankR: tableStartX + tableWidth * 0.70,
      honL: tableStartX + tableWidth * 0.70,
      honR: tableStartX + tableWidth * 0.88,
      actL: tableStartX + tableWidth * 0.86,
      actR: tableStartX + tableWidth * 0.99,
    };

    setStatus("Finding rows…");
    const bands = findRowBands(bin, tableStartX, tableEndX);
    if (!bands.length) {
      setStatus("No rows detected. Crop tighter around the table area and try again.");
      return;
    }

    const rankList = getRankList();
    const out = [];

    setStatus("Reading rows…");
    for (const band of bands) {
      const rowWords = wordBoxes
        .filter(w => w.cy >= band.y0 && w.cy <= band.y1)
        .filter(w => w.conf >= 25)
        .sort((a, b) => a.cx - b.cx);

      if (!rowWords.length) continue;

      const line = rowWords.map(w => w.text).join(" ").toLowerCase();
      if (/(members|lvl|member\s*ranks|honor|points|activity)/i.test(line) && rowWords.length <= 18) continue;

      // Name
      const nameWords = rowWords.filter(w => w.cx >= tableStartX && w.cx <= COL.nameR).map(w => w.text);
      const name = cleanName(nameWords);
      if (!name || name.length < 2) continue;

      // LVL (from words)
      const lvlWords = rowWords.filter(w => w.cx >= COL.lvlL && w.cx <= COL.lvlR);
      const lvl = parseLvlFromWords(lvlWords);
      if (!lvl) continue;

      // Rank
      const rankWords = rowWords
        .filter(w => w.cx >= COL.rankL && w.cx <= COL.rankR)
        .filter(w => /[A-Za-z]/.test(w.text))
        .map(w => w.text);

      let rank = cleanRank(rankWords);
      rank = bestRankMatch(rank, rankList);

      // Honor (from words)
      const honorWords = rowWords.filter(w => w.cx >= COL.honL && w.cx <= COL.honR);
      const honor = parseHonorFromWords(honorWords, gray.width);

      // Activity
      // First: detect green "Online" by pixels (most reliable).
      const y0 = Math.floor(band.y0);
      const y1 = Math.ceil(band.y1);
      const rectX = Math.floor(COL.actL);
      const rectW = Math.floor(Math.max(2, COL.actR - COL.actL));
      const rectH = Math.floor(Math.max(2, y1 - y0));

      let activity = "n/a";
      if (greenOnlineInRect(scaled, rectX, y0, rectW, rectH)) {
        activity = "Online";
      } else {
        const actWords = rowWords.filter(w => w.cx >= COL.actL && w.cx <= COL.actR).map(w => w.text);
        activity = normalizeActivityFromTokens(actWords);
      }

      out.push({ name, lvl, rank: rank || "", honor, activity });
    }

    // De-dup by name
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

    const rows = Array.from(map.values());
    if (!rows.length) {
      setStatus("No rows detected. Crop tighter around ONLY the table and try again.");
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
    setStatus("OCR failed. If it hangs, refresh the page and try again (iPad Safari can get stuck).");
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
