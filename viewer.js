import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/+esm";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.mjs";

const state = {
  pdfDoc: null,
  pageCount: 0,
  currentPage: 1,
  scale: 1.0,
  detectionsByPage: new Map(),
  selectedPdfFile: null,
  screenRects: [],
  activeObjectId: null,
  mappingKind: "pdf-origin",
};

const ui = {
  pdfPath: document.getElementById("pdfPath"),
  jsonInput: document.getElementById("jsonInput"),
  pdfFile: document.getElementById("pdfFile"),
  choosePdfBtn: document.getElementById("choosePdfBtn"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  pdfFileName: document.getElementById("pdfFileName"),
  scaleInput: document.getElementById("scaleInput"),
  loadBtn: document.getElementById("loadBtn"),
  pageSelect: document.getElementById("pageSelect"),
  showLabels: document.getElementById("showLabels"),
  cursorCoords: document.getElementById("cursorCoords"),
  summary: document.getElementById("summary"),
  canvas: document.getElementById("pdfCanvas"),
  overlayCanvas: document.getElementById("overlayCanvas"),
  viewerWrap: document.getElementById("viewerWrap"),
  loader: document.getElementById("loader"),
  objectList: document.getElementById("objectList"),
  objectDetails: document.getElementById("objectDetails"),
};

let pendingRenderToken = 0;
let currentRenderTask = null;
let rafHandle = null;
let lastRenderedViewport = null;

function clampScale(value) {
  return Math.min(4, Math.max(0.2, value));
}

function setScale(nextScale) {
  const clamped = clampScale(nextScale);
  state.scale = clamped;
  ui.scaleInput.value = clamped.toFixed(2);
  scheduleRender();
}

function setLoading(isLoading) {
  ui.viewerWrap.classList.toggle("loading", isLoading);
  ui.loader.classList.toggle("hidden", !isLoading);
}

function clearViewer() {
  const ctx = ui.canvas.getContext("2d");
  const overlayCtx = ui.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
  overlayCtx.clearRect(0, 0, ui.overlayCanvas.width, ui.overlayCanvas.height);
  ui.objectList.innerHTML = "";
  ui.objectDetails.textContent = "No object selected.";
  ui.summary.textContent = "";
  ui.cursorCoords.textContent = "";
  state.activeObjectId = null;
  state.screenRects = [];
  lastRenderedViewport = null;
}

function normalizeDetectionData(raw) {
  const byPage = new Map();
  const containers = [];

  if (raw && typeof raw === "object") {
    containers.push(raw);
    if (raw.result && typeof raw.result === "object") containers.push(raw.result);
  }

  const seen = new Set();
  for (const container of containers) {
    for (const [key, value] of Object.entries(container)) {
      if (!Array.isArray(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        if (!item || typeof item !== "object") continue;
        const bbox = item.bbox;
        if (!bbox || typeof bbox !== "object") continue;
        const x1 = Number(bbox.x1);
        const y1 = Number(bbox.y1);
        const x2 = Number(bbox.x2);
        const y2 = Number(bbox.y2);
        if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
        const page = Number(item.page || item.page_number || 1);
        const kind = key.endsWith("s") ? key.slice(0, -1) : key;
        const id = String(item.id || `${kind}_${i + 1}`);
        const normalized = {
          id,
          kind,
          page,
          bbox: { x1, y1, x2, y2 },
        };
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page).push(normalized);
      }
    }
  }

  return byPage;
}

function parseJsonInput(text) {
  if (!text || !text.trim()) {
    throw new Error("JSON input is empty. Paste API response first.");
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON input: ${err.message}`);
  }
  const byPage = new Map();
  const parsed = normalizeDetectionData(raw);
  for (const [page, entries] of parsed.entries()) {
    byPage.set(page, entries);
  }
  return byPage;
}

async function readJsonFromPath(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to load JSON: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function readPdfDocument(path, file) {
  if (file) {
    const buffer = await file.arrayBuffer();
    return pdfjsLib.getDocument({ data: buffer }).promise;
  }
  return pdfjsLib.getDocument(path).promise;
}

function rectFromPdfOrigin(bbox, viewport) {
  const p1 = viewport.convertToViewportPoint(bbox.x1, bbox.y1);
  const p2 = viewport.convertToViewportPoint(bbox.x2, bbox.y2);
  const left = Math.min(p1[0], p2[0]);
  const right = Math.max(p1[0], p2[0]);
  const top = Math.min(p1[1], p2[1]);
  const bottom = Math.max(p1[1], p2[1]);
  return {
    x: left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function rectFromTopLeftOrigin(bbox, viewport) {
  const sx = viewport.scale;
  const x1 = bbox.x1 * sx;
  const y1 = bbox.y1 * sx;
  const x2 = bbox.x2 * sx;
  const y2 = bbox.y2 * sx;
  return {
    x: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function buildRects(detections, viewport, mappingKind) {
  return detections.map((d) => {
    const rect =
      mappingKind === "top-left-origin"
        ? rectFromTopLeftOrigin(d.bbox, viewport)
        : rectFromPdfOrigin(d.bbox, viewport);
    return { id: d.id, rect, data: d };
  });
}

function scoreRectsByInk(canvasCtx, rectEntries, viewport) {
  if (!rectEntries.length) return -1;
  const image = canvasCtx.getImageData(0, 0, viewport.width, viewport.height);
  const { data, width, height } = image;
  let darknessSum = 0;
  let points = 0;
  let offPage = 0;

  for (const entry of rectEntries) {
    const r = entry.rect;
    const left = Math.max(0, Math.floor(r.x));
    const right = Math.min(width - 1, Math.floor(r.x + r.width));
    const top = Math.max(0, Math.floor(r.top));
    const bottom = Math.min(height - 1, Math.floor(r.top + r.height));
    if (right <= left || bottom <= top) {
      offPage += 1;
      continue;
    }
    const sx = Math.max(1, Math.floor((right - left) / 4));
    const sy = Math.max(1, Math.floor((bottom - top) / 4));
    for (let y = top; y <= bottom; y += sy) {
      for (let x = left; x <= right; x += sx) {
        const idx = (y * width + x) * 4;
        const rC = data[idx];
        const gC = data[idx + 1];
        const bC = data[idx + 2];
        const bright = (rC + gC + bC) / 3;
        darknessSum += 255 - bright;
        points += 1;
      }
    }
  }

  if (!points) return -1000;
  const meanDarkness = darknessSum / points;
  return meanDarkness - offPage * 20;
}

function chooseBestMapping(detections, viewport) {
  if (!detections.length) return "pdf-origin";
  const ctx = ui.canvas.getContext("2d", { willReadFrequently: true });
  const pdfRects = buildRects(detections, viewport, "pdf-origin");
  const topLeftRects = buildRects(detections, viewport, "top-left-origin");
  const pdfScore = scoreRectsByInk(ctx, pdfRects, viewport);
  const topLeftScore = scoreRectsByInk(ctx, topLeftRects, viewport);
  return topLeftScore > pdfScore ? "top-left-origin" : "pdf-origin";
}

function compactLabel(id) {
  if (!id) return "door";
  if (id.length <= 10) return id;
  return `${id.slice(0, 8)}...`;
}

function formatN(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "NaN";
}

function objectText(d) {
  const b = d.bbox;
  return `${d.id}\ntype: ${d.kind || "unknown"}\npage: ${d.page}\nx: [${formatN(b.x1)}, ${formatN(b.x2)}]\ny: [${formatN(b.y1)}, ${formatN(b.y2)}]`;
}

function getBboxRange(detections) {
  if (!detections.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const d of detections) {
    minX = Math.min(minX, d.bbox.x1, d.bbox.x2);
    minY = Math.min(minY, d.bbox.y1, d.bbox.y2);
    maxX = Math.max(maxX, d.bbox.x1, d.bbox.x2);
    maxY = Math.max(maxY, d.bbox.y1, d.bbox.y2);
  }
  return { minX, minY, maxX, maxY };
}

function renderObjectList(detections) {
  ui.objectList.innerHTML = "";
  for (const d of detections) {
    const li = document.createElement("li");
    li.className = "object-item";
    li.dataset.id = d.id;
    li.innerHTML = `
      <div class="object-id">${d.kind || "object"}: ${d.id}</div>
      <div class="object-meta">p${d.page} | x ${formatN(d.bbox.x1)}-${formatN(d.bbox.x2)} | y ${formatN(d.bbox.y1)}-${formatN(d.bbox.y2)}</div>
    `;
    li.addEventListener("mouseenter", () => setActiveObject(d.id));
    li.addEventListener("mouseleave", () => setActiveObject(null));
    li.addEventListener("click", () => setActiveObject(d.id));
    ui.objectList.appendChild(li);
  }
}

function setActiveObject(id) {
  state.activeObjectId = id;
  for (const item of ui.objectList.querySelectorAll(".object-item")) {
    const active = item.dataset.id === id;
    item.classList.toggle("active", active);
  }
  const hit = state.screenRects.find((r) => r.id === id);
  ui.objectDetails.textContent = hit ? objectText(hit.data) : "No object selected.";
  if (lastRenderedViewport) {
    const detections = state.detectionsByPage.get(state.currentPage) || [];
    drawOverlay(detections, lastRenderedViewport, state.mappingKind);
  }
}

function drawOverlay(detections, viewport, mappingKind) {
  const ctx = ui.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, ui.overlayCanvas.width, ui.overlayCanvas.height);
  ctx.textBaseline = "top";
  state.screenRects = [];
  const showLabels = ui.showLabels.checked;
  let outOfBounds = 0;

  for (const d of detections) {
    const rect =
      mappingKind === "top-left-origin"
        ? rectFromTopLeftOrigin(d.bbox, viewport)
        : rectFromPdfOrigin(d.bbox, viewport);
    const isOutside =
      rect.x + rect.width < 0 ||
      rect.top + rect.height < 0 ||
      rect.x > viewport.width ||
      rect.top > viewport.height;
    if (isOutside) outOfBounds += 1;
    const active = state.activeObjectId === d.id;
    ctx.lineWidth = active ? 4 : 3;
    ctx.strokeStyle = active ? "#ffe600" : "#ff224f";
    ctx.strokeRect(rect.x, rect.top, rect.width, rect.height);

    if (showLabels) {
      const text = compactLabel(d.id);
      ctx.font = "10px sans-serif";
      const tw = Math.ceil(ctx.measureText(text).width);
      const tx = rect.x;
      const ty = Math.max(0, rect.top - 14);
      ctx.fillStyle = active ? "#ffe600" : "#ff224f";
      ctx.fillRect(tx, ty, tw + 8, 12);
      ctx.fillStyle = "#111";
      ctx.fillText(text, tx + 4, ty + 1);
    }
    state.screenRects.push({ id: d.id, rect, data: d });
  }

  return outOfBounds;
}

function updateCursorCoordinates(evt) {
  if (!lastRenderedViewport) return;
  const rect = ui.canvas.getBoundingClientRect();
  const cx = evt.clientX - rect.left;
  const cy = evt.clientY - rect.top;
  const [pdfX, pdfY] = lastRenderedViewport.convertToPdfPoint(cx, cy);
  ui.cursorCoords.textContent = `cursor px: (${formatN(cx)}, ${formatN(cy)}) | pdf: (${formatN(pdfX)}, ${formatN(pdfY)})`;
}

async function renderPage(pageNum, token) {
  const page = await state.pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: state.scale });
  lastRenderedViewport = viewport;
  const w = Math.round(viewport.width);
  const h = Math.round(viewport.height);
  ui.canvas.width = w;
  ui.canvas.height = h;
  ui.overlayCanvas.width = w;
  ui.overlayCanvas.height = h;
  ui.canvas.style.width = `${w}px`;
  ui.canvas.style.height = `${h}px`;
  ui.overlayCanvas.style.width = `${w}px`;
  ui.overlayCanvas.style.height = `${h}px`;

  const ctx = ui.canvas.getContext("2d", { alpha: false });
  if (currentRenderTask) {
    try {
      currentRenderTask.cancel();
    } catch {
      // ignore cancel race
    }
  }
  currentRenderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await currentRenderTask.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
  } finally {
    currentRenderTask = null;
  }

  if (token !== pendingRenderToken) return;

  const detections = state.detectionsByPage.get(pageNum) || [];
  state.mappingKind = chooseBestMapping(detections, viewport);
  const outOfBounds = drawOverlay(detections, viewport, state.mappingKind);
  const range = getBboxRange(detections);
  renderObjectList(detections);
  setActiveObject(null);
  ui.summary.textContent = [
    `Page ${pageNum}/${state.pageCount}`,
    `${detections.length} objects`,
    `scale=${state.scale.toFixed(2)}`,
    `mapping=${state.mappingKind}`,
    `pdf=${formatN(baseViewport.width)}x${formatN(baseViewport.height)} pt`,
    range
      ? `bbox x=[${formatN(range.minX)},${formatN(range.maxX)}], y=[${formatN(range.minY)},${formatN(range.maxY)}]`
      : "bbox n/a",
    `off-page=${outOfBounds}`,
  ].join(" | ");
}

function scheduleRender() {
  if (!state.pdfDoc) return;
  pendingRenderToken += 1;
  const token = pendingRenderToken;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = requestAnimationFrame(() => {
    renderPage(state.currentPage, token).catch((err) => {
      ui.summary.textContent = `Render error: ${err.message}`;
    });
  });
}

function fillPageSelector() {
  ui.pageSelect.innerHTML = "";
  for (let i = 1; i <= state.pageCount; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Page ${i}`;
    if (i === state.currentPage) opt.selected = true;
    ui.pageSelect.appendChild(opt);
  }
}

function updatePickedFileNames() {
  ui.pdfFileName.textContent = state.selectedPdfFile ? state.selectedPdfFile.name : "none";
}

async function loadSampleJson() {
  const raw = await readJsonFromPath("./data/doors-response.json");
  ui.jsonInput.value = JSON.stringify(raw, null, 2);
}

async function loadAll() {
  const pdfPath = ui.pdfPath.value.trim();
  const scale = clampScale(Number(ui.scaleInput.value));
  ui.scaleInput.value = scale.toFixed(2);
  state.scale = scale;

  if (!pdfPath && !state.selectedPdfFile) {
    ui.summary.textContent = "Set PDF path or choose a PDF file.";
    return;
  }
  try {
    setLoading(true);
    clearViewer();

    const [pdfDoc, detectionsByPage] = await Promise.all([
      readPdfDocument(pdfPath, state.selectedPdfFile),
      Promise.resolve(parseJsonInput(ui.jsonInput.value)),
    ]);

    state.pdfDoc = pdfDoc;
    state.pageCount = pdfDoc.numPages;
    state.currentPage = 1;
    state.detectionsByPage = detectionsByPage;

    fillPageSelector();
    await renderPage(state.currentPage, ++pendingRenderToken);
  } catch (err) {
    ui.summary.textContent = `Load failed: ${err.message}`;
    console.error(err);
  } finally {
    setLoading(false);
  }
}

ui.loadBtn.addEventListener("click", () => {
  loadAll();
});

ui.pageSelect.addEventListener("change", (e) => {
  state.currentPage = Number(e.target.value);
  scheduleRender();
});

ui.showLabels.addEventListener("change", () => {
  scheduleRender();
});

ui.scaleInput.addEventListener("change", () => {
  setScale(Number(ui.scaleInput.value));
});

ui.choosePdfBtn.addEventListener("click", () => ui.pdfFile.click());
ui.loadSampleBtn.addEventListener("click", () => {
  loadSampleJson().catch((err) => {
    ui.summary.textContent = `Failed to load sample JSON: ${err.message}`;
  });
});

ui.pdfFile.addEventListener("change", (e) => {
  state.selectedPdfFile = e.target.files?.[0] || null;
  updatePickedFileNames();
});

function pickObjectAt(clientX, clientY) {
  const rect = ui.overlayCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  for (let i = state.screenRects.length - 1; i >= 0; i -= 1) {
    const hit = state.screenRects[i];
    const r = hit.rect;
    if (x >= r.x && x <= r.x + r.width && y >= r.top && y <= r.top + r.height) {
      return hit.id;
    }
  }
  return null;
}

ui.overlayCanvas.addEventListener("mousemove", (e) => {
  updateCursorCoordinates(e);
  const id = pickObjectAt(e.clientX, e.clientY);
  if (id !== state.activeObjectId) setActiveObject(id);
});

ui.overlayCanvas.addEventListener("click", (e) => {
  const id = pickObjectAt(e.clientX, e.clientY);
  setActiveObject(id);
});

ui.overlayCanvas.addEventListener("mouseleave", () => {
  ui.cursorCoords.textContent = "";
  setActiveObject(null);
});

window.addEventListener(
  "wheel",
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const step = event.deltaY > 0 ? -0.04 : 0.04;
    setScale(state.scale + step);
  },
  { passive: false },
);

loadSampleJson()
  .then(() => loadAll())
  .catch((err) => {
    ui.summary.textContent = `Failed to initialize sample JSON: ${err.message}`;
  });
