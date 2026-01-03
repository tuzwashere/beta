const fileInput = document.getElementById("file-input");
const previewImage = document.getElementById("preview-image");
const extractButton = document.getElementById("extract-btn");
const copyButton = document.getElementById("copy-btn");
const output = document.getElementById("csv-output");
const progressBar = document.getElementById("ocr-progress");
const statusText = document.getElementById("status-text");

let cropper = null;

const setStatus = (message) => {
  statusText.textContent = message;
};

const resetProgress = () => {
  progressBar.value = 0;
};

const enableActions = (enabled) => {
  extractButton.disabled = !enabled;
  copyButton.disabled = !enabled;
};

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    previewImage.src = reader.result;
    if (cropper) {
      cropper.destroy();
    }
    cropper = new Cropper(previewImage, {
      viewMode: 1,
      autoCropArea: 0.8,
      responsive: true,
      background: false,
    });
    enableActions(true);
    setStatus("Crop the table region, then extract.");
  };
  reader.readAsDataURL(file);
});

const normalizeHonor = (value) => value.replace(/\s+/g, "");

const normalizeActivity = (value) => {
  if (/online/i.test(value)) {
    return "online";
  }
  return value.replace(/\s+/g, "");
};

const parseRows = (text) => {
  const results = [];
  const pattern =
    /([A-Za-z][A-Za-z ]+?)\s+(\d+)\s+([A-Za-z ]+?)\s+([\d ]+)\s+(Online|\d+\s*[mhd]\.)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1].trim().replace(/\s+/g, " ");
    const lvl = match[2];
    const rank = match[3].trim().replace(/\s+/g, " ");
    const honor = normalizeHonor(match[4]);
    const activity = normalizeActivity(match[5]);
    results.push(`${name},${lvl},${rank},${honor},${activity}`);
  }
  return results;
};

extractButton.addEventListener("click", async () => {
  if (!cropper) {
    return;
  }

  resetProgress();
  setStatus("Preparing OCR…");
  extractButton.disabled = true;
  copyButton.disabled = true;

  const canvas = cropper.getCroppedCanvas({
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high",
  });
  const dataUrl = canvas.toDataURL("image/png");

  try {
    const result = await Tesseract.recognize(dataUrl, "eng", {
      logger: (message) => {
        if (message.status) {
          setStatus(message.status);
        }
        if (message.progress) {
          progressBar.value = message.progress;
        }
      },
    });

    const rawText = result.data.text || "";
    const rows = parseRows(rawText);
    const header = "name,lvl,rank,honor,activity";
    output.value = [header, ...rows].join("\n");

    if (rows.length === 0) {
      setStatus("No rows detected. Try a tighter crop or clearer screenshot.");
    } else {
      setStatus(`Extracted ${rows.length} row(s).`);
    }
  } catch (error) {
    setStatus("OCR failed. Please try again.");
    console.error(error);
  } finally {
    extractButton.disabled = false;
    copyButton.disabled = output.value.trim().length === 0;
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(output.value);
    setStatus("CSV copied to clipboard.");
  } catch (error) {
    setStatus("Copy failed. You can manually select the CSV.");
  }
});

output.addEventListener("input", () => {
  copyButton.disabled = output.value.trim().length === 0;
});
