const containersBody = document.querySelector("#containers-body");
const systemInfo = document.querySelector("#system-info");
const eventsLog = document.querySelector("#events-log");
const hostPerformance = document.querySelector("#host-performance");
const containerPerformanceBody = document.querySelector("#container-performance-body");
const imagesBody = document.querySelector("#images-body");
const exposedAppsBody = document.querySelector("#exposed-apps-body");
const containerLogs = document.querySelector("#container-logs");
const logsTarget = document.querySelector("#logs-target");
const closeLogsBtn = document.querySelector("#close-logs-btn");
const dashboardGrid = document.querySelector("#dashboard-grid");
const paneDragHandles = document.querySelectorAll(".pane-drag-handle");

let refreshTimer = null;
let exposedAppsRefreshTimer = null;
let eventsSocket = null;
let logsSocket = null;
let activeResizeState = null;
let activeDragState = null;
const paneRevealTimers = new WeakMap();
let exposedAppsRequestInFlight = null;

const packagesSourceUrl = "https://dockinfo.royadler.de/packages";
const packagesBackendTimeoutMs = 7000;
const packagesFallbackSources = [
  {
    name: "direct",
    url: () => packagesSourceUrl,
    parseMode: "json"
  },
  {
    name: "allorigins-raw",
    url: () => `https://api.allorigins.win/raw?url=${encodeURIComponent(packagesSourceUrl)}`,
    parseMode: "json"
  },
  {
    name: "allorigins-get",
    url: () => `https://api.allorigins.win/get?url=${encodeURIComponent(packagesSourceUrl)}`,
    parseMode: "allorigins"
  }
];

const paneGridColumns = 12;
const paneDefaultLayout = {
  system: { col: 1, row: 1, colSpan: 4, rowSpan: 1 },
  containers: { col: 1, row: 2, colSpan: 8, rowSpan: 4 },
  events: { col: 9, row: 1, colSpan: 4, rowSpan: 3 },
  performance: { col: 9, row: 4, colSpan: 4, rowSpan: 3 },
  images: { col: 1, row: 6, colSpan: 6, rowSpan: 3 },
  logs: { col: 7, row: 6, colSpan: 6, rowSpan: 3 },
  exposedApps: { col: 1, row: 9, colSpan: 12, rowSpan: 2 }
};
let paneLayout = sanitizePaneLayout();

const paneDragIconSvg = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 2l3 3h-2v4h4V7l3 3-3 3v-2h-4v4h2l-3 3-3-3h2v-4H7v2l-3-3 3-3v2h4V5H9z"></path>
  </svg>
