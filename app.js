// OSRP Gang Scanner -> CSV (robust word-box parsing for mobile/desktop)

const fileEl = document.getElementById("file");
const imgEl = document.getElementById("img");
const extractBtn = document.getElementById("extract");
const copyBtn = document.getElementById("copyCsvBtn");
const downloadBtn = document.getElementById("downloadCsvBtn");
const clearBtn = document.getElementById("clear");
const csvEl = document.getElementById("csv");
const rawEl = document.getElementById("raw");
const statusEl = document.getElementById("status");

// Optional ranks UI (if present in your HTML)
const ranksEl = document.getElementById("ranks") || document.getElementById("gangRanks");
const saveRanksBtn = document.getElementById("saveRanks");

let cropper = null;
let currentObjectUrl = null;

function setStatus(t) {
  statusEl.textContent = t;
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
  setStatus("Waiting for image…");
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

function digitsStr(token) {
  const s = String(token || "").trim();
  if (!s) return null;
  // reject icon-junk like "x30", "ty", etc
  if (/[A-Za-z]/.test(s)) return null;

  const d = s.replace(/[^\d]/g, "");
  return d ? d : null; // IMPORTANT: keep leading zeros
}

function digitsInt(token) {
  const d = digitsStr(token);
  return d ? parseInt(d, 10) : null;
}

function normalizeActivityFromTokens(tokens) {
  const joined = tokens.join(" ").trim();
  if (!joined) return "n/a";
  if (/\bonline\b/i.test(joined)) return "Online";
  // mobile OCR often truncates online -> "on" or "0n"
  if (/(^|\s)(on|0n)(\s|$)/i.test(joined)) return "Online";

  // 1h / 2 h. / 5 m. / 1 d.
  const m = joined.match(/\b(\d{1,2})\s*([mhd])\.?\b/i);
  if (m) return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;
  return "n/a";
}

function cleanName(words) {
  const cleaned = (words || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    // drop row index tokens like: "1", "1)", "1.", "1-", "1:"
    .filter((t) => !/^\d+[)\].:,-]?$/.test(t))
    // drop pure bullet / junk tokens
    .filter((t) => !/^[=•\-\u2022]+$/.test(t))
    // strip leading bullet-ish prefixes from remaining tokens
    .map((t) => t.replace(/^[=•\-\u2022]+/g, "").trim())
    .filter(Boolean);

  return cleaned
    .join(" ")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRank(words) {
  const s = words
    .join(" ")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Keep letters/spaces only (badge icons cause junk)
  const cleaned = s.toUpperCase().replace(/[^A-Z\s]/g, " ").replace(/\s+/g, " ").trim();
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

// Simple Levenshtein for rank matching (optional)
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

function bestRankMatch(rankText, rankList) {
  const raw = (rankText || "").trim();
  if (!raw || !rankList?.length) return raw;

  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const a = norm(raw);

  // 1) Substring match first (handles "Ey Gang Leader R")
  for (const r of rankList) {
    const b = norm(r);
    if (b && a.includes(b)) return r;
  }

  let best = null;
  let bestScore = Infinity;

  for (const r of rankList) {
    const b = norm(r);
    if (!b) continue;
    const d = levenshtein(a, b);
    if (d < bestScore) {
      bestScore = d;
      best = r;
    }
  }

  // Only snap if it’s reasonably close
  return best && bestScore <= 3 ? best : raw;
}

function detectRankFromRow(rowWords, rankList) {
  if (!rankList?.length) return "";

  const rowText = rowWords
    .map((w) => String(w.text || ""))
    .join(" ")
    .toLowerCase();

  for (const r of rankList) {
    const rr = String(r || "").trim();
    if (!rr) continue;
    if (rowText.includes(rr.toLowerCase())) return rr;
  }
  return "";
}

function getRankList() {
  if (!ranksEl) return [];
  const lines = (ranksEl.value || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines;
}

// ---------------------------
// Preprocess (helps iPhone a lot)
// ---------------------------
function preprocessCanvas(srcCanvas) {
  // Upscale + threshold in JS (cheap but effective for this UI)
  const scale = 2.5;
  const w = Math.max(1, Math.floor(srcCanvas.width * scale));
  const h = Math.max(1, Math.floor(srcCanvas.height * scale));

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;

  const ctx = out.getContext("2d", { willReadFrequently: true });

  // Upscale
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, w, h);

  // Threshold
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  // Compute mean luminance
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    sum += y;
  }
  const mean = sum / (data.length / 4);

  // Push contrast: make text darker
  const thr = Math.min(215, Math.max(140, mean - 10));

  for (let i = 0; i < data.length; i += 4) {
    const y = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const v = y > thr ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return out;
}

// ---------------------------
// Word-box parsing (the real fix)
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

function groupIntoRows(words, canvasHeight) {
  // Keep decent-confidence words; icons/junk are often low confidence
  const ws = words.filter((w) => w && w.text && w.conf >= 25);

  // Sort by Y
  ws.sort((a, b) => a.cy - b.cy);

  // Estimate row gap from median word height
  const heights = ws.map((w) => Math.max(1, w.y1 - w.y0)).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 18;
  const gap = Math.max(10, Math.min(40, medianH * 0.9));

  const rows = [];
  for (const w of ws) {
    const last = rows[rows.length - 1];
    if (!last) {
      rows.push({ y: w.cy, words: [w] });
      continue;
    }
    if (Math.abs(w.cy - last.y) <= gap) {
      last.words.push(w);
      // update row center
      last.y = (last.y * (last.words.length - 1) + w.cy) / last.words.length;
    } else {
      rows.push({ y: w.cy, words: [w] });
    }
  }

  // Merge tiny rows into nearest (sometimes iPhone makes split row fragments)
  const merged = [];
  for (const r of rows) {
    if (!merged.length) {
      merged.push(r);
      continue;
    }
    const prev = merged[merged.length - 1];
    if (r.words.length <= 2 && Math.abs(r.y - prev.y) <= gap * 1.2) {
      prev.words.push(...r.words);
      prev.y = (prev.y + r.y) / 2;
    } else {
      merged.push(r);
    }
  }

  // Remove obvious header row(s)
  const out = merged.filter((r) => {
    const line = r.words.map((w) => w.text).join(" ").toLowerCase();
    if (
      /(members|lvl|member\s*ranks|honor|points|activity)/i.test(line) &&
      r.words.length <= 12
    ) {
      return false;
    }
    return true;
  });

  // Clean/sort row words by X
  for (const r of out) r.words.sort((a, b) => a.cx - b.cx);

  return out;
}

function findHeaderCenters(words, canvasWidth) {
  const topWords = [...words].sort((a, b) => a.cy - b.cy).slice(0, 160);

  const pick = (regexList) => {
    for (const re of regexList) {
      const hit = topWords.find((w) => re.test(w.text));
      if (hit) return hit.cx;
    }
    return null;
  };

  let lvlCx = pick([/^lvl$/i, /^lv1$/i, /^lv$/i]);
  let honorCx = pick([/^honor$/i, /^points$/i, /^honorpoints$/i, /^honor\s*points$/i]);
  let activityCx = pick([/^activity$/i, /^actlity$/i, /^actlvity$/i, /^act$/i]);

  // Learn from numeric distributions (fixes iPhone drift)
  const nums = words
    .map((w) => ({ w, n: digitsInt(w.text) }))
    .filter((x) => x.n !== null);

  const lvlCandidates = nums
    .filter((x) => x.n >= 1 && x.n <= 99)
    .filter((x) => x.w.cx > canvasWidth * 0.25 && x.w.cx < canvasWidth * 0.6);

  if (lvlCandidates.length >= 4) {
    const xs = lvlCandidates.map((x) => x.w.cx).sort((a, b) => a - b);
    lvlCx = xs[Math.floor(xs.length / 2)];
  }

  const honorCandidates = nums
    .filter((x) => x.n >= 100 || x.n === 0)
    .filter((x) => x.w.cx > canvasWidth * 0.6 && x.w.cx < canvasWidth * 0.92);

  if (honorCandidates.length >= 4) {
    const xs = honorCandidates.map((x) => x.w.cx).sort((a, b) => a - b);
    honorCx = xs[Math.floor(xs.length / 2)];
  }

  return {
    lvlCx: lvlCx ?? canvasWidth * 0.47,
    honorCx: honorCx ?? canvasWidth * 0.8,
    activityCx: activityCx ?? canvasWidth * 0.93,
  };
}

function parseRowsFromWordBoxes(wordBoxes, canvasWidth, canvasHeight) {
  const rows = groupIntoRows(wordBoxes, canvasHeight);
  if (!rows.length) return [];
  const { lvlCx, honorCx } = findHeaderCenters(wordBoxes, canvasWidth);

  // Fixed column bands (fractions of width) — stable across iPhone/desktop
  const COL = {
    name: [0.0, 0.36],
    lvl: [0.36, 0.46],
    rank: [0.46, 0.72],
    honor: [0.72, 0.88],
    act: [0.88, 1.0],
  };

  const rankList = getRankList();
  const out = [];

  const inBand = (w, a, b) => w.cx >= canvasWidth * a && w.cx < canvasWidth * b;

  // Stitch numbers inside a band left->right: "30" + "050" => 30050
  function stitchNumber(wordsInBand) {
    const parts = wordsInBand
      .map((w) => ({ w, d: digitsStr(w.text) }))
      .filter((x) => x.d !== null)
      .sort((a, b) => a.w.cx - b.w.cx);

    if (!parts.length) return null;

    const stitched = parts.map((x) => x.d).join("");
    return stitched ? parseInt(stitched, 10) : null;
  }

  function parseLvl(wordsInBand) {
    const parts = wordsInBand
      .map((w) => ({ w, d: digitsStr(w.text) }))
      .filter((x) => x.d !== null)
      .sort((a, b) => a.w.cx - b.w.cx);

    if (!parts.length) return null;

    // Stitch if it looks like split digits (e.g., "1" + "8")
    if (parts.length >= 2) {
      const stitched = parts.map((x) => x.d).join("");
      const v = stitched ? parseInt(stitched, 10) : null;
      if (v !== null && v >= 0 && v <= 99) return v;
    }

    const v = parseInt(parts[0].d, 10);
    return v >= 0 && v <= 99 ? v : null;
  }

  function normalizeOnline(tokens) {
    const s = tokens.join(" ").trim();
    if (!s) return "n/a";

    // iPhone gives junk like "Onlir", "Onl", "0n"
    if (/\bonl/i.test(s) || /(^|\s)(on|0n)(\s|$)/i.test(s)) return "Online";

    const m = s.match(/\b(\d{1,2})\s*([mhd])\.?\b/i);
    if (m) return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;

    return "n/a";
  }

  for (const row of rows) {
    const w = row.words.slice().sort((a, b) => a.cx - b.cx);

    const nameWords = w.filter((x) => inBand(x, ...COL.name)).map((x) => x.text);
    const lvlBand = canvasWidth * 0.045;
    const lvlWords = w.filter((x) => Math.abs(x.cx - lvlCx) <= lvlBand);
    const honorWords = w.filter((x) => inBand(x, ...COL.honor));
    const actTokens = w.filter((x) => inBand(x, ...COL.act)).map((x) => x.text);

    const name = cleanName(nameWords);
    if (!name || name.length < 2) continue;

    let lvl = parseLvl(lvlWords);
    if (lvl === null) {
      const fb = w
        .map((x) => ({ x, n: digitsInt(x.text) }))
        .filter((z) => z.n !== null && z.n >= 0 && z.n <= 99)
        .sort((a, b) => Math.abs(a.x.cx - lvlCx) - Math.abs(b.x.cx - lvlCx));
      lvl = fb.length ? fb[0].n : null;
    }
    if (lvl === null) continue;

    // HONOR: stitch if present; if OCR missed it (common for zeros) => HONOR = 0
    const honorVal = stitchNumber(honorWords);
    const honor = honorVal === null ? 0 : honorVal;

    // Rank
    const rankWords = w
      .filter((x) => x.cx > lvlCx + canvasWidth * 0.02 && x.cx < honorCx - canvasWidth * 0.04)
      .filter((x) => /[A-Za-z]/.test(x.text))
      .map((x) => x.text);
    let rank = cleanRank(rankWords);
    rank = bestRankMatch(rank, rankList);
    if (!rank) {
      const r2 = detectRankFromRow(w, rankList);
      rank = r2 || "";
    }

    // Activity
    const activity = normalizeOnline(actTokens);

    out.push({ name, lvl, rank: rank || "", honor, activity });
  }

  // De-dup
  const seen = new Set();
  const deduped = [];
  for (const r of out) {
    const k = `${r.name}|${r.lvl}|${r.honor}|${r.activity}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  return deduped;
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
// Optional ranks persistence
// ---------------------------
function loadRanks() {
  if (!ranksEl) return;
  const saved = localStorage.getItem("osrp_ranks") || "";
  if (!ranksEl.value.trim()) ranksEl.value = saved.trim();
}
function saveRanks() {
  if (!ranksEl) return;
  localStorage.setItem("osrp_ranks", (ranksEl.value || "").trim());
  setStatus("Ranks saved.");
}
if (saveRanksBtn) saveRanksBtn.addEventListener("click", saveRanks);
loadRanks();

// ---------------------------
// UI wiring
// ---------------------------
fileEl.addEventListener("change", () => {
  const f = fileEl.files && fileEl.files[0];
  if (!f) return;

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
    csvEl.value = "";
    rawEl.value = "";
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

    const pre = preprocessCanvas(cropped);
    const data = await doOCR(pre);

    rawEl.value = data.text || "";

    // IMPORTANT: use data.words (with bbox) instead of plain text parsing
    const wordBoxes = (data.words || []).map(normalizeWord).filter(Boolean);

    if (!wordBoxes.length) {
      setStatus("No OCR words found. Try a clearer screenshot.");
      return;
    }

    const rows = parseRowsFromWordBoxes(wordBoxes, pre.width, pre.height);
    if (!rows.length) {
      setStatus("No rows detected. Crop tighter around ONLY the rows and try again.");
      return;
    }

    csvEl.value = rowsToCsv(rows);
    setStatus(`Extracted ${rows.length} row(s). Review CSV then Copy/Download.`);
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
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
