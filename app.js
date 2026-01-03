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

function normalizeHonor(s) {
  // "26 200" -> "26200", "1,020" -> "1020"
  return s.replace(/[,\s]/g, "");
}

function parseRows(words, imageWidth) {
  if (!Array.isArray(words) || !words.length || !imageWidth) return [];

  const cleanedWords = words.filter((w) => w && w.text && w.bbox);
  if (!cleanedWords.length) return [];

  const avgHeight =
    cleanedWords.reduce((sum, w) => sum + (w.bbox.y1 - w.bbox.y0), 0) /
    cleanedWords.length;
  let rowHeightThreshold = Math.round(avgHeight * 0.8);
  if (rowHeightThreshold < 18) rowHeightThreshold = 18;
  if (avgHeight <= 30 && rowHeightThreshold > 24) rowHeightThreshold = 24;

  const anchors = cleanedWords
    .filter((w) => {
      const text = w.text.trim();
      if (!/^\d+$/.test(text)) return false;
      const num = parseInt(text, 10);
      if (Number.isNaN(num) || num < 1 || num > 45) return false;
      const xCenter = (w.bbox.x0 + w.bbox.x1) / 2;
      return xCenter < 0.1 * imageWidth;
    })
    .sort(
      (a, b) =>
        (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2,
    );

  const headerTokens = new Set(["MEMBERS", "LVL", "RANKS", "HONOR", "ACTIVITY"]);

  const rows = [];
  for (const anchor of anchors) {
    const anchorY = (anchor.bbox.y0 + anchor.bbox.y1) / 2;
    const rowWords = cleanedWords.filter((w) => {
      const yCenter = (w.bbox.y0 + w.bbox.y1) / 2;
      return Math.abs(yCenter - anchorY) <= rowHeightThreshold;
    });

    const filteredWords = rowWords.filter((w) => {
      if (w === anchor) return false;
      if (!/^\d+$/.test(w.text.trim())) return true;
      const xCenter = (w.bbox.x0 + w.bbox.x1) / 2;
      return !(w.text.trim() === anchor.text.trim() && xCenter < 0.1 * imageWidth);
    });

    if (
      filteredWords.some((w) =>
        headerTokens.has(w.text.trim().toUpperCase()),
      )
    ) {
      continue;
    }

    const columns = {
      name: [],
      lvl: [],
      rank: [],
      honor: [],
      activity: [],
    };

    for (const w of filteredWords) {
      const xCenter = (w.bbox.x0 + w.bbox.x1) / 2;
      const ratio = xCenter / imageWidth;
      if (ratio >= 0.1 && ratio < 0.4) columns.name.push(w);
      else if (ratio >= 0.4 && ratio < 0.52) columns.lvl.push(w);
      else if (ratio >= 0.52 && ratio < 0.72) columns.rank.push(w);
      else if (ratio >= 0.72 && ratio < 0.86) columns.honor.push(w);
      else if (ratio >= 0.86 && ratio <= 1) columns.activity.push(w);
    }

    const joinByX = (list) =>
      list
        .slice()
        .sort((a, b) => (a.bbox.x0 + a.bbox.x1) / 2 - (b.bbox.x0 + b.bbox.x1) / 2)
        .map((w) => w.text)
        .join(" ")
        .trim();

    const name = joinByX(columns.name);
    const lvlText = joinByX(columns.lvl);
    const lvlMatch = lvlText.match(/\d+/);
    const lvl = lvlMatch ? parseInt(lvlMatch[0], 10) : NaN;
    const rank = joinByX(columns.rank);

    const honorText = joinByX(columns.honor).replace(/\D/g, "");
    const honor = honorText ? parseInt(honorText, 10) : NaN;

    let activityText = joinByX(columns.activity);
    if (/online/i.test(activityText)) {
      activityText = "Online";
    } else {
      activityText = activityText
        .replace(/\s+/g, " ")
        .trim()
        .replace(/(\d+)\s*([mhd])\.?/gi, (_, num, unit) => `${num}${unit.toLowerCase()}`);
    }

    if (!name || Number.isNaN(lvl) || !rank || Number.isNaN(honor)) continue;

    rows.push({
      name,
      lvl,
      rank,
      honor,
      activity: activityText,
    });
  }

  return rows;
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

    const rows = parseRows(data.words, canvas.width);
    if (!rows.length) {
      setStatus("No rows detected. Crop tighter around the table and try again.");
      extractBtn.disabled = false;
      return;
    }

    const csvLines = ["name,lvl,rank,honor,activity"];
    for (const r of rows) {
      // CSV escape minimal (quotes if comma)
      const name = r.name.includes(",") ? `"${r.name.replaceAll('"', '""')}"` : r.name;
      const rank = r.rank.includes(",") ? `"${r.rank.replaceAll('"', '""')}"` : r.rank;
      const activity = r.activity.includes(",") ? `"${r.activity.replaceAll('"', '""')}"` : r.activity;
      csvLines.push(`${name},${r.lvl},${rank},${r.honor},${activity}`);
    }

    csvEl.value = csvLines.join("\n");
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
