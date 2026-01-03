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
    lineNoActivity = lineNoActivity.replace(/\bx\s*\d+\b/gi, "").trim();

    const numMatches = [...lineNoActivity.matchAll(/\b\d[\d\s]*\b/g)].map(
      (m) => m[0]
    );
    if (!numMatches.length) continue;

    const honorText = numMatches[numMatches.length - 1];
    const honor = parseInt(honorText.replace(/\s+/g, ""), 10);
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

    const rows = parseRowsFromOcr(rawEl.value);
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
