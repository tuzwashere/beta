const fileEl = document.getElementById("file");
const imgEl = document.getElementById("img");
const extractBtn = document.getElementById("extract");
const copyBtn = document.getElementById("copyCsvBtn");
const downloadBtn = document.getElementById("downloadCsvBtn");
const clearBtn = document.getElementById("clear");
const csvEl = document.getElementById("csv");
const rawEl = document.getElementById("raw");
const statusEl = document.getElementById("status");

// NEW: ranks UI (optional)
const ranksEl = document.getElementById("ranks");
const saveRanksBtn = document.getElementById("saveRanksBtn");

let cropper = null;
let currentObjectUrl = null;

function setStatus(t) {
  statusEl.textContent = t;
}

// ---------- RANK LIST (localStorage) ----------
const RANKS_KEY = "osrp_rank_list_v1";
const DEFAULT_RANKS = [
  "Gang Leader",
  "Deputy",
  "Cutthroat",
  "Fighter",
  "Trainee",
  "Newbie",
];

function loadRankList() {
  try {
    const raw = localStorage.getItem(RANKS_KEY);
    if (!raw) return [...DEFAULT_RANKS];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return [...DEFAULT_RANKS];
    return arr.map((s) => String(s).trim()).filter(Boolean);
  } catch {
    return [...DEFAULT_RANKS];
  }
}

function saveRankList(list) {
  localStorage.setItem(RANKS_KEY, JSON.stringify(list));
}

function setRanksUi(list) {
  if (!ranksEl) return;
  ranksEl.value = list.join("\n");
}

// ---------- HELPERS ----------
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

