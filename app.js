const fileEl = document.getElementById("file");
const imgEl = document.getElementById("img");
const extractBtn = document.getElementById("extract");
const copyBtn = document.getElementById("copyCsvBtn");
const downloadBtn = document.getElementById("downloadCsvBtn");
const clearBtn = document.getElementById("clear");
const csvEl = document.getElementById("csv");
const rawEl = document.getElementById("raw");
const statusEl = document.getElementById("status");

let cropper = null;
let currentObjectUrl = null;

function setStatus(t){ statusEl.textContent = t; }

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
}

function parseRowsFromOcr(rawText) {
  const lines = (rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];

  for (let line of lines) {
    // Skip header-ish lines
    if (/members|member\s*ranks|honor\s*points|activity|lvl/i.test(line)) {
      continue;
    }

    line = line
      .replace(/[“”]/g, '"')
      .replace(/\u00A0/g, " ")
      .replace(/[|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Honor = last big number group (handles "132 920")
    const honorMatches = [...line.matchAll(/\b\d[\d\s]{2,}\b/g)].map(
      (x) => x[0],
    );
    if (!honorMatches.length) continue;
    const honorText = honorMatches[honorMatches.length - 1];
    const honor = parseInt(honorText.replace(/\s+/g, ""), 10);
    if (!Number.isFinite(honor)) continue;

    // Activity (can be null; we won't drop the row anymore)
    const activity = extractActivity(line) || "n/a";

    // Use text before honor to find lvl/name/rank
    const honorIdx = line.lastIndexOf(honorText);
    const beforeHonor = honorIdx > 0 ? line.slice(0, honorIdx).trim() : line;

    // lvl = first 1–2 digit number
    const mLvl = beforeHonor.match(/\b(\d{1,2})\b/);
    if (!mLvl) continue;
    const lvl = parseInt(mLvl[1], 10);
    if (!Number.isFinite(lvl)) continue;

    const lvlIdx = beforeHonor.indexOf(mLvl[1]);

    // name = before lvl (strip junk prefixes like [7], BR, etc)
    let namePart = beforeHonor.slice(0, lvlIdx).trim();
    namePart = namePart
      .replace(/^[^A-Za-z]+/g, "")
      .replace(/\b(BR|es)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (namePart.length < 3) continue;

    // rank = between lvl and honor
    let rankPart = beforeHonor.slice(lvlIdx + mLvl[1].length).trim();
    const rank = normalizeRank(rankPart);

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

function titleCase(s) {
  return (s || "")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeRank(raw) {
  if (!raw) return "";

  let cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // ONLY fix super-common OCR glitches (safe)
  cleaned = cleaned
    .replace(/\bSOSS\b/g, "BOSS")
    .replace(/\bPONN?\b/g, "DONN")
    .replace(/\bOWN\b/g, "DONN");

  // Keep whatever the game rank actually is (no whitelist)
  return titleCase(cleaned);
}

function extractActivity(line) {
  if (/\bonline\b/i.test(line)) return "Online";

  // Try last token like: 1h, 3d, 13m, but allow OCR to misread the number as a letter (T=1, a=3, etc)
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

fileEl.addEventListener("change", () => {
  const f = fileEl.files && fileEl.files[0];
  if (!f) return;

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
    rawEl.value = data.text || "";

    const rows = parseRowsFromOcr(data.text || "");
    if (!rows.length) {
      setStatus("No rows detected. Crop tighter around the table and try again.");
      extractBtn.disabled = false;
      return;
    }

    csvEl.value = rowsToCsv(rows);
    setStatus(`Extracted ${rows.length} row(s). Review CSV then Copy.`);
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
  const text = buildCsvText().trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("CSV copied to clipboard.");
});

clearBtn.addEventListener("click", () => {
  fileEl.value = "";
  cleanupImage();
});

cleanupImage();