`;

paneDragHandles.forEach((handle) => {
  handle.innerHTML = paneDragIconSvg;
});

function setSystemInfoText(text) {
  systemInfo.textContent = text;
}

function startPaneLoading(target) {
  const pane = target?.closest(".dashboard-pane");
  if (!pane) {
    return null;
  }
  pane.classList.remove("is-revealed");
  pane.classList.add("is-loading");
  return pane;
}

function finishPaneLoading(pane) {
  if (!pane) {
    return;
  }
  pane.classList.remove("is-loading");
  pane.classList.add("is-revealed");
  const existingTimer = paneRevealTimers.get(pane);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timerId = setTimeout(() => {
    pane.classList.remove("is-revealed");
    paneRevealTimers.delete(pane);
  }, 280);
  paneRevealTimers.set(pane, timerId);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const sized = value / 1024 ** index;
  return `${sized >= 10 || index === 0 ? sized.toFixed(0) : sized.toFixed(1)} ${units[index]}`;
}

function formatPercent(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return "0.0%";
  }
  return `${number.toFixed(1)}%`;
}

function formatRate(value) {
  return `${formatBytes(value)}/s`;
}

function formatDateTime(unixSeconds) {
  const value = Number(unixSeconds || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString();
}

function appendLog(target, line, maxLines = 500) {
  const previous = target.textContent || "";
  const combined = `${previous}${line.endsWith("\n") ? line : `${line}\n`}`;
  const lines = combined.split("\n");
  target.textContent = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  target.scrollTop = target.scrollHeight;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function makeGridCellKey(col, row) {
  return `${col}:${row}`;
}

function markAreaAsOccupied(occupiedCells, col, row, colSpan, rowSpan) {
  for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
    for (let colOffset = 0; colOffset < colSpan; colOffset += 1) {
      occupiedCells.add(makeGridCellKey(col + colOffset, row + rowOffset));
    }
  }
}

function canPlaceArea(occupiedCells, col, row, colSpan, rowSpan, maxColumns) {
  if (col < 1 || row < 1 || col + colSpan - 1 > maxColumns) {
    return false;
  }
  for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
    for (let colOffset = 0; colOffset < colSpan; colOffset += 1) {
      if (occupiedCells.has(makeGridCellKey(col + colOffset, row + rowOffset))) {
        return false;
      }
    }
  }
  return true;
}

function findAvailableGridSlot({
  occupiedCells,
  maxColumns,
  colSpan,
  rowSpan,
  preferredCol = 1,
  preferredRow = 1
}) {
  const colLimit = Math.max(1, maxColumns - colSpan + 1);
  const startCol = clamp(preferredCol, 1, colLimit);
  const startRow = Math.max(1, preferredRow);
  const maxSearchRows = 300;

  for (let row = startRow; row <= maxSearchRows; row += 1) {
    const colStart = row === startRow ? startCol : 1;
    for (let col = colStart; col <= colLimit; col += 1) {
      if (canPlaceArea(occupiedCells, col, row, colSpan, rowSpan, maxColumns)) {
        return { col, row };
      }
    }
  }

  return { col: 1, row: maxSearchRows + 1 };
}

function normalizeLegacyPaneLayout(layout = {}) {
  const hasGridCoordinates = Object.values(layout).some(
    (entry) => Number.isFinite(entry?.col) && Number.isFinite(entry?.row)
  );
  if (hasGridCoordinates) {
    return layout;
  }

  const orderedPaneIds = Object.keys(paneDefaultLayout).sort((a, b) => {
    const orderA = Number.isFinite(layout?.[a]?.order) ? layout[a].order : Number.MAX_SAFE_INTEGER;
    const orderB = Number.isFinite(layout?.[b]?.order) ? layout[b].order : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return paneDefaultLayout[a].row - paneDefaultLayout[b].row;
  });

  const occupiedCells = new Set();
  const normalizedLayout = {};
  orderedPaneIds.forEach((paneId) => {
    const defaults = paneDefaultLayout[paneId];
    const entry = layout[paneId] || {};
    const colSpan = Number.isFinite(entry.colSpan)
      ? clamp(Math.round(entry.colSpan), 1, paneGridColumns)
      : defaults.colSpan;
    const rowSpan = Number.isFinite(entry.rowSpan) ? clamp(Math.round(entry.rowSpan), 1, 8) : defaults.rowSpan;
    const slot = findAvailableGridSlot({
      occupiedCells,
      maxColumns: paneGridColumns,
      colSpan,
      rowSpan,
      preferredCol: defaults.col,
      preferredRow: defaults.row
    });
    normalizedLayout[paneId] = { col: slot.col, row: slot.row, colSpan, rowSpan };
    markAreaAsOccupied(occupiedCells, slot.col, slot.row, colSpan, rowSpan);
  });

  return normalizedLayout;
}

function sanitizePaneLayout(layout = {}) {
  const normalizedLayout = normalizeLegacyPaneLayout(layout);
  const occupiedCells = new Set();
  const sanitized = {};

  Object.keys(paneDefaultLayout).forEach((paneId) => {
    const defaults = paneDefaultLayout[paneId];
    const entry = normalizedLayout[paneId] || {};
    const colSpan = Number.isFinite(entry.colSpan)
      ? clamp(Math.round(entry.colSpan), 1, paneGridColumns)
      : defaults.colSpan;
    const rowSpan = Number.isFinite(entry.rowSpan) ? clamp(Math.round(entry.rowSpan), 1, 8) : defaults.rowSpan;
    const slot = findAvailableGridSlot({
      occupiedCells,
      maxColumns: paneGridColumns,
      colSpan,
      rowSpan,
      preferredCol: Number.isFinite(entry.col) ? Math.round(entry.col) : defaults.col,
      preferredRow: Number.isFinite(entry.row) ? Math.round(entry.row) : defaults.row
    });
    sanitized[paneId] = { col: slot.col, row: slot.row, colSpan, rowSpan };
    markAreaAsOccupied(occupiedCells, slot.col, slot.row, colSpan, rowSpan);
  });

  return sanitized;
}

async function loadPaneLayout() {
  try {
    const payload = await api("/api/layout");
    return sanitizePaneLayout(payload?.layout || {});
  } catch {
    return sanitizePaneLayout();
  }
}

async function savePaneLayout() {
  await api("/api/layout", {
    method: "PUT",
    body: JSON.stringify({ layout: paneLayout })
  });
}

function getCurrentGridColumns() {
  const columns = getComputedStyle(dashboardGrid).gridTemplateColumns.split(" ").length;
  return Number.isFinite(columns) && columns > 0 ? columns : paneGridColumns;
}

function applyPaneLayout(layoutOverride = paneLayout) {
  const currentColumns = getCurrentGridColumns();
  dashboardGrid.querySelectorAll(".dashboard-pane").forEach((pane) => {
    const paneId = pane.dataset.paneId;
    const layout = layoutOverride[paneId] || paneDefaultLayout[paneId];
    const columnSpan = currentColumns === 1 ? 1 : clamp(layout.colSpan, 1, currentColumns);
    const startColumn =
      currentColumns === 1 ? 1 : clamp(layout.col || 1, 1, Math.max(1, currentColumns - columnSpan + 1));
    const startRow = clamp(layout.row || 1, 1, 400);
    pane.style.order = "";
    pane.style.gridColumn = `${startColumn} / span ${columnSpan}`;
    pane.style.gridRow = `${startRow} / span ${layout.rowSpan}`;
  });
}

function reflowPaneLayout(primaryPaneId, { commit = true } = {}) {
  const maxColumns = getCurrentGridColumns();
  const occupiedCells = new Set();
  const paneIds = Object.keys(paneDefaultLayout).sort((a, b) => {
    if (a === primaryPaneId) {
      return -1;
    }
    if (b === primaryPaneId) {
      return 1;
    }
    const layoutA = paneLayout[a] || paneDefaultLayout[a];
    const layoutB = paneLayout[b] || paneDefaultLayout[b];
    if (layoutA.row !== layoutB.row) {
      return layoutA.row - layoutB.row;
    }
    return layoutA.col - layoutB.col;
  });

  const reflowed = {};
  paneIds.forEach((paneId) => {
    const defaults = paneDefaultLayout[paneId];
    const current = paneLayout[paneId] || defaults;
    const colSpan = maxColumns === 1 ? 1 : clamp(current.colSpan || defaults.colSpan, 1, maxColumns);
    const rowSpan = clamp(current.rowSpan || defaults.rowSpan, 1, 8);
    const preferredCol = maxColumns === 1 ? 1 : clamp(current.col || defaults.col, 1, maxColumns);
    const preferredRow = clamp(current.row || defaults.row, 1, 400);
    const slot = findAvailableGridSlot({
      occupiedCells,
      maxColumns,
      colSpan,
      rowSpan,
      preferredCol,
      preferredRow
    });
    reflowed[paneId] = { col: slot.col, row: slot.row, colSpan, rowSpan };
    markAreaAsOccupied(occupiedCells, slot.col, slot.row, colSpan, rowSpan);
  });

  if (commit) {
    paneLayout = reflowed;
  }
  return reflowed;
}

function getGridMetrics() {
  const computedStyles = getComputedStyle(dashboardGrid);
  const columnGap = Number.parseFloat(computedStyles.columnGap || computedStyles.gap || "0") || 0;
  const rowGap = Number.parseFloat(computedStyles.rowGap || computedStyles.gap || "0") || 0;
  const maxColumns = getCurrentGridColumns();
  const gridRect = dashboardGrid.getBoundingClientRect();
  const columnWidth = (gridRect.width - columnGap * (maxColumns - 1)) / maxColumns;
  const rowHeight = Number.parseFloat(computedStyles.gridAutoRows || "120") || 120;
  return {
    gridRect,
    maxColumns,
    columnGap,
    rowGap,
    columnUnit: Math.max(1, columnWidth + columnGap),
    rowUnit: Math.max(1, rowHeight + rowGap)
  };
}

function snapPanePositionFromPointer(paneId, clientX, clientY, anchorX = 0, anchorY = 0) {
  const metrics = getGridMetrics();
  const layout = paneLayout[paneId] || paneDefaultLayout[paneId];
  const colSpan = metrics.maxColumns === 1 ? 1 : clamp(layout.colSpan, 1, metrics.maxColumns);
  const x = clientX - metrics.gridRect.left - anchorX;
  const y = clientY - metrics.gridRect.top - anchorY;
  const snappedCol = clamp(Math.round(x / metrics.columnUnit) + 1, 1, Math.max(1, metrics.maxColumns - colSpan + 1));
  const snappedRow = clamp(Math.round(y / metrics.rowUnit) + 1, 1, 400);
  return { col: snappedCol, row: snappedRow };
}

function movePaneToGridPosition(paneId, col, row) {
  paneLayout[paneId].col = col;
  paneLayout[paneId].row = row;
  reflowPaneLayout(paneId);
  applyPaneLayout();
  savePaneLayout().catch(() => {});
}

function removeDragGhost() {
  if (activeDragState?.ghostElement?.isConnected) {
    activeDragState.ghostElement.remove();
  }
}

function updateDragGhostPosition(clientX, clientY) {
  if (!activeDragState) {
    return null;
  }
  const snapped = snapPanePositionFromPointer(
    activeDragState.paneId,
    clientX,
    clientY,
    activeDragState.anchorX,
    activeDragState.anchorY
  );
  const metrics = getGridMetrics();
  const layout = paneLayout[activeDragState.paneId] || paneDefaultLayout[activeDragState.paneId];
  const colSpan = metrics.maxColumns === 1 ? 1 : clamp(layout.colSpan, 1, metrics.maxColumns);
  const rowSpan = clamp(layout.rowSpan, 1, 8);
  const left = (snapped.col - 1) * metrics.columnUnit;
  const top = (snapped.row - 1) * metrics.rowUnit;
  const width = colSpan * metrics.columnUnit - metrics.columnGap;
  const height = rowSpan * metrics.rowUnit - metrics.rowGap;
  activeDragState.col = snapped.col;
  activeDragState.row = snapped.row;
  activeDragState.ghostElement.style.transform = `translate(${left}px, ${top}px)`;
  activeDragState.ghostElement.style.width = `${Math.max(10, width)}px`;
  activeDragState.ghostElement.style.height = `${Math.max(10, height)}px`;
  return snapped;
}

function setupPaneDragAndDrop() {
  let draggingPaneId = null;

  dashboardGrid.querySelectorAll(".pane-drag-handle").forEach((handle) => {
    handle.draggable = true;
    handle.addEventListener("dragstart", (event) => {
      const pane = event.currentTarget.closest(".dashboard-pane");
      draggingPaneId = pane?.dataset.paneId || null;
      if (!draggingPaneId || !event.dataTransfer) {
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggingPaneId);
      pane.classList.add("dragging");
      dashboardGrid.classList.add("is-dragging-layout");
      const ghostElement = document.createElement("div");
      ghostElement.className = "pane-drop-ghost";
      dashboardGrid.appendChild(ghostElement);
      const paneRect = pane.getBoundingClientRect();
      activeDragState = {
        paneId: draggingPaneId,
        ghostElement,
        anchorX: clamp(event.clientX - paneRect.left, 0, paneRect.width),
        anchorY: clamp(event.clientY - paneRect.top, 0, paneRect.height),
        col: paneLayout[draggingPaneId]?.col || 1,
        row: paneLayout[draggingPaneId]?.row || 1
      };
      updateDragGhostPosition(event.clientX, event.clientY);
    });
    handle.addEventListener("dragend", () => {
      draggingPaneId = null;
      dashboardGrid.classList.remove("is-dragging-layout");
      removeDragGhost();
      activeDragState = null;
      dashboardGrid.querySelectorAll(".dashboard-pane").forEach((pane) => {
        pane.classList.remove("dragging", "drop-target");
      });
    });
  });

  dashboardGrid.addEventListener("dragover", (event) => {
    if (!draggingPaneId) {
      return;
    }
    event.preventDefault();
    updateDragGhostPosition(event.clientX, event.clientY);
  });

  dashboardGrid.addEventListener("drop", (event) => {
    if (!draggingPaneId) {
      return;
    }
    event.preventDefault();
    updateDragGhostPosition(event.clientX, event.clientY);
    const col = activeDragState?.col;
    const row = activeDragState?.row;
    if (!Number.isFinite(col) || !Number.isFinite(row)) {
      return;
    }
    movePaneToGridPosition(draggingPaneId, col, row);
    dashboardGrid.classList.remove("is-dragging-layout");
    removeDragGhost();
    activeDragState = null;
  });
}

function updatePaneSize(paneId, colSpan, rowSpan) {
  paneLayout[paneId].colSpan = colSpan;
  paneLayout[paneId].rowSpan = rowSpan;
  reflowPaneLayout(paneId);
  applyPaneLayout();
}

function handleResizeMove(event) {
  if (!activeResizeState) {
    return;
  }
  const {
    paneId,
    startX,
    startY,
    startCol,
    startColSpan,
    startRowSpan,
    columnUnit,
    rowUnit,
    maxColumns,
    edge
  } = activeResizeState;
  const deltaColumns = Math.round((event.clientX - startX) / columnUnit);
  const deltaRows = Math.round((event.clientY - startY) / rowUnit);
  let col = startCol;
  let colSpan = clamp(startColSpan + deltaColumns, 1, maxColumns);
  if (edge === "left") {
    const rightEdge = startCol + startColSpan - 1;
    const nextLeft = clamp(startCol + deltaColumns, 1, rightEdge);
    col = nextLeft;
    colSpan = clamp(rightEdge - nextLeft + 1, 1, maxColumns);
  }
  const rowSpan = clamp(startRowSpan + deltaRows, 1, 8);
  paneLayout[paneId].col = col;
  updatePaneSize(paneId, colSpan, rowSpan);
}

function stopPaneResize() {
  if (!activeResizeState) {
    return;
  }
  savePaneLayout().catch(() => {});
  activeResizeState = null;
  document.body.classList.remove("is-resizing");
  dashboardGrid.classList.remove("is-dragging-layout");
  window.removeEventListener("pointermove", handleResizeMove);
  window.removeEventListener("pointerup", stopPaneResize);
}

function startPaneResize(event) {
  const pane = event.currentTarget.closest(".dashboard-pane");
  const paneId = pane?.dataset.paneId;
  if (!paneId) {
    return;
  }
  const isLeftHandle = event.currentTarget.classList.contains("pane-resize-handle-left");
  const { maxColumns, columnUnit, rowUnit } = getGridMetrics();

  activeResizeState = {
    paneId,
    startX: event.clientX,
    startY: event.clientY,
    startCol: paneLayout[paneId].col,
    startColSpan: paneLayout[paneId].colSpan,
    startRowSpan: paneLayout[paneId].rowSpan,
    columnUnit,
    rowUnit,
    maxColumns,
    edge: isLeftHandle ? "left" : "right"
  };
  document.body.classList.add("is-resizing");
  dashboardGrid.classList.add("is-dragging-layout");
  window.addEventListener("pointermove", handleResizeMove);
  window.addEventListener("pointerup", stopPaneResize);
}

function setupPaneResizers() {
  dashboardGrid.querySelectorAll(".pane-resize-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", startPaneResize);
  });
}

async function initializePaneLayout() {
  paneLayout = await loadPaneLayout();
  reflowPaneLayout();
  applyPaneLayout();
  setupPaneDragAndDrop();
  setupPaneResizers();
  window.addEventListener("resize", () => {
    const viewportLayout = reflowPaneLayout(undefined, { commit: false });
    applyPaneLayout(viewportLayout);
  });
}

function formatPorts(ports) {
  if (!ports || ports.length === 0) {
    return "-";
  }
  return ports.map(formatPortEntry).join(", ");
}

function formatPortsPreview(ports, maxItems = 2) {
  if (!ports || ports.length === 0) {
    return "-";
  }
  const fullText = formatPorts(ports);
  if (ports.length <= maxItems) {
    return fullText;
  }
  const firstEntries = ports
    .slice(0, maxItems)
    .map(formatPortEntry)
    .join(", ");
  return `${firstEntries}, +${ports.length - maxItems} more`;
}

function formatPortEntry(port) {
  const privatePort = `${port.PrivatePort}/${port.Type}`;
  if (port.PublicPort) {
    return `${port.IP || "0.0.0.0"}:${port.PublicPort} -> ${privatePort}`;
  }
  return privatePort;
}

function renderPortsCell(portsCell, ports) {
  const entries = (ports || []).map(formatPortEntry);
  portsCell.innerHTML = "";

  if (entries.length === 0) {
    portsCell.textContent = "-";
    return;
  }

  if (entries.length <= 2) {
    portsCell.textContent = entries.join(", ");
    return;
  }

  const details = document.createElement("details");
  details.className = "ports-details";
  const summary = document.createElement("summary");
  summary.className = "ports-summary";
  summary.textContent = formatPortsPreview(ports, 2);

  const list = document.createElement("div");
  list.className = "ports-list";
  list.textContent = entries.join("\n");

  details.append(summary, list);
  portsCell.appendChild(details);
}

function createExternalLinkCell(value) {
  const cell = document.createElement("td");
  const link = String(value || "").trim();
  if (!link) {
    cell.textContent = "-";
    return cell;
  }
  const anchor = document.createElement("a");
  anchor.className = "external-link";
  anchor.href = link;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = link;
  cell.appendChild(anchor);
  return cell;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toReadableErrorMessage(error, timeoutMs = 0) {
  if (!error) {
    return "unknown error";
  }
  if (error.name === "AbortError") {
    return timeoutMs > 0
      ? `request timed out after ${timeoutMs} ms`
      : "request timed out";
  }
  return String(error.message || error);
}

function normalizePackagesResponse(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.packages)) {
    return data.packages;
  }
  throw new Error("Invalid packages payload");
}

function normalizePackageEntry(entry, index = 0) {
  return {
    id: String(entry?.id || entry?.name || `pkg-${index}`),
    name: String(entry?.name || "Unnamed application"),
    applicationUrl: String(entry?.applicationUrl || entry?.application_url || entry?.url || ""),
    githubUrl: String(entry?.githubUrl || entry?.github_url || "")
  };
}

async function fetchPackagesFromFallbackSources() {
  const errors = [];
  for (const source of packagesFallbackSources) {
    try {
      const response = await fetchJsonWithTimeout(
        source.url(),
        {
          method: "GET",
          mode: "cors",
          cache: "no-store",
          headers: { Accept: "application/json" }
        },
        8000
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      let payload;
      if (source.parseMode === "allorigins") {
        const wrapped = await response.json();
        if (!wrapped || typeof wrapped.contents !== "string") {
          throw new Error("Unexpected proxy payload");
        }
        payload = JSON.parse(wrapped.contents);
      } else {
        payload = await response.json();
      }
      const normalized = normalizePackagesResponse(payload).map((entry, index) =>
        normalizePackageEntry(entry, index)
      );
      return normalized;
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  throw new Error(`Fallback sources failed: ${errors.join(" | ")}`);
}

async function loadSystemInfo(options = {}) {
  const pane = options.showLoading === false ? null : startPaneLoading(systemInfo);
  try {
    const payload = await api("/api/system/info");
    setSystemInfoText(
      `${payload.info.Name} | ${payload.info.OperatingSystem} | ${payload.version.Version} | ${payload.info.ContainersRunning} running / ${payload.info.Containers} total`
    );
  } catch (error) {
    setSystemInfoText(`Error: ${error.message}`);
  } finally {
    finishPaneLoading(pane);
  }
}

async function runContainerAction(containerId, action) {
  try {
    await api(`/api/containers/${containerId}/${action}`, {
      method: "POST"
    });
    await loadContainers();
    await loadPerformance();
  } catch (error) {
    alert(`Failed to ${action}: ${error.message}`);
  }
}

async function removeContainer(container, force = false) {
  const name = container.names[0] || container.shortId;
  const confirmationText = force
    ? `Force delete container "${name}"? This will stop and remove it.`
    : `Delete container "${name}" from Docker?`;
  if (!window.confirm(confirmationText)) {
    return;
  }

  try {
    await api(`/api/containers/${encodeURIComponent(container.id)}?force=${force ? "true" : "false"}`, {
      method: "DELETE"
    });
    await loadContainers();
    await loadPerformance();
    await loadImages();
  } catch (error) {
    if (!force) {
      const tryForce = window.confirm(
        `Delete failed: ${error.message}\n\nTry force delete instead?`
      );
      if (tryForce) {
        await removeContainer(container, true);
      }
      return;
    }
    alert(`Failed to delete container: ${error.message}`);
  }
}

async function removeImage(image, force = false) {
  const name = image.tags[0] || image.shortId;
  const confirmationText = force
    ? `Force delete image "${name}"? This may remove it even if other containers depend on it.`
    : `Delete image "${name}" from Docker?`;
  if (!window.confirm(confirmationText)) {
    return;
  }

  try {
    await api(`/api/images/${encodeURIComponent(image.id)}?force=${force ? "true" : "false"}`, {
      method: "DELETE"
    });
    await loadImages();
    await loadContainers();
    await loadPerformance();
  } catch (error) {
    if (!force) {
      const tryForce = window.confirm(
        `Delete failed: ${error.message}\n\nTry force delete instead?`
      );
      if (tryForce) {
        await removeImage(image, true);
      }
      return;
    }
    alert(`Failed to delete image: ${error.message}`);
  }
}

function openLogs(container) {
  if (logsSocket) {
    logsSocket.close();
  }
  logsTarget.textContent = `Streaming: ${container.names[0] || container.shortId}`;
  containerLogs.textContent = "";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  logsSocket = new WebSocket(
    `${protocol}://${window.location.host}/ws?mode=logs&id=${encodeURIComponent(container.id)}&tail=200`
  );
  logsSocket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "log") {
        appendLog(containerLogs, message.payload, 1000);
      }
      if (message.type === "error") {
        appendLog(containerLogs, `ERROR: ${message.payload.error}`);
      }
    } catch {
      appendLog(containerLogs, event.data, 1000);
    }
  };
  logsSocket.onclose = () => {
    appendLog(containerLogs, "[logs stream closed]");
  };
}