function getRankHints() {
  const el =
    document.getElementById("rankHints") ||
    document.getElementById("gangRanks") ||
    document.getElementById("ranks") ||
    document.getElementById("rankList");

  const raw = el ? el.value : "";
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normLetters(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rankSimilarity(a, b) {
  const A = new Set(normLetters(a).split(" ").filter(Boolean));
  const B = new Set(normLetters(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) {
    if (B.has(t)) common++;
  }
  return common / Math.max(A.size, B.size);
}

function pickClosestRank(raw, hints) {
  if (!hints || !hints.length) return raw;

  let best = raw;
  let bestScore = 0;

  for (const h of hints) {
    const score = rankSimilarity(raw, h);
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }

  return bestScore >= 0.5 ? best : raw;
}

function extractActivity(line) {
  if (!line) return null;
  if (/\bonline\b/i.test(line)) return "Online";

  const matches = [...line.matchAll(/\b(\d{1,2})\s*([mhd])\.?\b/gi)];
  if (!matches.length) return null;

  const m = matches[matches.length - 1];
  const num = parseInt(m[1], 10);
  const unit = (m[2] || "").toLowerCase();
  if (!Number.isFinite(num)) return null;

  return `${num}${unit}`;
}

function titleCase(s) {
  return (s || "")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeRank(raw, hints) {
  if (!raw) return "";

  let cleaned = raw
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  cleaned = cleaned
    .replace(/\bSOSS\b/gi, "Boss")
    .replace(/\bPONN?\b/gi, "Donn")
    .replace(/\bPEPUTY\b/gi, "Deputy")
    .replace(/\bDEPULY\b/gi, "Deputy");

  cleaned = titleCase(cleaned);

  return titleCase(pickClosestRank(cleaned, hints));
}

function normalizeSpaces(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function isMostlyLetters(s) {
  return /^[A-Za-z][A-Za-z\s'._-]*$/.test(s);
}

function cleanNameFromWords(words) {
  let name = normalizeSpaces(words.join(" "));
  name = name
    .replace(/[“”]/g, '"')
    .replace(/^[^A-Za-z]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const parts = name.split(" ").filter(Boolean);
  while (parts.length && parts[0].length <= 2 && !isMostlyLetters(parts[0])) {
    parts.shift();
  }
  return parts.join(" ").trim();
}

function extractActivityFromWords(words) {
  const text = normalizeSpaces(words.join(" "));
  if (!text) return "n/a";
  if (/\bonline\b/i.test(text)) return "Online";

  const m = text.match(/\b(\d{1,2})\s*([mhd])\b/i);
  if (!m) return "n/a";
  return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;
}

function parseHonorFromWords(words) {
  let best = null;

  for (const w of words) {
    const digits = (w || "").replace(/[^\d]/g, "");
    if (!digits) continue;
    best = digits;
  }

  if (!best) return 0;
  return parseInt(best, 10) || 0;
}

function normalizeRankText(raw) {
  if (!raw) return "";
  let cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  cleaned = cleaned
    .replace(/\bSOSS\b/g, "BOSS")
    .replace(/\bPONN?\b/g, "DONN")
    .replace(/\bOWN\b/g, "DONN");

  return cleaned
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function getRankList() {
  if (!ranksEl) return [];
  return (ranksEl.value || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function bestRankMatch(rankText, rankList) {
  const r = normalizeSpaces(rankText);
  if (!r) return "";

  if (!rankList.length) return normalizeRankText(r);

  const rLow = r.toLowerCase();
  for (const cand of rankList) {
    if (cand.toLowerCase() === rLow) return cand;
  }
  for (const cand of rankList) {
    if (rLow.includes(cand.toLowerCase()) || cand.toLowerCase().includes(rLow)) {
      return cand;
    }
  }

  return normalizeRankText(r);
}

function groupWordsIntoRows(words, height) {
  const tol = Math.max(12, Math.round(height * 0.02));
  const sorted = [...words].sort(
    (a, b) =>
      (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2
  );

  const rows = [];
  for (const w of sorted) {
    const yMid = (w.bbox.y0 + w.bbox.y1) / 2;
    let placed = false;

    for (const row of rows) {
      if (Math.abs(yMid - row.yMid) <= tol) {
        row.words.push(w);
        row.yMid = (row.yMid * (row.words.length - 1) + yMid) / row.words.length;
        placed = true;
        break;
      }
    }

    if (!placed) rows.push({ yMid, words: [w] });
  }

  for (const r of rows) {
    r.words.sort(
      (a, b) =>
        (a.bbox.x0 + a.bbox.x1) / 2 - (b.bbox.x0 + b.bbox.x1) / 2
    );
  }

  return rows;
}

function parseRowsFromTesseract(data, tableWidth, tableHeight) {
  const rankList = getRankList();

  const words = (data.words || [])
    .filter((w) => (w.text || "").trim().length > 0)
    .filter((w) => (w.confidence ?? 0) >= 40);

  if (!words.length) return [];

  const col = {
    name: [0.12, 0.43],
    lvl: [0.43, 0.52],
    rank: [0.52, 0.74],
    honor: [0.74, 0.88],
    activity: [0.88, 0.97],
  };

  const rows = [];
  const grouped = groupWordsIntoRows(words, tableHeight);

  for (const g of grouped) {
    const buckets = { name: [], lvl: [], rank: [], honor: [], activity: [] };

    for (const w of g.words) {
      const xMid = (w.bbox.x0 + w.bbox.x1) / 2;
      const xr = xMid / tableWidth;
      const t = (w.text || "").trim();

      const inRange = (key) => xr >= col[key][0] && xr < col[key][1];

      if (inRange("name")) buckets.name.push(t);
      else if (inRange("lvl")) buckets.lvl.push(t);
      else if (inRange("rank")) buckets.rank.push(t);
      else if (inRange("honor")) buckets.honor.push(t);
      else if (inRange("activity")) buckets.activity.push(t);
    }

    const name = cleanNameFromWords(buckets.name);
    if (!name || name.length < 3) continue;

    const lvlDigits = (buckets.lvl.join(" ").match(/\b(\d{1,2})\b/) || [])[1];
    const lvl = lvlDigits ? parseInt(lvlDigits, 10) : null;
    if (!Number.isFinite(lvl)) continue;

    const rankRaw = normalizeSpaces(buckets.rank.join(" "));
    const rank = bestRankMatch(rankRaw, rankList);

    let honor = 0;
    {
      const candidates = buckets.honor
        .map((t) => ({ t, digits: (t || "").replace(/[^\d]/g, "") }))
        .filter((x) => x.digits.length > 0);

      if (candidates.length) {
        const picked = candidates[candidates.length - 1].digits;
        honor = parseInt(picked, 10) || 0;
      } else {
        honor = parseHonorFromWords(buckets.honor);
      }
    }

    const activity = extractActivityFromWords(buckets.activity);

    rows.push({ name, lvl, rank, honor, activity });
  }

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.name}|${r.lvl}|${r.rank}|${r.honor}|${r.activity}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }

  return out;
}

function parseRowsFromOcr(rawText) {
  const hints = getRankHints();
  const lines = (rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];

  for (let line of lines) {
    if (/members|member\s*ranks|honor\s*points|activity|lvl/i.test(line)) continue;

    line = line
      .replace(/[“”]/g, '"')
      .replace(/\u00A0/g, " ")
      .replace(/[|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    line = line.replace(/^\d+\s+/, "");

    const activity = extractActivity(line) || "n/a";

    let lineNoActivity = line.replace(/\bonline\b/gi, "").trim();
    lineNoActivity = lineNoActivity
      .replace(/\b[×x]\s*[0-9Oo]{1,4}\b/gi, () => "")
      .trim();

    const numMatches = [...lineNoActivity.matchAll(/\b\d[\d\s]*\b/g)].map(
      (m) => m[0]
    );
    if (!numMatches.length) continue;

    const honorText = numMatches[numMatches.length - 1];
    const honorNorm = honorText
      .replace(/\s+/g, "")
      .replace(/O/g, "0")
      .replace(/o/g, "0");
    const honor = parseInt(honorNorm, 10);
    if (!Number.isFinite(honor)) continue;

    const honorIdx = lineNoActivity.lastIndexOf(honorText);
    const beforeHonor =
      honorIdx > 0 ? lineNoActivity.slice(0, honorIdx).trim() : lineNoActivity;

    const mLvl = beforeHonor.match(/\b(\d{1,2})\b/);
    const lvl = mLvl ? parseInt(mLvl[1], 10) : "";

    let namePart = beforeHonor;
    let rankPart = "";

    if (mLvl) {
      const lvlIdx = beforeHonor.indexOf(mLvl[1]);
      namePart = beforeHonor.slice(0, lvlIdx).trim();
      rankPart = beforeHonor.slice(lvlIdx + mLvl[1].length).trim();
    } else {
      const words = beforeHonor.split(" ").filter(Boolean);
      const tail = words.slice(Math.max(0, words.length - 4)).join(" ");
      const guessed = pickClosestRank(tail, hints);
      if (guessed && guessed !== tail) {
        rankPart = guessed;
        namePart = beforeHonor
          .replace(
            new RegExp(`${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
            ""
          )
          .trim();
      } else {
        rankPart = words.slice(-2).join(" ");
        namePart = words.slice(0, -2).join(" ");
      }
    }

    namePart = namePart
      .replace(/^[^A-Za-z]+/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (namePart.length < 3) continue;

    const rank = normalizeRank(rankPart, hints);

    rows.push({
      name: namePart,
      lvl,
      rank,
      honor,
      activity,
    });
  }

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.name}|${r.lvl}|${r.rank}|${r.honor}|${r.activity}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }

  return out;
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

function upscaleCanvas(srcCanvas, scale = 2) {
  const dst = document.createElement("canvas");
  dst.width = Math.max(1, Math.floor(srcCanvas.width * scale));
  dst.height = Math.max(1, Math.floor(srcCanvas.height * scale));
  const ctx = dst.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, dst.width, dst.height);
  return dst;
}

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

// ---------- INIT ----------
let rankList = loadRankList();
setRanksUi(rankList);

if (saveRanksBtn && ranksEl) {
  saveRanksBtn.addEventListener("click", () => {
    const list = (ranksEl.value || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    rankList = list.length ? list : [...DEFAULT_RANKS];
    saveRankList(rankList);
    setRanksUi(rankList);

    setStatus(`Saved ${rankList.length} rank(s). Next extract will use them.`);
  });
}

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
    const canvas = cropper.getCroppedCanvas({
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
    });

    const ocrCanvas = upscaleCanvas(canvas, 2);
    const data = await doOCR(ocrCanvas);

    // Always show raw OCR (even if no rows parse)
    rawEl.value = data && data.text ? data.text : "";

    const rows = parseRowsFromTesseract(data, canvas.width, canvas.height);
    if (!rows.length) {
      csvEl.value = "";
      setStatus("No rows detected. Crop tighter around ONLY the rows and try again.");
      return;
    }

    csvEl.value = rowsToCsv(rows);
    setStatus(`Extracted ${rows.length} row(s). Review CSV then Copy/Download.`);
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("OCR failed. Crop tighter or use a clearer screenshot.");
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

downloadBtn.addEventListener("click", () => {
  const csv = (csvEl.value || "").trim();
  if (!csv) {
    alert("No CSV to download.");
    return;
  }

  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const filename = `members_${yyyy}-${mm}-${dd}.csv`;

  downloadCsv(filename, csv);
});

clearBtn.addEventListener("click", () => {
  fileEl.value = "";
  cleanupImage();
});

cleanupImage();
