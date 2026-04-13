import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/+esm";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.mjs";

const MAX_WARNINGS = 25;
const LIGHT_THEME = "light";
const DARK_THEME = "dark";

const state = {
  pdfDoc: null,
  pageCount: 0,
  currentPage: 1,
  scale: 1.0,
  detectionsByPage: new Map(),
  csvPageExtents: new Map(),
  selectedPdfFile: null,
  selectedCsvFile: null,
  screenRects: [],
  activeObjectId: null,
  pinnedObjectId: null,
  mappingKind: "pdf-origin",
  mappingPreference: "auto",
  mappingScores: { pdf: 0, topLeft: 0 },
  mappingDebug: "",
  parseStats: {
    accepted: 0,
    rejected: 0,
    arraysScanned: 0,
    warnings: [],
  },
  jsonStats: {
    accepted: 0,
    rejected: 0,
    arraysScanned: 0,
    warnings: [],
  },
  csvStats: {
    accepted: 0,
    rejected: 0,
    arraysScanned: 0,
    warnings: [],
  },
  cursorPoint: null,
  showCursorGuide: true,
  theme: LIGHT_THEME,
  gestureStartScale: null,
  lastPdfSourceKey: "",
  sourceMode: "json",
};

const ui = {
  pdfPath: document.getElementById("pdfPath"),
  jsonInput: document.getElementById("jsonInput"),
  pdfFile: document.getElementById("pdfFile"),
  choosePdfBtn: document.getElementById("choosePdfBtn"),
  csvFile: document.getElementById("csvFile"),
  chooseCsvBtn: document.getElementById("chooseCsvBtn"),
  sourceModeJsonBtn: document.getElementById("sourceModeJsonBtn"),
  sourceModeCsvBtn: document.getElementById("sourceModeCsvBtn"),
  pdfFileName: document.getElementById("pdfFileName"),
  csvFileName: document.getElementById("csvFileName"),
  csvStatusPill: document.getElementById("csvStatusPill"),
  csvSourceBlock: document.getElementById("csvSourcePanel"),
  jsonSourcePanel: document.getElementById("jsonSourcePanel"),
  scaleInput: document.getElementById("scaleInput"),
  loadBtn: document.getElementById("loadBtn"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageSelect: document.getElementById("pageSelect"),
  pageIndicator: document.getElementById("pageIndicator"),
  showLabels: document.getElementById("showLabels"),
  showCursorGuide: document.getElementById("showCursorGuide"),
  mappingMode: document.getElementById("mappingMode"),
  fitPageBtn: document.getElementById("fitPageBtn"),
  resetZoomBtn: document.getElementById("resetZoomBtn"),
  togglePanelBtn: document.getElementById("togglePanelBtn"),
  docsBtn: document.getElementById("docsBtn"),
  themeToggleBtn: document.getElementById("themeToggleBtn"),
  jsonStats: document.getElementById("jsonStats"),
  jsonWarnings: document.getElementById("jsonWarnings"),
  csvStats: document.getElementById("csvStats"),
  csvWarnings: document.getElementById("csvWarnings"),
  cursorCoords: document.getElementById("cursorCoords"),
  summary: document.getElementById("summary"),
  canvas: document.getElementById("pdfCanvas"),
  overlayCanvas: document.getElementById("overlayCanvas"),
  viewerWrap: document.getElementById("viewerWrap"),
  viewerPane: document.getElementById("viewerPane"),
  loader: document.getElementById("loader"),
  objectList: document.getElementById("objectList"),
  objectDetails: document.getElementById("objectDetails"),
};

let pendingRenderToken = 0;
let currentRenderTask = null;
let renderRafHandle = null;
let hoverRafHandle = null;
let lastPointerEvent = null;
let lastRenderedViewport = null;
let lastBaseViewport = null;

function clampScale(value) {
  return Math.min(6, Math.max(0.2, value));
}

function formatN(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "NaN";
}

function singularize(name) {
  if (!name) return "object";
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  if (name.endsWith("ses")) return name.slice(0, -2);
  if (name.endsWith("s") && name.length > 1) return name.slice(0, -1);
  return name;
}

function normalizeKind(pathParts) {
  for (let i = pathParts.length - 1; i >= 0; i -= 1) {
    const raw = pathParts[i];
    if (!raw || /^\d+$/.test(raw)) continue;
    return singularize(raw.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
  }
  return "object";
}

function addWarning(warnings, message) {
  if (warnings.length < MAX_WARNINGS) warnings.push(message);
}

function getBBoxFromItem(item) {
  if (!item || typeof item !== "object") return null;
  const source = item.bbox && typeof item.bbox === "object" ? item.bbox : item;
  const x1 = Number(source.x1);
  const y1 = Number(source.y1);
  const x2 = Number(source.x2);
  const y2 = Number(source.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x1, y1, x2, y2 };
}

function normalizeDetectionData(raw) {
  const byPage = new Map();
  const warnings = [];
  const usedIds = new Set();
  const kindPageCounters = new Map();
  let accepted = 0;
  let rejected = 0;
  let arraysScanned = 0;

  function nextFallbackId(kind, page) {
    const key = `${kind}::${page}`;
    const n = (kindPageCounters.get(key) || 0) + 1;
    kindPageCounters.set(key, n);
    return `${kind}_${page}_${n}`;
  }

  function ensureUniqueId(id) {
    let safeId = id;
    let suffix = 1;
    while (usedIds.has(safeId)) {
      safeId = `${id}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(safeId);
    return safeId;
  }

  function visit(node, pathParts) {
    if (Array.isArray(node)) {
      arraysScanned += 1;
      const kind = normalizeKind(pathParts);
      for (let i = 0; i < node.length; i += 1) {
        const item = node[i];
        if (!item || typeof item !== "object") {
          rejected += 1;
          addWarning(warnings, `Skipped ${[...pathParts, String(i)].join(".")}: item is not an object.`);
          continue;
        }
        const bbox = getBBoxFromItem(item);
        if (!bbox) {
          rejected += 1;
          addWarning(
            warnings,
            `Skipped ${[...pathParts, String(i)].join(".")}: missing numeric bbox (x1,y1,x2,y2).`,
          );
          continue;
        }
        const page = Number(item.page ?? item.page_number ?? 1);
        if (!Number.isFinite(page) || page < 1) {
          rejected += 1;
          addWarning(
            warnings,
            `Skipped ${[...pathParts, String(i)].join(".")}: invalid page/page_number value.`,
          );
          continue;
        }
        const pageInt = Math.floor(page);
        const fallbackId = nextFallbackId(kind, pageInt);
        const sourceId =
          item.id === undefined || item.id === null || String(item.id).trim() === ""
            ? fallbackId
            : String(item.id).trim();
        const id = ensureUniqueId(sourceId);
        const normalized = {
          id,
          kind,
          page: pageInt,
          bbox,
        };
        if (!byPage.has(pageInt)) byPage.set(pageInt, []);
        byPage.get(pageInt).push(normalized);
        accepted += 1;
      }
      return;
    }

    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      visit(value, [...pathParts, key]);
    }
  }

  if (Array.isArray(raw)) visit(raw, ["objects"]);
  else visit(raw, ["root"]);

  return {
    byPage,
    stats: { accepted, rejected, arraysScanned, warnings },
  };
}

function parseJsonInput(text) {
  if (!text || !text.trim()) {
    return {
      byPage: new Map(),
      stats: {
        accepted: 0,
        rejected: 0,
        arraysScanned: 0,
        warnings: [],
      },
    };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON input: ${err.message}`);
  }
  const parsed = normalizeDetectionData(raw);
  if (!parsed.stats.accepted) {
    throw new Error("No valid detections found. Need bbox x1,y1,x2,y2 and optional page/page_number.");
  }
  return parsed;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function parseCsvInput(text) {
  if (!text || !text.trim()) {
    return {
      byPage: new Map(),
      csvExtents: new Map(),
      stats: { accepted: 0, rejected: 0, arraysScanned: 0, warnings: [] },
    };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return {
      byPage: new Map(),
      csvExtents: new Map(),
      stats: { accepted: 0, rejected: 1, arraysScanned: 1, warnings: ["CSV has no data rows."] },
    };
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (name) => headers.indexOf(name);
  const x0Idx = idx("x0");
  const y0Idx = idx("y0");
  const x1Idx = idx("x1");
  const y1Idx = idx("y1");
  const pageIdx = [idx("document page number"), idx("page"), idx("page number")].find((v) => v >= 0);
  const kindIdx = [idx("subclass description"), idx("class"), idx("label"), idx("type")].find((v) => v >= 0);

  const warnings = [];
  const byPage = new Map();
  const csvExtents = new Map();
  let accepted = 0;
  let rejected = 0;

  if ([x0Idx, y0Idx, x1Idx, y1Idx].some((v) => v < 0)) {
    return {
      byPage,
      csvExtents,
      stats: {
        accepted,
        rejected: 1,
        arraysScanned: lines.length - 1,
        warnings: ["CSV requires columns: x0,y0,x1,y1."],
      },
    };
  }

  for (let lineNo = 1; lineNo < lines.length; lineNo += 1) {
    const row = parseCsvLine(lines[lineNo]);
    const x0 = Number(row[x0Idx]);
    const y0 = Number(row[y0Idx]);
    const x1 = Number(row[x1Idx]);
    const y1 = Number(row[y1Idx]);
    if (![x0, y0, x1, y1].every(Number.isFinite)) {
      rejected += 1;
      addWarning(warnings, `CSV row ${lineNo + 1}: invalid bbox values.`);
      continue;
    }
    const rawPage = pageIdx >= 0 ? Number(row[pageIdx]) : 1;
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const kindRaw = kindIdx >= 0 ? row[kindIdx] : "csv_object";
    const kind = singularize(String(kindRaw || "csv_object").toLowerCase().replace(/[^a-z0-9_]/g, "_"));
    const id = `csv_${page}_${lineNo}`;
    const detection = {
      id,
      kind,
      page,
      coordSpace: "csv-pixel",
      bbox: { x1: x0, y1: y0, x2: x1, y2: y1 },
    };
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(detection);
    const ext = csvExtents.get(page) || {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    };
    ext.minX = Math.min(ext.minX, x0, x1);
    ext.minY = Math.min(ext.minY, y0, y1);
    ext.maxX = Math.max(ext.maxX, x0, x1);
    ext.maxY = Math.max(ext.maxY, y0, y1);
    csvExtents.set(page, ext);
    accepted += 1;
  }

  return {
    byPage,
    csvExtents,
    stats: { accepted, rejected, arraysScanned: lines.length - 1, warnings },
  };
}

function mergeParsedSources(jsonParsed, csvParsed) {
  const byPage = new Map();
  for (const [page, arr] of jsonParsed.byPage.entries()) {
    byPage.set(page, [...arr]);
  }
  for (const [page, arr] of csvParsed.byPage.entries()) {
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(...arr);
  }

  return {
    byPage,
    csvExtents: csvParsed.csvExtents,
    stats: {
      accepted: jsonParsed.stats.accepted + csvParsed.stats.accepted,
      rejected: jsonParsed.stats.rejected + csvParsed.stats.rejected,
      arraysScanned: jsonParsed.stats.arraysScanned + csvParsed.stats.arraysScanned,
      warnings: [...jsonParsed.stats.warnings, ...csvParsed.stats.warnings].slice(0, MAX_WARNINGS),
    },
  };
}

async function readPdfDocument(path, file) {
  if (file) {
    const buffer = await file.arrayBuffer();
    return pdfjsLib.getDocument({ data: buffer }).promise;
  }
  return pdfjsLib.getDocument(path).promise;
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
  state.pinnedObjectId = null;
  state.screenRects = [];
  state.csvPageExtents = new Map();
  state.cursorPoint = null;
  lastRenderedViewport = null;
  lastBaseViewport = null;
  updatePagerControls();
}

function renderWarningList(container, warnings) {
  if (!container) return;
  container.innerHTML = "";
  if (!warnings.length) return;
  for (const warning of warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    container.appendChild(li);
  }
}

function renderParseFeedback() {
  const j = state.jsonStats;
  const c = state.csvStats;
  if (ui.jsonStats) {
    ui.jsonStats.textContent = `JSON: ${j.accepted} accepted, ${j.rejected} rejected, scanned: ${j.arraysScanned}`;
  }
  if (ui.csvStats) {
    ui.csvStats.textContent = state.selectedCsvFile
      ? `CSV: ${c.accepted} accepted, ${c.rejected} rejected, rows: ${c.arraysScanned ? c.accepted + c.rejected : 0}`
      : "No CSV selected.";
  }
  renderWarningList(ui.jsonWarnings, j.warnings || []);
  renderWarningList(ui.csvWarnings, c.warnings || []);
}

function rectFromPdfOrigin(bbox, viewport) {
  const p1 = viewport.convertToViewportPoint(bbox.x1, bbox.y1);
  const p2 = viewport.convertToViewportPoint(bbox.x2, bbox.y2);
  return {
    x: Math.min(p1[0], p2[0]),
    top: Math.min(p1[1], p2[1]),
    width: Math.abs(p2[0] - p1[0]),
    height: Math.abs(p2[1] - p1[1]),
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

function rectFromCsvPixels(bbox, viewport, page, mappingKind) {
  const ext = state.csvPageExtents.get(page) || {
    minX: 0,
    minY: 0,
    maxX: viewport.width,
    maxY: viewport.height,
  };
  const rangeX = Math.max(1, ext.maxX - ext.minX);
  const rangeY = Math.max(1, ext.maxY - ext.minY);

  let x1 = bbox.x1;
  let y1 = bbox.y1;
  let x2 = bbox.x2;
  let y2 = bbox.y2;
  let sx = 1;
  let sy = 1;
  let ox = 0;
  let oy = 0;

  if (mappingKind === "csv-raw-top-left") {
    sx = viewport.scale;
    sy = viewport.scale;
  } else if (mappingKind === "csv-raw-top-left-yflip") {
    const pageHeightPt = viewport.height / Math.max(0.0001, viewport.scale);
    y1 = pageHeightPt - y1;
    y2 = pageHeightPt - y2;
    sx = viewport.scale;
    sy = viewport.scale;
  } else if (mappingKind === "csv-raw-pdf-origin") {
    return rectFromPdfOrigin(bbox, viewport);
  } else if (mappingKind === "csv-max") {
    sx = viewport.width / Math.max(1, ext.maxX);
    sy = viewport.height / Math.max(1, ext.maxY);
  } else if (mappingKind === "csv-fit") {
    x1 -= ext.minX;
    x2 -= ext.minX;
    y1 -= ext.minY;
    y2 -= ext.minY;
    sx = viewport.width / rangeX;
    sy = viewport.height / rangeY;
  } else {
    const useYFlip = mappingKind === "csv-fit-uniform-yflip";
    x1 -= ext.minX;
    x2 -= ext.minX;
    y1 -= ext.minY;
    y2 -= ext.minY;
    if (useYFlip) {
      y1 = rangeY - y1;
      y2 = rangeY - y2;
    }
    const s = Math.min(viewport.width / rangeX, viewport.height / rangeY);
    sx = s;
    sy = s;
    ox = (viewport.width - rangeX * s) / 2;
    oy = (viewport.height - rangeY * s) / 2;
  }

  const px1 = x1 * sx + ox;
  const py1 = y1 * sy + oy;
  const px2 = x2 * sx + ox;
  const py2 = y2 * sy + oy;

  return {
    x: Math.min(px1, px2),
    top: Math.min(py1, py2),
    width: Math.abs(px2 - px1),
    height: Math.abs(py2 - py1),
  };
}

function buildRects(detections, viewport, mappingKind) {
  return detections.map((d) => {
    let rect;
    if (d.coordSpace === "csv-pixel") {
      const csvKind = mappingKind.startsWith("csv-") ? mappingKind : "csv-fit-uniform";
      rect = rectFromCsvPixels(d.bbox, viewport, d.page, csvKind);
    } else {
      rect = mappingKind === "top-left-origin" ? rectFromTopLeftOrigin(d.bbox, viewport) : rectFromPdfOrigin(d.bbox, viewport);
    }
    return { id: d.id, rect, data: d };
  });
}

function scoreRectsByInk(canvasCtx, rectEntries, viewport) {
  if (!rectEntries.length) return -1000;
  const w = canvasCtx.canvas.width;
  const h = canvasCtx.canvas.height;
  const image = canvasCtx.getImageData(0, 0, w, h);
  const { data, width, height } = image;
  const scaleX = width / Math.max(1, viewport.width);
  const scaleY = height / Math.max(1, viewport.height);
  let darknessSum = 0;
  let points = 0;
  let offPage = 0;

  for (const entry of rectEntries) {
    const r = entry.rect;
    const left = Math.max(0, Math.floor(r.x * scaleX));
    const right = Math.min(width - 1, Math.floor((r.x + r.width) * scaleX));
    const top = Math.max(0, Math.floor(r.top * scaleY));
    const bottom = Math.min(height - 1, Math.floor((r.top + r.height) * scaleY));
    if (right <= left || bottom <= top) {
      offPage += 1;
      continue;
    }
    const sx = Math.max(1, Math.floor((right - left) / 4));
    const sy = Math.max(1, Math.floor((bottom - top) / 4));
    for (let y = top; y <= bottom; y += sy) {
      for (let x = left; x <= right; x += sx) {
        const idx = (y * width + x) * 4;
        const bright = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        darknessSum += 255 - bright;
        points += 1;
      }
    }
  }
  if (!points) return -1000;
  return darknessSum / points - offPage * 20;
}

function chooseBestMapping(detections, viewport) {
  if (!detections.length) return { kind: "pdf-origin", pdfScore: 0, topLeftScore: 0 };
  const ctx = ui.canvas.getContext("2d", { willReadFrequently: true });
  const pdfRects = buildRects(detections, viewport, "pdf-origin");
  const topLeftRects = buildRects(detections, viewport, "top-left-origin");
  const pdfScore = scoreRectsByInk(ctx, pdfRects, viewport);
  const topLeftScore = scoreRectsByInk(ctx, topLeftRects, viewport);
  return {
    kind: topLeftScore > pdfScore ? "top-left-origin" : "pdf-origin",
    pdfScore,
    topLeftScore,
  };
}

function chooseBestCsvMapping(detections, viewport) {
  if (!detections.length) return { kind: "csv-raw-top-left", scores: {} };
  const ctx = ui.canvas.getContext("2d", { willReadFrequently: true });
  const candidates = [
    "csv-raw-top-left",
    "csv-raw-top-left-yflip",
    "csv-raw-pdf-origin",
    "csv-max",
    "csv-fit",
    "csv-fit-uniform",
    "csv-fit-uniform-yflip",
  ];
  let bestKind = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  const scores = {};
  for (const kind of candidates) {
    const rects = buildRects(detections, viewport, kind);
    const score = scoreRectsByInk(ctx, rects, viewport);
    scores[kind] = score;
    if (score > bestScore) {
      bestScore = score;
      bestKind = kind;
    }
  }
  return { kind: bestKind, scores };
}

function compactLabel(id) {
  if (!id) return "obj";
  if (id.length <= 14) return id;
  return `${id.slice(0, 12)}...`;
}

function objectText(d) {
  const b = d.bbox;
  return `${d.id}\ntype: ${d.kind || "object"}\npage: ${d.page}\nx: [${formatN(b.x1)}, ${formatN(b.x2)}]\ny: [${formatN(b.y1)}, ${formatN(b.y2)}]`;
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
    li.addEventListener("mouseenter", () => {
      if (!state.pinnedObjectId) setActiveObject(d.id);
    });
    li.addEventListener("mouseleave", () => {
      if (!state.pinnedObjectId) setActiveObject(null);
    });
    li.addEventListener("click", () => {
      togglePinnedObject(d.id);
    });
    ui.objectList.appendChild(li);
  }
}

function setPinnedObject(id) {
  state.pinnedObjectId = id || null;
  setActiveObject(state.pinnedObjectId);
}

function togglePinnedObject(id) {
  if (!id) {
    setPinnedObject(null);
    return;
  }
  if (state.pinnedObjectId === id) {
    setPinnedObject(null);
    return;
  }
  setPinnedObject(id);
}

function drawCursorGuide(ctx, viewport) {
  if (!state.showCursorGuide || !state.cursorPoint) return;
  const { x, y } = state.cursorPoint;
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 193, 7, 0.85)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, viewport.height);
  ctx.moveTo(0, y);
  ctx.lineTo(viewport.width, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffbf00";
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawOverlayFromRects(rectEntries, viewport) {
  const ctx = ui.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, ui.overlayCanvas.width, ui.overlayCanvas.height);
  ctx.textBaseline = "top";
  const showLabels = ui.showLabels.checked;
  let outOfBounds = 0;

  for (const entry of rectEntries) {
    const d = entry.data;
    const rect = entry.rect;
    const isOutside =
      rect.x + rect.width < 0 ||
      rect.top + rect.height < 0 ||
      rect.x > viewport.width ||
      rect.top > viewport.height;
    if (isOutside) outOfBounds += 1;
    const active = state.activeObjectId === d.id;
    ctx.lineWidth = active ? 3.5 : 2.5;
    ctx.strokeStyle = active ? "#ffe77a" : "#ff3d66";
    ctx.strokeRect(rect.x, rect.top, rect.width, rect.height);

    if (showLabels) {
      const text = compactLabel(d.id);
      ctx.font = "11px Inter, sans-serif";
      const tw = Math.ceil(ctx.measureText(text).width);
      const tx = rect.x;
      const ty = Math.max(0, rect.top - 15);
      ctx.fillStyle = active ? "#ffe77a" : "#ff3d66";
      ctx.fillRect(tx, ty, tw + 8, 13);
      ctx.fillStyle = "#0e1020";
      ctx.fillText(text, tx + 4, ty + 1);
    }
  }

  drawCursorGuide(ctx, viewport);
  return outOfBounds;
}

function setActiveObject(id) {
  state.activeObjectId = id;
  for (const item of ui.objectList.querySelectorAll(".object-item")) {
    item.classList.toggle("active", item.dataset.id === id);
  }
  const hit = state.screenRects.find((r) => r.id === id);
  ui.objectDetails.textContent = hit ? objectText(hit.data) : "No object selected.";
  if (lastRenderedViewport) drawOverlayFromRects(state.screenRects, lastRenderedViewport);
}

function updateCursorCoordinates(evt) {
  if (!lastRenderedViewport) return;
  const rect = ui.overlayCanvas.getBoundingClientRect();
  const cx = evt.clientX - rect.left;
  const cy = evt.clientY - rect.top;
  state.cursorPoint = { x: cx, y: cy };
  const [pdfX, pdfY] = lastRenderedViewport.convertToPdfPoint(cx, cy);
  ui.cursorCoords.textContent = `cursor px: (${formatN(cx)}, ${formatN(cy)}) | pdf: (${formatN(pdfX)}, ${formatN(pdfY)})`;
}

function pickObjectAt(clientX, clientY) {
  const rect = ui.overlayCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  for (let i = state.screenRects.length - 1; i >= 0; i -= 1) {
    const hit = state.screenRects[i];
    const r = hit.rect;
    if (x >= r.x && x <= r.x + r.width && y >= r.top && y <= r.top + r.height) return hit.id;
  }
  return null;
}

function scheduleHoverUpdate(evt) {
  lastPointerEvent = evt;
  if (hoverRafHandle) return;
  hoverRafHandle = requestAnimationFrame(() => {
    hoverRafHandle = null;
    if (!lastPointerEvent) return;
    updateCursorCoordinates(lastPointerEvent);
    if (!state.pinnedObjectId) {
      const id = pickObjectAt(lastPointerEvent.clientX, lastPointerEvent.clientY);
      if (id !== state.activeObjectId) setActiveObject(id);
      else if (lastRenderedViewport) drawOverlayFromRects(state.screenRects, lastRenderedViewport);
    } else if (lastRenderedViewport) {
      drawOverlayFromRects(state.screenRects, lastRenderedViewport);
    }
  });
}

function getRenderMapping(detections, viewport) {
  const csvOnly = detections.length > 0 && detections.every((d) => d.coordSpace === "csv-pixel");
  if (csvOnly) {
    if (state.mappingPreference !== "auto" && state.mappingPreference.startsWith("csv-")) {
      state.mappingScores = { pdf: 0, topLeft: 0 };
      state.mappingDebug = `csv=${state.mappingPreference}`;
      return state.mappingPreference;
    }
    const csvAuto = chooseBestCsvMapping(detections, viewport);
    state.mappingScores = { pdf: 0, topLeft: 0 };
    state.mappingDebug = `csv scores: ${Object.entries(csvAuto.scores)
      .map(([k, v]) => `${k}:${formatN(v)}`)
      .join(", ")}`;
    return csvAuto.kind;
  }
  state.mappingDebug = "";
  const pdfDetections = detections.filter((d) => d.coordSpace !== "csv-pixel");
  const auto = chooseBestMapping(pdfDetections, viewport);
  state.mappingScores = { pdf: auto.pdfScore, topLeft: auto.topLeftScore };
  if (state.mappingPreference.startsWith("csv-")) {
    return auto.kind;
  }
  if (state.mappingPreference === "auto") return auto.kind;
  return state.mappingPreference;
}

function setScale(nextScale, { shouldRender = true } = {}) {
  const clamped = clampScale(nextScale);
  state.scale = clamped;
  ui.scaleInput.value = clamped.toFixed(2);
  if (shouldRender) scheduleRender();
}

function isZoomIntentFromWheel(event) {
  if (event.ctrlKey || event.metaKey) return true;
  return false;
}

function applyTrackpadZoomFromWheel(event) {
  const sensitivity = 0.0025;
  const zoomFactor = Math.exp(-event.deltaY * sensitivity);
  const nextScale = clampScale(state.scale * zoomFactor);
  if (Math.abs(nextScale - state.scale) < 0.001) return;
  setScale(nextScale);
}

function updateSummary(detections, outOfBounds) {
  const range = getBboxRange(detections);
  ui.summary.textContent = [
    `page ${state.currentPage}/${state.pageCount}`,
    `${detections.length} objects`,
    `scale=${state.scale.toFixed(2)}`,
    `map=${state.mappingKind}`,
    `scores(pdf=${formatN(state.mappingScores.pdf)}, top=${formatN(state.mappingScores.topLeft)})`,
    lastBaseViewport ? `pdf=${formatN(lastBaseViewport.width)}x${formatN(lastBaseViewport.height)} pt` : "",
    range ? `bbox x=[${formatN(range.minX)}, ${formatN(range.maxX)}], y=[${formatN(range.minY)}, ${formatN(range.maxY)}]` : "bbox n/a",
    `off-page=${outOfBounds}`,
    state.mappingDebug || "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function syncCanvasGeometry(viewport, renderViewport) {
  const cssWidth = Math.round(viewport.width);
  const cssHeight = Math.round(viewport.height);
  ui.canvas.width = Math.round(renderViewport.width);
  ui.canvas.height = Math.round(renderViewport.height);
  ui.overlayCanvas.width = cssWidth;
  ui.overlayCanvas.height = cssHeight;
  ui.canvas.style.width = `${cssWidth}px`;
  ui.canvas.style.height = `${cssHeight}px`;
  ui.overlayCanvas.style.width = `${cssWidth}px`;
  ui.overlayCanvas.style.height = `${cssHeight}px`;
}

async function renderPage(pageNum, token) {
  if (!state.pdfDoc) return;
  const page = await state.pdfDoc.getPage(pageNum);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: state.scale });
  const renderViewport = page.getViewport({ scale: state.scale * dpr });
  lastRenderedViewport = viewport;
  lastBaseViewport = page.getViewport({ scale: 1 });
  syncCanvasGeometry(viewport, renderViewport);

  const ctx = ui.canvas.getContext("2d", { alpha: false });
  if (currentRenderTask) {
    try {
      currentRenderTask.cancel();
    } catch {
      // ignore cancel race
    }
  }

  currentRenderTask = page.render({ canvasContext: ctx, viewport: renderViewport });
  try {
    await currentRenderTask.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
  } finally {
    currentRenderTask = null;
  }

  if (token !== pendingRenderToken) return;

  const detections = state.detectionsByPage.get(pageNum) || [];
  state.mappingKind = getRenderMapping(detections, viewport);
  state.screenRects = buildRects(detections, viewport, state.mappingKind);
  const outOfBounds = drawOverlayFromRects(state.screenRects, viewport);
  renderObjectList(detections);
  setPinnedObject(null);
  updateSummary(detections, outOfBounds);
}

function scheduleRender() {
  if (!state.pdfDoc) return;
  pendingRenderToken += 1;
  const token = pendingRenderToken;
  if (renderRafHandle) cancelAnimationFrame(renderRafHandle);
  renderRafHandle = requestAnimationFrame(() => {
    renderPage(state.currentPage, token).catch((err) => {
      ui.summary.textContent = `Render error: ${err.message}`;
    });
  });
}

function fillPageSelector() {
  ui.pageSelect.innerHTML = "";
  for (let i = 1; i <= state.pageCount; i += 1) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Page ${i}`;
    if (i === state.currentPage) opt.selected = true;
    ui.pageSelect.appendChild(opt);
  }
  updatePagerControls();
}

function goToPage(nextPage) {
  if (!state.pdfDoc) return;
  const clamped = Math.min(state.pageCount, Math.max(1, nextPage));
  state.currentPage = clamped;
  ui.pageSelect.value = String(clamped);
  updatePagerControls();
  scheduleRender();
}

function updatePagerControls() {
  const hasPdf = Boolean(state.pdfDoc);
  const atFirst = state.currentPage <= 1;
  const atLast = state.currentPage >= state.pageCount;
  if (ui.prevPageBtn) ui.prevPageBtn.disabled = !hasPdf || atFirst;
  if (ui.nextPageBtn) ui.nextPageBtn.disabled = !hasPdf || atLast;
  if (ui.pageIndicator) {
    ui.pageIndicator.textContent = hasPdf ? `Page ${state.currentPage} / ${state.pageCount}` : "Page - / -";
  }
}

function updatePickedFileNames() {
  if (ui.pdfFileName) ui.pdfFileName.textContent = state.selectedPdfFile ? state.selectedPdfFile.name : "none";
  if (ui.csvFileName) ui.csvFileName.textContent = state.selectedCsvFile ? `Selected: ${state.selectedCsvFile.name}` : "No file selected.";
}

function updateCsvVisualState() {
  const hasCsv = Boolean(state.selectedCsvFile);
  if (ui.csvSourceBlock) {
    ui.csvSourceBlock.classList.toggle("has-csv", hasCsv);
  }
  if (ui.csvStatusPill) {
    ui.csvStatusPill.textContent = hasCsv ? "CSV loaded" : "No CSV";
  }
}

function setSourceMode(mode) {
  state.sourceMode = mode === "csv" ? "csv" : "json";
  const isJson = state.sourceMode === "json";
  if (ui.sourceModeJsonBtn) {
    ui.sourceModeJsonBtn.classList.toggle("active", isJson);
    ui.sourceModeJsonBtn.setAttribute("aria-selected", isJson ? "true" : "false");
  }
  if (ui.sourceModeCsvBtn) {
    ui.sourceModeCsvBtn.classList.toggle("active", !isJson);
    ui.sourceModeCsvBtn.setAttribute("aria-selected", !isJson ? "true" : "false");
  }
  if (ui.jsonSourcePanel) ui.jsonSourcePanel.classList.toggle("hidden", !isJson);
  if (ui.csvSourceBlock) ui.csvSourceBlock.classList.toggle("hidden", isJson);
}

function getPdfSourceKey(pdfPath, file) {
  if (file) {
    return `file:${file.name}:${file.size}:${file.lastModified}`;
  }
  return `path:${pdfPath || ""}`;
}

async function computeFitScaleForPage(pdfDoc, pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const paneWidth = Math.max(220, ui.viewerPane.clientWidth - 30);
  return clampScale(paneWidth / base.width);
}

function updatePanelToggleLabel() {
  const collapsed = document.body.classList.contains("panel-collapsed");
  ui.togglePanelBtn.textContent = collapsed ? "Show objects" : "Hide objects";
}

function applyTheme(theme) {
  state.theme = theme === LIGHT_THEME ? LIGHT_THEME : DARK_THEME;
  document.body.dataset.theme = state.theme;
  ui.themeToggleBtn.textContent = state.theme === DARK_THEME ? "Light mode" : "Dark mode";
}

function toggleTheme() {
  applyTheme(state.theme === DARK_THEME ? LIGHT_THEME : DARK_THEME);
}

async function fitPageToPane() {
  if (!state.pdfDoc) return;
  const next = await computeFitScaleForPage(state.pdfDoc, state.currentPage);
  setScale(next);
}

async function loadAll() {
  const pdfPath = ui.pdfPath.value.trim();
  const requestedScale = clampScale(Number(ui.scaleInput.value));
  setScale(requestedScale, { shouldRender: false });
  state.mappingPreference = ui.mappingMode.value;
  state.showCursorGuide = ui.showCursorGuide.checked;
  const sourceKey = getPdfSourceKey(pdfPath, state.selectedPdfFile);

  if (!pdfPath && !state.selectedPdfFile) {
    ui.summary.textContent = "Set PDF path or choose a PDF file.";
    return;
  }

  try {
    setLoading(true);
    clearViewer();
    const pdfDoc = await readPdfDocument(pdfPath, state.selectedPdfFile);
    let jsonParsed = {
      byPage: new Map(),
      stats: { accepted: 0, rejected: 0, arraysScanned: 0, warnings: [] },
    };
    let csvParsed = {
      byPage: new Map(),
      csvExtents: new Map(),
      stats: { accepted: 0, rejected: 0, arraysScanned: 0, warnings: [] },
    };
    if (state.sourceMode === "json") {
      jsonParsed = parseJsonInput(ui.jsonInput.value);
    } else {
      const csvText = state.selectedCsvFile ? await state.selectedCsvFile.text() : "";
      csvParsed = parseCsvInput(csvText);
    }
    const parsed = mergeParsedSources(jsonParsed, csvParsed);

    state.pdfDoc = pdfDoc;
    state.pageCount = pdfDoc.numPages;
    state.currentPage = 1;
    state.detectionsByPage = parsed.byPage;
    state.csvPageExtents = parsed.csvExtents;
    state.parseStats = parsed.stats;
    state.jsonStats = jsonParsed.stats;
    state.csvStats = csvParsed.stats;
    renderParseFeedback();
    fillPageSelector();
    const isNewSource = sourceKey !== state.lastPdfSourceKey;
    if (isNewSource) {
      const fitScale = await computeFitScaleForPage(pdfDoc, 1);
      setScale(fitScale, { shouldRender: false });
      state.lastPdfSourceKey = sourceKey;
    }
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
  updatePagerControls();
  scheduleRender();
});

ui.prevPageBtn.addEventListener("click", () => {
  goToPage(state.currentPage - 1);
});

ui.nextPageBtn.addEventListener("click", () => {
  goToPage(state.currentPage + 1);
});

ui.showLabels.addEventListener("change", () => {
  if (lastRenderedViewport) drawOverlayFromRects(state.screenRects, lastRenderedViewport);
});

ui.showCursorGuide.addEventListener("change", () => {
  state.showCursorGuide = ui.showCursorGuide.checked;
  if (lastRenderedViewport) drawOverlayFromRects(state.screenRects, lastRenderedViewport);
});

ui.scaleInput.addEventListener("change", () => {
  setScale(Number(ui.scaleInput.value));
});

ui.mappingMode.addEventListener("change", () => {
  state.mappingPreference = ui.mappingMode.value;
  scheduleRender();
});

ui.sourceModeJsonBtn.addEventListener("click", () => {
  setSourceMode("json");
});

ui.sourceModeCsvBtn.addEventListener("click", () => {
  setSourceMode("csv");
});

ui.fitPageBtn.addEventListener("click", () => {
  fitPageToPane().catch((err) => {
    ui.summary.textContent = `Fit failed: ${err.message}`;
  });
});

ui.resetZoomBtn.addEventListener("click", () => {
  setScale(1);
});

ui.themeToggleBtn.addEventListener("click", () => {
  toggleTheme();
});

ui.togglePanelBtn.addEventListener("click", () => {
  document.body.classList.toggle("panel-collapsed");
  updatePanelToggleLabel();
});

ui.docsBtn.addEventListener("click", () => {
  window.location.href = "./docs.html";
});

ui.choosePdfBtn.addEventListener("click", () => ui.pdfFile.click());
ui.chooseCsvBtn.addEventListener("click", () => ui.csvFile.click());

ui.pdfFile.addEventListener("change", (e) => {
  state.selectedPdfFile = e.target.files?.[0] || null;
  updatePickedFileNames();
  if (state.selectedPdfFile) {
    loadAll().catch((err) => {
      ui.summary.textContent = `Load failed: ${err.message}`;
    });
  }
});

ui.csvFile.addEventListener("change", (e) => {
  state.selectedCsvFile = e.target.files?.[0] || null;
  setSourceMode("csv");
  updatePickedFileNames();
  updateCsvVisualState();
  if (!state.selectedCsvFile) {
    state.csvStats = {
      accepted: 0,
      rejected: 0,
      arraysScanned: 0,
      warnings: [],
    };
    renderParseFeedback();
    return;
  }
  state.selectedCsvFile
    .text()
    .then((csvText) => {
      const csvParsed = parseCsvInput(csvText);
      state.csvStats = csvParsed.stats;
      renderParseFeedback();
      // Auto-load only when PDF is already loaded or selected as a local file.
      if (state.pdfDoc || state.selectedPdfFile) {
        return loadAll();
      }
      state.csvStats = {
        ...state.csvStats,
        warnings: ["CSV parsed. Choose/load PDF, then click Load."],
      };
      renderParseFeedback();
      return null;
    })
    .catch((err) => {
      ui.summary.textContent = `CSV read failed: ${err.message}`;
    });
});

ui.pdfPath.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  loadAll().catch((err) => {
    ui.summary.textContent = `Load failed: ${err.message}`;
  });
});

ui.overlayCanvas.addEventListener("mousemove", (e) => {
  scheduleHoverUpdate(e);
});

ui.overlayCanvas.addEventListener("click", (e) => {
  const id = pickObjectAt(e.clientX, e.clientY);
  togglePinnedObject(id);
});

ui.overlayCanvas.addEventListener("mouseleave", () => {
  ui.cursorCoords.textContent = "";
  state.cursorPoint = null;
  if (!state.pinnedObjectId) {
    setActiveObject(null);
  } else if (lastRenderedViewport) {
    drawOverlayFromRects(state.screenRects, lastRenderedViewport);
  }
});

ui.viewerWrap.addEventListener(
  "wheel",
  (event) => {
    if (!isZoomIntentFromWheel(event)) return;
    event.preventDefault();
    applyTrackpadZoomFromWheel(event);
  },
  { passive: false },
);

window.addEventListener(
  "gesturestart",
  (event) => {
    event.preventDefault();
    state.gestureStartScale = state.scale;
  },
  { passive: false },
);

window.addEventListener(
  "gesturechange",
  (event) => {
    event.preventDefault();
    if (!Number.isFinite(state.gestureStartScale)) {
      state.gestureStartScale = state.scale;
    }
    const rawScale = Number(event.scale);
    const nextScale = clampScale((state.gestureStartScale || state.scale) * (Number.isFinite(rawScale) ? rawScale : 1));
    setScale(nextScale);
  },
  { passive: false },
);

window.addEventListener(
  "gestureend",
  () => {
    state.gestureStartScale = null;
  },
  { passive: false },
);

window.addEventListener("keydown", (event) => {
  if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
  if (event.key === "[" || event.key === "ArrowLeft") {
    goToPage(state.currentPage - 1);
  } else if (event.key === "]" || event.key === "ArrowRight") {
    goToPage(state.currentPage + 1);
  } else if (event.key === "+") {
    setScale(state.scale + 0.08);
  } else if (event.key === "-") {
    setScale(state.scale - 0.08);
  } else if (event.key.toLowerCase() === "f") {
    fitPageToPane().catch(() => {});
  } else if (event.key === "0") {
    setScale(1);
  }
});

updatePanelToggleLabel();
applyTheme(LIGHT_THEME);
setSourceMode("json");
renderParseFeedback();
updatePickedFileNames();
updateCsvVisualState();
updatePagerControls();
