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

function parseRows(ocrText) {
  // Works best when crop is tight around the table.
  // We extract repeated matches from raw OCR text.
  const text = ocrText
    .replace(/\r/g, "\n")
    .replace(/[|]/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ");

  // Activity patterns: Online, "7 m.", "2 h.", "1 d."
  // Honor: digits possibly with spaces
  // Name: words + numbers + underscores + apostrophes
  // Rank: words/spaces
  const re = /([A-Za-z][A-Za-z0-9_ ']+?)\s+(\d{1,2})\s+([A-Za-z][A-Za-z ]+?)\s+(\d[\d\s,]{0,12}\d|\d+)\s+(Online|\d+\s*[mhd]\.?)/g;

  const rows = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    const lvl = parseInt(m[2], 10);
    const rank = m[3].trim().replace(/\s+/g, " ");
    const honor = parseInt(normalizeHonor(m[4]), 10);
    const activity = m[5].trim().toLowerCase() === "online" ? "online" : m[5].trim();

    if (!name || Number.isNaN(lvl) || Number.isNaN(honor)) continue;
    rows.push({ name, lvl, rank, honor, activity });
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
  return data.text || "";
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

    const text = await doOCR(canvas);
    rawEl.value = text;

    const rows = parseRows(text);
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
