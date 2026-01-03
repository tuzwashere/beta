const fileEl = document.getElementById("file");
const imgEl = document.getElementById("img");
const extractBtn = document.getElementById("extract");
const copyBtn = document.getElementById("copy");
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
  clearBtn.disabled = true;
  csvEl.value = "";
  rawEl.value = "";
  setStatus("Waiting for image…");
}

function parseRowsFromOcr(rawText) {
  // Work line-by-line first (Tesseract usually keeps lines)
  const lines = (rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length);

  const rows = [];

  for (const line0 of lines) {
    // Clean up line but keep spacing
    const line = line0
      .replace(/[“”]/g, '"')
      .replace(/\u00A0/g, " ")
      .replace(/[|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Must start with a list position: 1..45 (your gang list)
    const mPos = line.match(/^(\d{1,2})\s+/);
    if (!mPos) continue;

    const pos = parseInt(mPos[1], 10);
    if (!(pos >= 1 && pos <= 45)) continue;

    // Activity: Online OR "13m" "2h" "3d" "19h" "1 h." "7 m." etc.
    const mAct = line.match(/\b(Online|\d+\s*[mhdwy]\.?)\b/i);
    const activity = mAct ? mAct[1].replace(/\s+/g, "") : "";

    // Honor: prefer the LAST big number group, allow spaces (132 920)
    const honorMatches = [...line.matchAll(/\b\d[\d\s]{2,}\b/g)].map(
      (x) => x[0],
    );
    let honor = "";
    if (honorMatches.length) {
      honor = honorMatches[honorMatches.length - 1].replace(/\s+/g, "");
    }

    // Remove pos and keep the rest for name/lvl/rank parse
    const rest = line.replace(/^(\d{1,2})\s+/, "").trim();

    // Find lvl: first standalone 1-2 digit number after name
    // Example: "Monsta Loe 19 GODFATHER 132 920 1h."
    const mLvl = rest.match(/\b(\d{1,2})\b/);
    if (!mLvl) continue;

    const lvl = mLvl[1];

    // Name is everything before lvl
    const name = rest.split(new RegExp(`\\b${lvl}\\b`))[0].trim();

    // Rank is after lvl, strip obvious junk tokens and remove honor/activity fragments
    let rankPart = rest.split(new RegExp(`\\b${lvl}\\b`))[1] || "";
    rankPart = rankPart.trim();

    // If honor exists, cut rank before honor digits show up
    if (honor) {
      // honor may appear spaced in text, so cut at first digit-run that belongs to honor-ish
      rankPart = rankPart.replace(/\b\d[\d\s]{2,}\b.*$/g, "").trim();
    }

    // Also cut at activity if present
    if (activity) {
      rankPart = rankPart
        .replace(new RegExp(`\\b${activity.replace(".", "\\.")}\\b.*$`, "i"), "")
        .trim();
      rankPart = rankPart.replace(/\bOnline\b.*$/i, "").trim();
    }

    // Final cleanup
    const rank = rankPart
      .replace(/^[^A-Za-z]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Basic sanity: need name + honor
    if (!name || !honor) continue;

    rows.push({
      pos,
      name,
      lvl: parseInt(lvl, 10),
      rank,
      honor: parseInt(honor, 10),
      activity,
    });
  }

  // Sort by pos so output is stable
  rows.sort((a, b) => a.pos - b.pos);

  return rows;
}

function rowsToCsv(rows) {
  const header = ["pos", "name", "lvl", "rank", "honor", "activity"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const safe = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    lines.push(
      [r.pos, safe(r.name), r.lvl, safe(r.rank), r.honor, safe(r.activity)].join(
        ",",
      ),
    );
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
    csvEl.value = "";
    rawEl.value = "";
  };
});

extractBtn.addEventListener("click", async () => {
  if (!cropper) return;

  extractBtn.disabled = true;
  copyBtn.disabled = true;

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
  } catch (e) {
    console.error(e);
    setStatus("OCR failed. Try cropping tighter or use a clearer screenshot.");
  } finally {
    extractBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", async () => {
  const text = csvEl.value.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("CSV copied to clipboard.");
});

clearBtn.addEventListener("click", () => {
  fileEl.value = "";
  cleanupImage();
});

cleanupImage();
