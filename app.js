// OSRP Gang Scanner -> CSV (robust word-box parsing for mobile/desktop)
// Drop-in app.js

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
  setStatus("Waiting for image…");
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
  const joined = tokens.join(" ").trim();
  if (!joined) return "n/a";
  if (/\bonline\b/i.test(joined)) return "Online";
  if (/(^|\s)(on|0n)(\s|$)/i.test(joined)) return "Online"; // mobile truncation

  const m = joined.match(/\b(\d{1,2})\s*([mhd])\.?\b/i);
  if (m) return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;
  return "n/a";
}

function cleanName(words) {
  const s = words.join(" ")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return s.replace(/^[^\w]+/g, "").replace(/^\d+\s+/, "").trim();
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

  // Drop 1–2 letter junk tokens (badge/icon noise: EY/WY/NF/NL/UW/RY/etc)
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
// Preprocess (helps iPhone a lot)
// ---------------------------
function preprocessCanvas(srcCanvas) {
  const scale = 2.5;
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

  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    sum += y;
  }
  const mean = sum / (data.length / 4);
  const thr = Math.min(215, Math.max(140, mean - 10));

  for (let i = 0; i < data.length; i += 4) {
    const y = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
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

  const conf = (typeof w.confidence === "number") ? w.confidence : 100;
  return { text, x0, x1, y0, y1, cx, cy, conf };
}

function groupIntoRows(words) {
  const ws = words.filter(w => w && w.text && w.conf >= 25);
  ws.sort((a, b) => a.cy - b.cy);

  const heights = ws.map(w => Math.max(1, w.y1 - w.y0)).sort((a, b) => a - b);
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
      last.y = (last.y * (last.words.length - 1) + w.cy) / last.words.length;
    } else {
      rows.push({ y: w.cy, words: [w] });
    }
  }

  // Merge tiny rows into nearest
  const merged = [];
  for (const r of rows) {
    if (!merged.length) { merged.push(r); continue; }
    const prev = merged[merged.length - 1];
    if (r.words.length <= 2 && Math.abs(r.y - prev.y) <= gap * 1.2) {
      prev.words.push(...r.words);
      prev.y = (prev.y + r.y) / 2;
    } else {
      merged.push(r);
    }
  }

  // Remove obvious header row(s)
  const out = merged.filter(r => {
    const line = r.words.map(w => w.text).join(" ").toLowerCase();
    if (/(members|lvl|member\s*ranks|honor|points|activity)/i.test(line) && r.words.length <= 14) {
      return false;
    }
    return true;
  });

  for (const r of out) r.words.sort((a, b) => a.cx - b.cx);
  return out;
}

// PATCH: learn Activity column like LVL/HONOR
function findHeaderCenters(words, canvasWidth) {
  const topWords = [...words].sort((a, b) => a.cy - b.cy).slice(0, 160);

  const pick = (regexList) => {
    for (const re of regexList) {
      const hit = topWords.find(w => re.test(w.text));
      if (hit) return hit.cx;
    }
    return null;
  };

  let lvlCx = pick([/^lvl$/i, /^lv1$/i, /^lv$/i]);
  let honorCx = pick([/^honor$/i, /^points$/i, /^honorpoints$/i, /^honor\s*points$/i]);
  let activityCx = pick([/^activity$/i, /^actlity$/i, /^actlvity$/i, /^act$/i]);

  const nums = words
    .map(w => ({ w, n: digitsOnly(w.text) }))
    .filter(x => x.n !== null);

  const lvlCandidates = nums
    .filter(x => x.n >= 1 && x.n <= 99)
    .filter(x => x.w.cx > canvasWidth * 0.25 && x.w.cx < canvasWidth * 0.60);

  if (lvlCandidates.length >= 4) {
    const xs = lvlCandidates.map(x => x.w.cx).sort((a, b) => a - b);
    lvlCx = xs[Math.floor(xs.length / 2)];
  }

  const honorCandidates = nums
    .filter(x => (x.n >= 100) || x.n === 0)
    .filter(x => x.w.cx > canvasWidth * 0.60 && x.w.cx < canvasWidth * 0.92);

  if (honorCandidates.length >= 4) {
    const xs = honorCandidates.map(x => x.w.cx).sort((a, b) => a - b);
    honorCx = xs[Math.floor(xs.length / 2)];
  }

  const activityCandidates = words
    .filter(w =>
      /\bonline\b/i.test(w.text) ||
      /^(on|0n)$/i.test(w.text.trim()) ||
      /\b\d{1,2}\s*[mhd]\.?\b/i.test(w.text)
    )
    .filter(w => w.cx > canvasWidth * 0.70);

  if (activityCandidates.length >= 3) {
    const xs = activityCandidates.map(w => w.cx).sort((a, b) => a - b);
    activityCx = xs[Math.floor(xs.length / 2)];
  }

  return {
    lvlCx: lvlCx ?? canvasWidth * 0.47,
    honorCx: honorCx ?? canvasWidth * 0.80,
    activityCx: activityCx ?? canvasWidth * 0.93,
  };
}