async function loadContainers(options = {}) {
  const pane = options.showLoading === false ? null : startPaneLoading(containersBody);
  try {
    const containers = await api("/api/containers");
    if (containers.length === 0) {
      containersBody.innerHTML = '<tr><td colspan="6">No containers found.</td></tr>';
      return;
    }
    containersBody.innerHTML = "";

    containers.forEach((container) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${container.names[0] || container.shortId}</td>
        <td>${container.image}</td>
        <td>${container.state}</td>
        <td>${container.status}</td>
        <td class="ports-cell"></td>
        <td class="actions container-actions"></td>
      `;
      const portsCell = row.querySelector(".ports-cell");
      renderPortsCell(portsCell, container.ports);
      const actionsCell = row.querySelector(".actions");

      const startBtn = document.createElement("button");
      startBtn.textContent = "Start";
      startBtn.onclick = () => runContainerAction(container.id, "start");

      const stopBtn = document.createElement("button");
      stopBtn.textContent = "Stop";
      stopBtn.onclick = () => runContainerAction(container.id, "stop");

      const restartBtn = document.createElement("button");
      restartBtn.textContent = "Restart";
      restartBtn.onclick = () => runContainerAction(container.id, "restart");

      const logsBtn = document.createElement("button");
      logsBtn.textContent = "Logs";
      logsBtn.onclick = () => openLogs(container);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.className = "button-danger";
      deleteBtn.onclick = () => removeContainer(container);

      actionsCell.append(startBtn, stopBtn, restartBtn, logsBtn, deleteBtn);
      containersBody.appendChild(row);
    });
  } catch (error) {
    containersBody.innerHTML = `<tr><td colspan="6">Error: ${error.message}</td></tr>`;
  } finally {
    finishPaneLoading(pane);
  }
}

async function loadImages(options = {}) {
  const pane = options.showLoading === false ? null : startPaneLoading(imagesBody);
  try {
    const images = await api("/api/images");
    if (images.length === 0) {
      imagesBody.innerHTML = '<tr><td colspan="6">No images found.</td></tr>';
      return;
    }

    imagesBody.innerHTML = "";
    images.forEach((image) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${image.tags.join(", ")}</td>
        <td>${image.shortId}</td>
        <td>${formatDateTime(image.created)}</td>
        <td>${formatBytes(image.size)}</td>
        <td>${image.containers}</td>
        <td class="actions"></td>
      `;

      const actionsCell = row.querySelector(".actions");
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Delete";
      removeBtn.className = "button-danger";
      removeBtn.onclick = () => removeImage(image);
      actionsCell.append(removeBtn);
      imagesBody.appendChild(row);
    });
  } catch (error) {
    imagesBody.innerHTML = `<tr><td colspan="6">Error: ${error.message}</td></tr>`;
  } finally {
    finishPaneLoading(pane);
  }
}

