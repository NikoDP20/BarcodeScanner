let mode = "";
let entries = [];
let tempPlot = "";
let scanStep = "plot";
let quaggaStarted = false;
let lastScan = "";
let lastScanTime = 0;
let scanRequested = false;
let scanRequestTimer = null;

const DEBOUNCE_MS = 1500;
const MANUAL_SCAN_TIMEOUT_MS = 2500;

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function updateScanStatus() {
  document.getElementById("scanStatus").textContent =
    scanStep === "plot" ? "Scan Plot" : "Scan SN";
}

function clearScanRequestTimer() {
  if (!scanRequestTimer) return;
  clearTimeout(scanRequestTimer);
  scanRequestTimer = null;
}

function resetScanButton(disabled) {
  const btn = document.getElementById("scanBtn");
  if (!btn) return;
  btn.disabled = disabled;
  btn.textContent = disabled ? "Starting..." : "Scan";
}

async function getRearCameraConstraint() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { facingMode: { ideal: "environment" } };
  }

  try {
    const warmupStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    warmupStream.getTracks().forEach((t) => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");

    const rear = cameras.find((c) => {
      const label = (c.label || "").toLowerCase();
      return (
        label.includes("back") ||
        label.includes("rear") ||
        label.includes("environment")
      );
    });

    if (rear && rear.deviceId) {
      return { deviceId: { exact: rear.deviceId } };
    }
  } catch {
    return { facingMode: { ideal: "environment" } };
  }

  return { facingMode: { ideal: "environment" } };
}

function initQuagga(target, videoConstraint) {
  return new Promise((resolve, reject) => {
    Quagga.init(
      {
        inputStream: {
          type: "LiveStream",
          target,
          constraints: videoConstraint,
        },
        locator: {
          patchSize: "medium",
          halfSample: false,
        },
        numOfWorkers: navigator.hardwareConcurrency
          ? Math.min(4, navigator.hardwareConcurrency)
          : 2,
        frequency: 10,
        decoder: {
          readers: ["code_128_reader"],
        },
        locate: true,
      },
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });
}

async function startCamera() {
  resetScanButton(true);
  const target = document.getElementById("reader");
  if (!target) {
    resetScanButton(false);
    return;
  }

  target.innerHTML = "";

  if (!window.Quagga) {
    resetScanButton(false);
    alert("Scanner library failed to load.");
    return;
  }

  const preferredConstraint = await getRearCameraConstraint();
  const constraintsToTry = [
    preferredConstraint,
    { facingMode: { ideal: "environment" } },
    true,
  ];

  let started = false;
  for (const constraint of constraintsToTry) {
    try {
      await initQuagga(target, constraint);
      started = true;
      break;
    } catch {
      try {
        Quagga.stop();
      } catch {
        // no-op
      }
      target.innerHTML = "";
    }
  }

  if (!started) {
    resetScanButton(false);
    alert("Camera start failed. Check camera permissions in browser settings.");
    return;
  }

  Quagga.offDetected(handleQuaggaDetected);
  Quagga.onDetected(handleQuaggaDetected);
  Quagga.start();
  quaggaStarted = true;

  const video = target.querySelector("video");
  if (video) {
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.setAttribute("autoplay", "true");
    video.muted = true;
    video.play().catch(() => {});
  }

  resetScanButton(false);
}

function handleQuaggaDetected(result) {
  if (!scanRequested) return;
  const text = result && result.codeResult ? result.codeResult.code : "";
  if (!text) return;

  scanRequested = false;
  clearScanRequestTimer();
  resetScanButton(false);
  onScanSuccess(text);
}

function triggerScan() {
  if (!quaggaStarted) return;
  scanRequested = true;

  const btn = document.getElementById("scanBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Scanning...";
  }

  clearScanRequestTimer();
  scanRequestTimer = setTimeout(() => {
    if (!scanRequested) return;
    scanRequested = false;
    resetScanButton(false);
    alert("No CODE_128 barcode found. Try again.");
  }, MANUAL_SCAN_TIMEOUT_MS);
}

function onScanSuccess(text) {
  const now = Date.now();
  if (text === lastScan && now - lastScanTime < DEBOUNCE_MS) return;

  lastScan = text;
  lastScanTime = now;
  showFeedback();

  if (mode === "plotSerial") {
    if (scanStep === "plot") {
      tempPlot = text;
      scanStep = "serial";
      updateScanStatus();
      return;
    }

    entries.push({
      num: entries.length + 1,
      plot: tempPlot,
      serial: text,
    });
    tempPlot = "";
    scanStep = "plot";
    updateScanStatus();
    return;
  }

  entries.push({ num: entries.length + 1, plot: "", serial: text });
}

function showFeedback() {
  const el = document.getElementById("scanFeedback");
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 600);
}