function parseRowsFromWordBoxes(wordBoxes, canvasWidth) {
  const rows = groupIntoRows(wordBoxes);
  if (!rows.length) return [];

  const { lvlCx, honorCx, activityCx } = findHeaderCenters(wordBoxes, canvasWidth);
  const rankList = getRankList();

  const out = [];

  for (const row of rows) {
    const w = row.words;

    // LVL: choose best numeric token near lvlCx (distance + confidence weighted)
    const lvlBand = canvasWidth * 0.08;
    const lvlCandidates = w
      .map(x => ({ x, n: digitsOnly(x.text) }))
      .filter(z => z.n !== null && z.n >= 1 && z.n <= 99)
      .filter(z => Math.abs(z.x.cx - lvlCx) <= lvlBand);

    if (!lvlCandidates.length) continue;

    lvlCandidates.sort((a, b) => {
      const da = Math.abs(a.x.cx - lvlCx) / lvlBand;
      const db = Math.abs(b.x.cx - lvlCx) / lvlBand;

      const ca = 1 - (Math.max(0, Math.min(100, a.x.conf)) / 100);
      const cb = 1 - (Math.max(0, Math.min(100, b.x.conf)) / 100);

      // distance matters, but low confidence gets penalized
      const scoreA = da * 0.65 + ca * 0.35;
      const scoreB = db * 0.65 + cb * 0.35;
      return scoreA - scoreB;
    });

    const lvl = lvlCandidates[0].n;

    // HONOR: stitch digit chunks in the honor region (capture "133" + "040" => 133040)
    const honorLeft = honorCx - canvasWidth * 0.22;
    const honorRight = activityCx - canvasWidth * 0.10;

    const honorTokens = w
      .filter(x => x.cx >= honorLeft && x.cx <= honorRight)
      .map(x => ({ x, n: digitsOnly(x.text) }))
      .filter(z => z.n !== null)
      .sort((a, b) => a.x.cx - b.x.cx);

    let honor = 0;
    if (honorTokens.length >= 2) {
      const stitched = honorTokens.map(z => String(z.n)).join("");
      honor = stitched ? parseInt(stitched, 10) : 0;
    } else if (honorTokens.length === 1) {
      honor = honorTokens[0].n;
    } else {
      honor = 0;
    }

    // Name: everything clearly left of lvl column
    const nameWords = w
      .filter(x => x.cx < (lvlCx - canvasWidth * 0.06))
      .map(x => x.text);

    const name = cleanName(nameWords);
    if (!name || name.length < 2) continue;

    // Rank: between lvl and honor, only letter-ish tokens
    const rankWords = w
      .filter(x => x.cx > (lvlCx + canvasWidth * 0.03) && x.cx < (honorCx - canvasWidth * 0.06))
      .filter(x => /[A-Za-z]/.test(x.text))
      .map(x => x.text);

    let rank = cleanRank(rankWords);
    rank = bestRankMatch(rank, rankList);

    // Activity: far-right tokens
    const activityTokens = w
      .filter(x => x.cx > (activityCx - canvasWidth * 0.12))
      .map(x => x.text);

    const activity = normalizeActivityFromTokens(activityTokens);

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
// Ranks persistence
// ---------------------------
function loadRanks() {
  if (!ranksEl) return;
  const saved = localStorage.getItem("osrp_ranks") || "";

  const defaults = [
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
  ].join("\n");

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
    // Next file selection should append (not clear)
    appendMode = true;
    fileEl.click();
  });
}

fileEl.addEventListener("change", () => {
  const f = fileEl.files && fileEl.files[0];
  if (!f) return;

  // If user picked a new file normally (not via append button), start fresh.
  if (!appendMode) {
    csvEl.value = "";
    rawEl.value = "";
    allRows = [];
    allRawBlocks = [];
  } else {
    // Keep existing output; this new image will append.
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

    const pre = preprocessCanvas(cropped);
    const data = await doOCR(pre);

    const wordBoxes = (data.words || [])
      .map(normalizeWord)
      .filter(Boolean);

    if (!wordBoxes.length) {
      setStatus("No OCR words found. Try a clearer screenshot.");
      return;
    }

    const rows = parseRowsFromWordBoxes(wordBoxes, pre.width);
    if (!rows.length) {
      setStatus("No rows detected. Crop tighter around ONLY the rows and try again.");
      return;
    }

    // Raw OCR: append blocks when in appendMode
    const rawBlock = (data.text || "").trim();
    if (appendMode) {
      if (rawBlock) allRawBlocks.push(rawBlock);
      rawEl.value = allRawBlocks.join("\n\n---\n\n");
    } else {
      allRawBlocks = rawBlock ? [rawBlock] : [];
      rawEl.value = rawBlock;
    }

    // Rows: merge into allRows when appending
    function keyRow(r) {
      return (r.name || "").toLowerCase().trim();
    }

    if (appendMode) {
      const map = new Map(allRows.map(r => [keyRow(r), r]));

      for (const r of rows) {
        const k = keyRow(r);
        if (!k) continue;

        if (!map.has(k)) {
          map.set(k, r);
        } else {
          // update existing: keep highest honor, prefer non-empty rank/activity, prefer latest lvl if present
          const prev = map.get(k);
          prev.lvl = r.lvl ?? prev.lvl;
          prev.rank = (r.rank && r.rank.trim()) ? r.rank : prev.rank;
          prev.activity = (r.activity && r.activity !== "n/a") ? r.activity : prev.activity;
          prev.honor = Math.max(prev.honor || 0, r.honor || 0);
        }
      }

      allRows = Array.from(map.values());
    } else {
      allRows = rows.slice();
    }

    csvEl.value = rowsToCsv(allRows);
    setStatus(`Total ${allRows.length} row(s) in CSV. ${appendMode ? "Appended." : "Extracted."}`);
    copyBtn.disabled = false;
    downloadBtn.disabled = false;

    // After a successful append extraction, turn appendMode off so normal "Choose File" starts fresh next time
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
