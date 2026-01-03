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

function titleCase(s) {
  return (s || "")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeLettersOnly(s) {
  return (s || "").toUpperCase().replace(/[^A-Z]/g, "");
}

// Simple Levenshtein distance (small strings only)
function levenshtein(a, b) {
  a = a || "";
  b = b || "";
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;

  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1, // delete
        dp[j - 1] + 1, // insert
        prev + cost // replace
      );
      prev = tmp;
    }
  }
  return dp[m];
}

function similarity(a, b) {
  const aa = normalizeLettersOnly(a);
  const bb = normalizeLettersOnly(b);
  const maxLen = Math.max(aa.length, bb.length);
  if (!maxLen) return 0;
  const dist = levenshtein(aa, bb);
  return 1 - dist / maxLen;
}

function extractActivity(line) {
  if (/\bonline\b/i.test(line)) return "Online";
  const m = line.match(/\b([0-9A-Za-z]{1,2})\s*([mhd])\.?\s*$/i);
  if (!m) return null;

  let num = m[1];
  const unit = m[2].toLowerCase();

  const map = {
    a: "3",
    A: "3",
    T: "1",
    I: "1",
    l: "1",
    O: "0",
    o: "0",
    S: "5",
    s: "5",
  };
  num = num
    .split("")
    .map((ch) => (map[ch] ?? ch))
    .join("");
  if (!/^\d{1,2}$/.test(num)) return null;

  return `${parseInt(num, 10)}${unit}`;
}

function bestMatchRank(rawRank, rankList) {
  if (!rawRank) return "";

  // Keep your “safe” cleanup
  let cleaned = rawRank
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  cleaned = cleaned
    .replace(/\bSOSS\b/g, "BOSS")
    .replace(/\bPONN?\b/g, "DONN")
    .replace(/\bOWN\b/g, "DONN");

  // If they provided ranks, snap to closest.
  if (Array.isArray(rankList) && rankList.length) {
    let best = { rank: titleCase(cleaned), score: 0 };

    for (const r of rankList) {
      const score = similarity(cleaned, r);
      const a = normalizeLettersOnly(cleaned);
      const b = normalizeLettersOnly(r);
      const bonus = a.includes(b) || b.includes(a) ? 0.12 : 0;
      const finalScore = score + bonus;

      if (finalScore > best.score) best = { rank: r, score: finalScore };
    }

    // Threshold: below this, don’t force it (avoids bad snapping)
    if (best.score >= 0.62) return best.rank;
  }

  return titleCase(cleaned);
}

function parseRowsFromOcr(rawText, rankList) {
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

    // Honor = last big number group (handles "132 920")
    const honorMatches = [...line.matchAll(/\b\d[\d\s]{2,}\b/g)].map(
      (x) => x[0]
    );
    if (!honorMatches.length) continue;

    const honorText = honorMatches[honorMatches.length - 1];
    const honor = parseInt(honorText.replace(/\s+/g, ""), 10);
    if (!Number.isFinite(honor)) continue;

    const activity = extractActivity(line) || "n/a";

    const honorIdx = line.lastIndexOf(honorText);
    const beforeHonor = honorIdx > 0 ? line.slice(0, honorIdx).trim() : line;

    // lvl = first 1–2 digit number
    const mLvl = beforeHonor.match(/\b(\d{1,2})\b/);
    if (!mLvl) continue;
    const lvl = parseInt(mLvl[1], 10);
    if (!Number.isFinite(lvl)) continue;

    const lvlIdx = beforeHonor.indexOf(mLvl[1]);

    // name = before lvl
    let namePart = beforeHonor.slice(0, lvlIdx).trim();
    namePart = namePart
      .replace(/^[^A-Za-z]+/g, "")
      .replace(/\b(BR|es)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (namePart.length < 3) continue;

    // rank = between lvl and honor
    let rankPart = beforeHonor.slice(lvlIdx + mLvl[1].length).trim();
    const rank = bestMatchRank(rankPart, rankList);

    rows.push({ name: namePart, lvl, rank, honor, activity });
  }

  // De-dup
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.name}|${r.lvl}|${r.honor}|${r.activity}`;
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

    const data = await doOCR(canvas);

    // Always show raw OCR (even if no rows parse)
    rawEl.value = data && data.text ? data.text : "";

    const rows = parseRowsFromOcr(rawEl.value, rankList);
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