function stopCamera() {
  scanRequested = false;
  clearScanRequestTimer();
  resetScanButton(false);

  if (window.Quagga) {
    Quagga.offDetected(handleQuaggaDetected);
    if (quaggaStarted) {
      Quagga.stop();
      quaggaStarted = false;
    }
  }

  const target = document.getElementById("reader");
  if (target) target.innerHTML = "";
}

function startMode(m) {
  mode = m;
  entries = [];
  tempPlot = "";
  scanStep = mode === "plotSerial" ? "plot" : "serial";
  lastScan = "";
  lastScanTime = 0;
  updateScanStatus();
  showScreen("scannerScreen");
  startCamera();
}

function finishScanning() {
  stopCamera();
  showResults();
}

function showResults() {
  showScreen("resultsScreen");
  const container = document.getElementById("resultsContainer");
  if (!entries.length) {
    container.innerHTML = '<div class="no-data">No scans recorded.</div>';
    return;
  }

  let html =
    "<table><tr><th>Number</th><th>Plot Information</th><th>Serial Number</th></tr>";

  entries.forEach((e) => {
    const plot = e.plot ? e.plot : '<span class="empty-plot">—</span>';
    html += `<tr><td>${e.num}</td><td>${plot}</td><td>${e.serial}</td></tr>`;
  });

  html += "</table>";
  container.innerHTML = html;
}

function buildCSV() {
  let csv = "Number,Plot Information,Serial Number\n";
  entries.forEach((e) => {
    const plot = e.plot ? `"${e.plot.replace(/"/g, '""')}"` : "";
    const serial = `"${e.serial.replace(/"/g, '""')}"`;
    csv += `${e.num},${plot},${serial}\n`;
  });
  return csv;
}

function downloadCSV() {
  const blob = new Blob([buildCSV()], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scan_results.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function shareResults() {
  const csv = buildCSV();
  const blob = new Blob([csv], { type: "text/csv" });
  const file = new File([blob], "scan_results.csv", { type: "text/csv" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Scan Results" });
      return;
    } catch (e) {
      console.error(e);
    }
  }

  const text = entries
    .map((e) => `${e.num}. Plot: ${e.plot || "-"} | Serial: ${e.serial}`)
    .join("\n");

  const textBlob = new Blob([text], { type: "text/plain" });
  const textFile = new File([textBlob], "scan_results.txt", {
    type: "text/plain",
  });

  if (navigator.canShare && navigator.canShare({ files: [textFile] })) {
    try {
      await navigator.share({ files: [textFile], title: "Scan Results" });
      return;
    } catch (e) {
      console.error(e);
    }
  }

  alert("Web Share not supported. Use Download CSV instead.");
}

function restart() {
  stopCamera();
  entries = [];
  tempPlot = "";
  lastScan = "";
  lastScanTime = 0;
  showScreen("startScreen");
}

window.startMode = startMode;
window.triggerScan = triggerScan;
window.finishScanning = finishScanning;
window.shareResults = shareResults;
window.downloadCSV = downloadCSV;
window.restart = restart;