async function loadExposedApps(options = {}) {
  if (exposedAppsRequestInFlight) {
    return exposedAppsRequestInFlight;
  }
  const pane = options.showLoading === false ? null : startPaneLoading(exposedAppsBody);
  exposedAppsRequestInFlight = (async () => {
    let packages = [];
    let sourceError = null;
    try {
      const response = await fetchJsonWithTimeout(
        "/api/packages",
        { headers: { Accept: "application/json" } },
        packagesBackendTimeoutMs
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Request failed with status ${response.status}`);
      }
      const payload = await response.json();
      packages = normalizePackagesResponse(payload).map((entry, index) => normalizePackageEntry(entry, index));
    } catch (error) {
      sourceError = new Error(toReadableErrorMessage(error, packagesBackendTimeoutMs));
      packages = await fetchPackagesFromFallbackSources();
    }

    if (packages.length === 0) {
      exposedAppsBody.innerHTML = '<tr><td colspan="3">No exposed apps found.</td></tr>';
      return;
    }

    exposedAppsBody.innerHTML = "";
    packages.forEach((entry) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.textContent = entry.name || "Unnamed application";
      row.appendChild(nameCell);
      row.appendChild(createExternalLinkCell(entry.applicationUrl));
      row.appendChild(createExternalLinkCell(entry.githubUrl));
      exposedAppsBody.appendChild(row);
    });

    if (sourceError) {
      // Keep data visible while still signaling degraded path.
      const warningRow = document.createElement("tr");
      warningRow.innerHTML = `<td colspan="3">Note: backend source timed out/unavailable, using direct/proxy fallback (${sourceError.message}).</td>`;
      exposedAppsBody.prepend(warningRow);
    }
  })()
    .catch((error) => {
      exposedAppsBody.innerHTML = `<tr><td colspan="3">Error: ${error.message}</td></tr>`;
    })
    .finally(() => {
      finishPaneLoading(pane);
      exposedAppsRequestInFlight = null;
    });

  return exposedAppsRequestInFlight;
}

function renderHostPerformance(host) {
  hostPerformance.innerHTML = `
    <div class="metric-box">
      <div class="metric-label">CPU Usage</div>
      <div class="metric-value">${formatPercent(host.cpuPercent)}</div>
    </div>
    <div class="metric-box">
      <div class="metric-label">RAM Usage</div>
      <div class="metric-value">${formatPercent(host.memoryPercent)} (${formatBytes(host.memoryUsed)} / ${formatBytes(host.memoryTotal)})</div>
    </div>
    <div class="metric-box">
      <div class="metric-label">Network/s</div>
      <div class="metric-value">RX ${formatRate(host.network.rxRate)} | TX ${formatRate(host.network.txRate)}</div>
    </div>
    <div class="metric-box">
      <div class="metric-label">Disk I/O/s</div>
      <div class="metric-value">R ${formatRate(host.disk.readRate)} | W ${formatRate(host.disk.writeRate)}</div>
    </div>
  `;
}

async function loadPerformance(options = {}) {
  const pane = options.showLoading === false ? null : startPaneLoading(hostPerformance);
  try {
    const payload = await api("/api/metrics");
    renderHostPerformance(payload.host);

    if (payload.containers.length === 0) {
      containerPerformanceBody.innerHTML = '<tr><td colspan="6">No containers found.</td></tr>';
      return;
    }

    containerPerformanceBody.innerHTML = "";
    payload.containers.forEach((container) => {
      const row = document.createElement("tr");
      const metrics = container.metrics;
      if (!metrics) {
        row.innerHTML = `
          <td>${container.name}</td>
          <td>-</td>
          <td>-</td>
          <td>-</td>
          <td>-</td>
          <td>-</td>
        `;
        containerPerformanceBody.appendChild(row);
        return;
      }

      row.innerHTML = `
        <td>${container.name}</td>
        <td>${formatPercent(metrics.cpuPercent)}</td>
        <td>${formatPercent(metrics.memoryPercent)} (${formatBytes(metrics.memoryUsage)})</td>
        <td>${formatBytes(metrics.network.rxBytes)} / ${formatBytes(metrics.network.txBytes)}</td>
        <td>${formatRate(metrics.network.rxRate)} / ${formatRate(metrics.network.txRate)}</td>
        <td>${formatBytes(metrics.disk.readBytes)} / ${formatBytes(metrics.disk.writeBytes)}</td>
      `;
      containerPerformanceBody.appendChild(row);
    });
  } catch (error) {
    hostPerformance.textContent = `Error: ${error.message}`;
    containerPerformanceBody.innerHTML = `<tr><td colspan="6">Error: ${error.message}</td></tr>`;
  } finally {
    finishPaneLoading(pane);
  }
}

function connectEvents() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  eventsSocket = new WebSocket(`${protocol}://${window.location.host}/ws?mode=events`);
  eventsSocket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "event") {
        const payload = JSON.parse(message.payload);
        appendLog(
          eventsLog,
          `${new Date(payload.time * 1000).toISOString()} ${payload.Type}/${payload.Action} ${payload.Actor?.Attributes?.name || payload.id || ""}`
        );
      }
      if (message.type === "error") {
        appendLog(eventsLog, `ERROR: ${message.payload.error}`);
      }
    } catch {
      appendLog(eventsLog, event.data);
    }
  };
  eventsSocket.onclose = () => {
    appendLog(eventsLog, "[event stream disconnected, retrying...]");
    setTimeout(connectEvents, 2000);
  };
}

function setAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshTimer = setInterval(() => {
    loadContainers({ showLoading: false });
    loadImages({ showLoading: false });
    loadSystemInfo({ showLoading: false });
    loadPerformance({ showLoading: false });
  }, 5000);

  if (exposedAppsRefreshTimer) {
    clearInterval(exposedAppsRefreshTimer);
    exposedAppsRefreshTimer = null;
  }
  exposedAppsRefreshTimer = setInterval(() => {
    loadExposedApps({ showLoading: false });
  }, 60000);
}

closeLogsBtn.addEventListener("click", () => {
  if (logsSocket) {
    logsSocket.close();
    logsSocket = null;
  }
  logsTarget.textContent = "No container selected";
});

initializePaneLayout();
loadContainers();
loadImages();
loadSystemInfo();
loadPerformance();
loadExposedApps();
setAutoRefresh();
connectEvents();
