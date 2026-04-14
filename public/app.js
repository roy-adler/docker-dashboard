const containersBody = document.querySelector("#containers-body");
const systemInfo = document.querySelector("#system-info");
const eventsLog = document.querySelector("#events-log");
const hostPerformance = document.querySelector("#host-performance");
const containerPerformanceBody = document.querySelector("#container-performance-body");
const imagesBody = document.querySelector("#images-body");
const containerLogs = document.querySelector("#container-logs");
const logsTarget = document.querySelector("#logs-target");
const closeLogsBtn = document.querySelector("#close-logs-btn");
const dashboardGrid = document.querySelector("#dashboard-grid");
const paneDragHandles = document.querySelectorAll(".pane-drag-handle");

let refreshTimer = null;
let eventsSocket = null;
let logsSocket = null;
let activeResizeState = null;
let activeDragState = null;
let isPaneDragDropBound = false;
const paneRevealTimers = new WeakMap();
let lastActivityTime = Date.now();
let sessionTtlMs = 30 * 60 * 1000;
let inactivityCheckTimer = null;
let isSessionExpired = false;
let customPaneDefinitions = [];
const customPaneTimers = {};

const paneGridColumns = 12;
const paneDefaultLayout = {
  system: { col: 1, row: 1, colSpan: 4, rowSpan: 1 },
  containers: { col: 1, row: 2, colSpan: 8, rowSpan: 4 },
  events: { col: 9, row: 1, colSpan: 4, rowSpan: 3 },
  performance: { col: 9, row: 4, colSpan: 4, rowSpan: 3 },
  images: { col: 1, row: 6, colSpan: 6, rowSpan: 3 },
  logs: { col: 7, row: 6, colSpan: 6, rowSpan: 3 }
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)dd_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function resetActivityTimer() {
  lastActivityTime = Date.now();
}

["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"].forEach((eventName) => {
  document.addEventListener(eventName, resetActivityTimer, { passive: true });
});

function disconnectAllSockets() {
  if (eventsSocket) {
    eventsSocket.onclose = null;
    eventsSocket.close();
    eventsSocket = null;
  }
  if (logsSocket) {
    logsSocket.close();
    logsSocket = null;
  }
}

function stopAllTimers() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (inactivityCheckTimer) {
    clearInterval(inactivityCheckTimer);
    inactivityCheckTimer = null;
  }
}

function handleSessionExpired() {
  if (isSessionExpired) {
    return;
  }
  isSessionExpired = true;
  stopAllTimers();
  disconnectAllSockets();
  window.location.href = "/login";
}

async function logout() {
  try {
    await fetch("/auth/logout", { method: "POST" });
  } catch {
    // ignore
  }
  stopAllTimers();
  disconnectAllSockets();
  window.location.href = "/login";
}

async function loadSessionTtl() {
  try {
    const response = await fetch("/api/session/info");
    if (response.ok) {
      const data = await response.json();
      sessionTtlMs = data.ttlMinutes * 60 * 1000;
    }
  } catch {
    // use default
  }
}

function startInactivityCheck() {
  if (inactivityCheckTimer) {
    clearInterval(inactivityCheckTimer);
  }
  inactivityCheckTimer = setInterval(() => {
    if (Date.now() - lastActivityTime > sessionTtlMs) {
      handleSessionExpired();
    }
  }, 10000);
}

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
    if (entry.hidden === true) {
      sanitized[paneId].hidden = true;
    } else {
      markAreaAsOccupied(occupiedCells, slot.col, slot.row, colSpan, rowSpan);
    }
  });

  Object.keys(normalizedLayout).forEach((paneId) => {
    if (!paneDefaultLayout[paneId]) {
      sanitized[paneId] = { ...normalizedLayout[paneId] };
    }
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
    pane.classList.toggle("pane-hidden", layout.hidden === true);
    pane.style.order = "";
    pane.style.gridColumn = `${startColumn} / span ${columnSpan}`;
    pane.style.gridRow = `${startRow} / span ${layout.rowSpan}`;
  });
}

function getAllPaneIds() {
  const builtIn = Object.keys(paneDefaultLayout);
  const custom = customPaneDefinitions.map((p) => `custom-${p.id}`);
  return [...builtIn, ...custom];
}

function getNextAvailableRow() {
  let maxEndRow = 0;
  Object.values(paneLayout).forEach((l) => {
    if (!l.hidden) {
      const endRow = (l.row || 1) + (l.rowSpan || 1);
      if (endRow > maxEndRow) {
        maxEndRow = endRow;
      }
    }
  });
  return Math.max(1, maxEndRow);
}

function getPaneDefaults(paneId) {
  return paneDefaultLayout[paneId] || { col: 1, row: getNextAvailableRow(), colSpan: 6, rowSpan: 2 };
}

function reflowPaneLayout(primaryPaneId, { commit = true } = {}) {
  const maxColumns = getCurrentGridColumns();
  const occupiedCells = new Set();
  const allIds = getAllPaneIds();
  const paneIds = allIds.filter((id) => paneLayout[id]).sort((a, b) => {
    if (a === primaryPaneId) {
      return -1;
    }
    if (b === primaryPaneId) {
      return 1;
    }
    const layoutA = paneLayout[a] || getPaneDefaults(a);
    const layoutB = paneLayout[b] || getPaneDefaults(b);
    if (layoutA.row !== layoutB.row) {
      return layoutA.row - layoutB.row;
    }
    return layoutA.col - layoutB.col;
  });
  allIds.forEach((id) => {
    if (!paneIds.includes(id)) {
      paneIds.push(id);
    }
  });

  const reflowed = {};
  paneIds.forEach((paneId) => {
    const defaults = getPaneDefaults(paneId);
    const current = paneLayout[paneId] || defaults;
    const isHidden = current.hidden === true;
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
    if (isHidden) {
      reflowed[paneId].hidden = true;
    } else {
      markAreaAsOccupied(occupiedCells, slot.col, slot.row, colSpan, rowSpan);
    }
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
  dashboardGrid.querySelectorAll(".pane-drop-ghost").forEach((ghost) => ghost.remove());
}

function resetDragVisualState() {
  dashboardGrid.classList.remove("is-dragging-layout");
  removeDragGhost();
  dashboardGrid.querySelectorAll(".dashboard-pane").forEach((pane) => {
    pane.classList.remove("dragging", "drop-target");
  });
  activeDragState = null;
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
    if (handle.dataset.dragBound === "true") {
      return;
    }
    handle.dataset.dragBound = "true";
    handle.draggable = true;
    handle.addEventListener("dragstart", (event) => {
      resetDragVisualState();
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
      resetDragVisualState();
    });
  });

  if (isPaneDragDropBound) {
    return;
  }
  isPaneDragDropBound = true;

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
      resetDragVisualState();
      draggingPaneId = null;
      return;
    }
    movePaneToGridPosition(draggingPaneId, col, row);
    resetDragVisualState();
    draggingPaneId = null;
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
    startRow,
    startColSpan,
    startRowSpan,
    columnUnit,
    rowUnit,
    maxColumns,
    corner
  } = activeResizeState;
  const deltaColumns = Math.round((event.clientX - startX) / columnUnit);
  const deltaRows = Math.round((event.clientY - startY) / rowUnit);

  let col = startCol;
  let colSpan;
  let row = startRow;
  let rowSpan;

  if (corner.includes("l")) {
    const rightEdge = startCol + startColSpan - 1;
    const nextLeft = clamp(startCol + deltaColumns, 1, rightEdge);
    col = nextLeft;
    colSpan = clamp(rightEdge - nextLeft + 1, 1, maxColumns);
  } else {
    colSpan = clamp(startColSpan + deltaColumns, 1, maxColumns);
  }

  if (corner.includes("t")) {
    const bottomEdge = startRow + startRowSpan - 1;
    const nextTop = clamp(startRow + deltaRows, 1, bottomEdge);
    row = nextTop;
    rowSpan = clamp(bottomEdge - nextTop + 1, 1, 8);
  } else {
    rowSpan = clamp(startRowSpan + deltaRows, 1, 8);
  }

  paneLayout[paneId].col = col;
  paneLayout[paneId].row = row;
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
  const classList = event.currentTarget.classList;
  let corner = "br";
  if (classList.contains("pane-resize-corner-tl")) {
    corner = "tl";
  } else if (classList.contains("pane-resize-corner-tr")) {
    corner = "tr";
  } else if (classList.contains("pane-resize-corner-bl")) {
    corner = "bl";
  }
  const { maxColumns, columnUnit, rowUnit } = getGridMetrics();

  activeResizeState = {
    paneId,
    startX: event.clientX,
    startY: event.clientY,
    startCol: paneLayout[paneId].col,
    startRow: paneLayout[paneId].row,
    startColSpan: paneLayout[paneId].colSpan,
    startRowSpan: paneLayout[paneId].rowSpan,
    columnUnit,
    rowUnit,
    maxColumns,
    corner
  };
  document.body.classList.add("is-resizing");
  dashboardGrid.classList.add("is-dragging-layout");
  window.addEventListener("pointermove", handleResizeMove);
  window.addEventListener("pointerup", stopPaneResize);
}

function setupPaneResizers() {
  const corners = ["tl", "tr", "bl", "br"];
  const proximityThreshold = 60;
  dashboardGrid.querySelectorAll(".dashboard-pane").forEach((pane) => {
    pane.querySelectorAll(".pane-resize-handle").forEach((h) => h.remove());
    const handles = {};
    corners.forEach((corner) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `pane-resize-handle pane-resize-corner-${corner}`;
      btn.title = "Resize";
      btn.addEventListener("pointerdown", startPaneResize);
      pane.appendChild(btn);
      handles[corner] = btn;
    });

    pane.addEventListener("mousemove", (event) => {
      const rect = pane.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const cornerPositions = {
        tl: { x: 0, y: 0 },
        tr: { x: rect.width, y: 0 },
        bl: { x: 0, y: rect.height },
        br: { x: rect.width, y: rect.height }
      };
      let nearest = null;
      let nearestDist = Infinity;
      for (const c of corners) {
        const dx = x - cornerPositions[c].x;
        const dy = y - cornerPositions[c].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = c;
        }
      }
      for (const c of corners) {
        handles[c].classList.toggle("is-nearby", c === nearest && nearestDist < proximityThreshold);
      }
    });

    pane.addEventListener("mouseleave", () => {
      for (const c of corners) {
        handles[c].classList.remove("is-nearby");
      }
    });
  });
}

const paneDisplayNames = {
  system: "Docker Engine",
  containers: "Containers",
  events: "Events",
  performance: "Performance",
  images: "Images",
  logs: "Logs"
};

function isPaneHidden(paneId) {
  return paneLayout[paneId]?.hidden === true;
}

function loadPaneData(paneId) {
  if (paneId.startsWith("custom-")) {
    const defId = paneId.slice(7);
    const paneDef = customPaneDefinitions.find((p) => p.id === defId);
    if (paneDef?.type === "table") {
      loadCustomTablePane(paneDef);
    }
    return;
  }
  const loaders = {
    system: () => loadSystemInfo(),
    containers: () => loadContainers(),
    events: () => { if (!eventsSocket) { connectEvents(); } },
    performance: () => loadPerformance(),
    images: () => loadImages(),
    logs: () => {}
  };
  if (loaders[paneId]) {
    loaders[paneId]();
  }
}

function hidePane(paneId) {
  if (!paneLayout[paneId]) {
    return;
  }
  paneLayout[paneId].hidden = true;
  if (paneId === "events" && eventsSocket) {
    eventsSocket.onclose = null;
    eventsSocket.close();
    eventsSocket = null;
  }
  if (paneId === "logs" && logsSocket) {
    logsSocket.close();
    logsSocket = null;
  }
  if (paneId.startsWith("custom-")) {
    const defId = paneId.slice(7);
    if (customPaneTimers[defId]) {
      clearInterval(customPaneTimers[defId]);
      delete customPaneTimers[defId];
    }
  }
  reflowPaneLayout();
  applyPaneLayout();
  updateAddPaneToolbar();
  savePaneLayout().catch(() => {});
}

function showPane(paneId) {
  if (!paneLayout[paneId]) {
    return;
  }
  delete paneLayout[paneId].hidden;
  loadPaneData(paneId);
  reflowPaneLayout(paneId);
  applyPaneLayout();
  updateAddPaneToolbar();
  savePaneLayout().catch(() => {});
}

function setupPaneCloseButtons() {
  dashboardGrid.querySelectorAll(".dashboard-pane").forEach((pane) => {
    if (pane.querySelector(".pane-close-btn")) {
      return;
    }
    const paneId = pane.dataset.paneId;
    const header = pane.querySelector(".pane-header");
    if (!header) {
      return;
    }
    let actions = header.querySelector(".pane-header-actions");
    if (!actions) {
      const dragHandle = header.querySelector(".pane-drag-handle");
      actions = document.createElement("div");
      actions.className = "pane-header-actions";
      if (dragHandle) {
        header.replaceChild(actions, dragHandle);
        actions.appendChild(dragHandle);
      } else {
        header.appendChild(actions);
      }
    }
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pane-close-btn";
    closeBtn.title = `Hide ${paneDisplayNames[paneId] || paneId}`;
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener("click", () => hidePane(paneId));
    const dragHandle = actions.querySelector(".pane-drag-handle");
    if (dragHandle) {
      actions.insertBefore(closeBtn, dragHandle);
    } else {
      actions.appendChild(closeBtn);
    }
  });
}

async function loadCustomPaneDefinitions() {
  try {
    customPaneDefinitions = await api("/api/custom-panes");
  } catch {
    customPaneDefinitions = [];
  }
}

function createCustomPaneElement(paneDef) {
  const paneId = `custom-${paneDef.id}`;
  const pane = document.createElement("section");
  pane.className = "card dashboard-pane";
  pane.dataset.paneId = paneId;

  const header = document.createElement("div");
  header.className = "pane-header";
  const h2 = document.createElement("h2");
  h2.textContent = paneDef.title;
  const actions = document.createElement("div");
  actions.className = "pane-header-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "pane-edit-btn";
  editBtn.title = "Edit pane";
  editBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  editBtn.addEventListener("click", () => openPaneEditor(paneDef));

  const dragHandle = document.createElement("button");
  dragHandle.type = "button";
  dragHandle.className = "pane-drag-handle";
  dragHandle.title = "Drag to move pane";
  dragHandle.innerHTML = paneDragIconSvg;
  dragHandle.draggable = true;

  actions.append(editBtn, dragHandle);
  header.append(h2, actions);
  pane.appendChild(header);

  if (paneDef.type === "table") {
    const tableWrap = document.createElement("div");
    tableWrap.className = "table-wrap pane-table-wrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    (paneDef.config?.columns || []).forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col.label;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    const tbody = document.createElement("tbody");
    tbody.id = `custom-pane-${paneDef.id}-body`;
    tbody.innerHTML = '<tr><td colspan="99">Loading...</td></tr>';
    table.append(thead, tbody);
    tableWrap.appendChild(table);
    pane.appendChild(tableWrap);
  } else if (paneDef.type === "buttons") {
    const btnGrid = document.createElement("div");
    btnGrid.className = "custom-pane-buttons";
    (paneDef.config?.buttons || []).forEach((btnDef) => {
      const btn = document.createElement("button");
      btn.textContent = btnDef.label;
      if (btnDef.style === "danger") {
        btn.className = "button-danger";
      }
      btn.addEventListener("click", () => runCustomScript(paneDef, btnDef));
      btnGrid.appendChild(btn);
    });
    pane.appendChild(btnGrid);
    const output = document.createElement("pre");
    output.className = "custom-pane-output";
    output.id = `custom-pane-${paneDef.id}-output`;
    pane.appendChild(output);
  }

  return pane;
}

async function loadCustomTablePane(paneDef) {
  const tbody = document.getElementById(`custom-pane-${paneDef.id}-body`);
  if (!tbody) {
    return;
  }
  try {
    const response = await fetchJsonWithTimeout(paneDef.config.url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      headers: { Accept: "application/json" }
    }, 10000);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    let data = await response.json();
    if (!Array.isArray(data)) {
      data = data.items || data.data || data.packages || [];
    }
    tbody.innerHTML = "";
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="99">No data</td></tr>';
      return;
    }
    data.forEach((item) => {
      const row = document.createElement("tr");
      (paneDef.config.columns || []).forEach((col) => {
        if (col.link) {
          row.appendChild(createExternalLinkCell(item[col.key]));
        } else {
          const td = document.createElement("td");
          td.textContent = String(item[col.key] ?? "-");
          row.appendChild(td);
        }
      });
      tbody.appendChild(row);
    });
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="99">Error: ${escapeHtml(error.message)}</td></tr>`;
  }
}

async function runCustomScript(paneDef, btnDef) {
  if (btnDef.confirm && !window.confirm(`Run "${btnDef.label}"?`)) {
    return;
  }
  const outputEl = document.getElementById(`custom-pane-${paneDef.id}-output`);
  if (outputEl) {
    outputEl.textContent = `Running ${btnDef.label}...`;
  }
  try {
    const result = await api("/api/run-script", {
      method: "POST",
      body: JSON.stringify({ script: btnDef.script, args: btnDef.args || [] })
    });
    if (outputEl) {
      outputEl.textContent = result.stdout || result.stderr || "Done (no output)";
    }
  } catch (error) {
    if (outputEl) {
      outputEl.textContent = `Error: ${error.message}`;
    }
  }
}

function renderCustomPanes() {
  dashboardGrid.querySelectorAll('.dashboard-pane[data-pane-id^="custom-"]').forEach((el) => el.remove());
  Object.keys(customPaneTimers).forEach((id) => {
    clearInterval(customPaneTimers[id]);
    delete customPaneTimers[id];
  });

  const toolbar = document.querySelector("#add-pane-toolbar");
  customPaneDefinitions.forEach((paneDef) => {
    const paneEl = createCustomPaneElement(paneDef);
    if (toolbar) {
      dashboardGrid.insertBefore(paneEl, toolbar);
    } else {
      dashboardGrid.appendChild(paneEl);
    }
    const paneId = `custom-${paneDef.id}`;
    if (!paneLayout[paneId]) {
      paneLayout[paneId] = { col: 1, row: getNextAvailableRow(), colSpan: 6, rowSpan: 2 };
    }
    if (paneDef.type === "table" && !isPaneHidden(paneId)) {
      loadCustomTablePane(paneDef);
      const refreshMs = Math.max(5, paneDef.config?.refreshSeconds || 60) * 1000;
      customPaneTimers[paneDef.id] = setInterval(() => {
        if (!isPaneHidden(paneId)) {
          loadCustomTablePane(paneDef);
        }
      }, refreshMs);
    }
  });

  setupPaneCloseButtons();
  setupPaneDragAndDrop();
  setupPaneResizers();
  reflowPaneLayout();
  applyPaneLayout();
}

function updateAddPaneToolbar() {
  const toolbar = document.querySelector("#add-pane-toolbar");
  if (!toolbar) {
    return;
  }
  toolbar.innerHTML = "";
  toolbar.style.display = "";

  const hiddenBuiltIn = Object.keys(paneDefaultLayout).filter((id) => isPaneHidden(id));
  const hiddenCustom = customPaneDefinitions.filter((p) => isPaneHidden(`custom-${p.id}`));

  if (hiddenBuiltIn.length > 0 || hiddenCustom.length > 0) {
    const label = document.createElement("span");
    label.className = "add-pane-label";
    label.textContent = "Add pane:";
    toolbar.appendChild(label);
    hiddenBuiltIn.forEach((paneId) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "add-pane-btn";
      btn.textContent = `+ ${paneDisplayNames[paneId] || paneId}`;
      btn.addEventListener("click", () => showPane(paneId));
      toolbar.appendChild(btn);
    });
    hiddenCustom.forEach((paneDef) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "add-pane-btn";
      btn.textContent = `+ ${paneDef.title}`;
      btn.addEventListener("click", () => showPane(`custom-${paneDef.id}`));
      toolbar.appendChild(btn);
    });
  }

  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "add-pane-btn add-pane-create-btn";
  createBtn.textContent = "+ Custom Pane";
  createBtn.addEventListener("click", () => openPaneEditor());
  toolbar.appendChild(createBtn);
}

function createEditorRow(fields) {
  const row = document.createElement("div");
  row.className = "pane-editor-row";
  fields.forEach((f) => {
    if (f.type === "checkbox") {
      const wrap = document.createElement("label");
      wrap.className = "pane-editor-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = f.name;
      input.checked = f.value || false;
      wrap.appendChild(input);
      wrap.append(` ${f.label}`);
      row.appendChild(wrap);
    } else {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = f.type || "text";
      input.name = f.name;
      input.value = f.value || "";
      input.placeholder = f.placeholder || f.label;
      label.textContent = f.label;
      label.appendChild(input);
      row.appendChild(label);
    }
  });
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "button-danger";
  removeBtn.textContent = "X";
  removeBtn.addEventListener("click", () => row.remove());
  row.appendChild(removeBtn);
  return row;
}

function openPaneEditor(existingDef = null) {
  const overlay = document.createElement("div");
  overlay.className = "pane-editor-overlay";

  const editor = document.createElement("div");
  editor.className = "pane-editor";

  const title = document.createElement("h2");
  title.textContent = existingDef ? "Edit Custom Pane" : "Create Custom Pane";
  editor.appendChild(title);

  const form = document.createElement("form");

  const titleLabel = document.createElement("label");
  titleLabel.textContent = "Title";
  const titleInput = document.createElement("input");
  titleInput.name = "title";
  titleInput.required = true;
  titleInput.value = existingDef?.title || "";
  titleLabel.appendChild(titleInput);
  form.appendChild(titleLabel);

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Type";
  const typeSelect = document.createElement("select");
  typeSelect.name = "type";
  [{ value: "buttons", text: "Buttons (run scripts)" }, { value: "table", text: "Table (fetch data)" }].forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.text;
    if (existingDef?.type === opt.value) {
      option.selected = true;
    }
    typeSelect.appendChild(option);
  });
  typeLabel.appendChild(typeSelect);
  form.appendChild(typeLabel);

  const tableSection = document.createElement("div");
  tableSection.id = "editor-table-section";

  const urlLabel = document.createElement("label");
  urlLabel.textContent = "Data URL";
  const urlInput = document.createElement("input");
  urlInput.name = "url";
  urlInput.type = "url";
  urlInput.value = existingDef?.config?.url || "";
  urlLabel.appendChild(urlInput);
  tableSection.appendChild(urlLabel);

  const refreshLabel = document.createElement("label");
  refreshLabel.textContent = "Refresh interval (seconds)";
  const refreshInput = document.createElement("input");
  refreshInput.name = "refreshSeconds";
  refreshInput.type = "number";
  refreshInput.min = "5";
  refreshInput.value = existingDef?.config?.refreshSeconds || "60";
  refreshLabel.appendChild(refreshInput);
  tableSection.appendChild(refreshLabel);

  const colsHeader = document.createElement("h3");
  colsHeader.textContent = "Columns";
  tableSection.appendChild(colsHeader);

  const colsContainer = document.createElement("div");
  colsContainer.id = "editor-columns";
  (existingDef?.type === "table" && existingDef?.config?.columns || []).forEach((col) => {
    colsContainer.appendChild(createEditorRow([
      { name: "col-key", label: "Key", value: col.key },
      { name: "col-label", label: "Label", value: col.label },
      { name: "col-link", label: "Link", type: "checkbox", value: col.link }
    ]));
  });
  tableSection.appendChild(colsContainer);

  const addColBtn = document.createElement("button");
  addColBtn.type = "button";
  addColBtn.textContent = "+ Add Column";
  addColBtn.addEventListener("click", () => {
    colsContainer.appendChild(createEditorRow([
      { name: "col-key", label: "Key" },
      { name: "col-label", label: "Label" },
      { name: "col-link", label: "Link", type: "checkbox" }
    ]));
  });
  tableSection.appendChild(addColBtn);
  form.appendChild(tableSection);

  const buttonsSection = document.createElement("div");
  buttonsSection.id = "editor-buttons-section";

  const btnsHeader = document.createElement("h3");
  btnsHeader.textContent = "Buttons";
  buttonsSection.appendChild(btnsHeader);

  const btnsContainer = document.createElement("div");
  btnsContainer.id = "editor-buttons";
  (existingDef?.type === "buttons" && existingDef?.config?.buttons || []).forEach((b) => {
    btnsContainer.appendChild(createEditorRow([
      { name: "btn-label", label: "Label", value: b.label },
      { name: "btn-script", label: "Script", value: b.script },
      { name: "btn-confirm", label: "Confirm", type: "checkbox", value: b.confirm }
    ]));
  });
  buttonsSection.appendChild(btnsContainer);

  const addBtnBtn = document.createElement("button");
  addBtnBtn.type = "button";
  addBtnBtn.textContent = "+ Add Button";
  addBtnBtn.addEventListener("click", () => {
    btnsContainer.appendChild(createEditorRow([
      { name: "btn-label", label: "Label" },
      { name: "btn-script", label: "Script" },
      { name: "btn-confirm", label: "Confirm", type: "checkbox" }
    ]));
  });
  buttonsSection.appendChild(addBtnBtn);
  form.appendChild(buttonsSection);

  function updateSections() {
    const isTable = typeSelect.value === "table";
    tableSection.style.display = isTable ? "" : "none";
    buttonsSection.style.display = isTable ? "none" : "";
  }
  typeSelect.addEventListener("change", updateSections);
  updateSections();

  const actionsDiv = document.createElement("div");
  actionsDiv.className = "pane-editor-actions";

  if (existingDef) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "button-danger";
    deleteBtn.textContent = "Delete Pane";
    deleteBtn.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${existingDef.title}"?`)) {
        return;
      }
      try {
        await api(`/api/custom-panes/${existingDef.id}`, { method: "DELETE" });
        const paneId = `custom-${existingDef.id}`;
        delete paneLayout[paneId];
        await loadCustomPaneDefinitions();
        renderCustomPanes();
        updateAddPaneToolbar();
        savePaneLayout().catch(() => {});
      } catch (error) {
        alert(`Failed to delete: ${error.message}`);
      }
      overlay.remove();
    });
    actionsDiv.appendChild(deleteBtn);
  }

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => overlay.remove());
  actionsDiv.appendChild(cancelBtn);

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Save";
  actionsDiv.appendChild(saveBtn);
  form.appendChild(actionsDiv);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const paneData = {
      title: titleInput.value.trim(),
      type: typeSelect.value,
      config: {}
    };

    if (paneData.type === "table") {
      paneData.config.url = urlInput.value.trim();
      paneData.config.refreshSeconds = Number(refreshInput.value) || 60;
      paneData.config.columns = [];
      colsContainer.querySelectorAll(".pane-editor-row").forEach((row) => {
        const key = row.querySelector('[name="col-key"]')?.value?.trim();
        const label = row.querySelector('[name="col-label"]')?.value?.trim();
        const link = row.querySelector('[name="col-link"]')?.checked || false;
        if (key) {
          paneData.config.columns.push({ key, label: label || key, link });
        }
      });
    } else {
      paneData.config.buttons = [];
      btnsContainer.querySelectorAll(".pane-editor-row").forEach((row) => {
        const label = row.querySelector('[name="btn-label"]')?.value?.trim();
        const script = row.querySelector('[name="btn-script"]')?.value?.trim();
        const confirm = row.querySelector('[name="btn-confirm"]')?.checked || false;
        if (label && script) {
          paneData.config.buttons.push({ label, script, confirm });
        }
      });
    }

    try {
      if (existingDef) {
        await api(`/api/custom-panes/${existingDef.id}`, {
          method: "PUT",
          body: JSON.stringify(paneData)
        });
      } else {
        await api("/api/custom-panes", {
          method: "POST",
          body: JSON.stringify(paneData)
        });
      }
      await loadCustomPaneDefinitions();
      renderCustomPanes();
      updateAddPaneToolbar();
      savePaneLayout().catch(() => {});
    } catch (error) {
      alert(`Failed to save: ${error.message}`);
    }
    overlay.remove();
  });

  editor.appendChild(form);
  overlay.appendChild(editor);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.remove();
    }
  });
  document.body.appendChild(overlay);
}

async function initializePaneLayout() {
  paneLayout = await loadPaneLayout();
  await loadCustomPaneDefinitions();
  renderCustomPanes();
  reflowPaneLayout();
  applyPaneLayout();
  setupPaneCloseButtons();
  updateAddPaneToolbar();
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
  const headers = { "Content-Type": "application/json", ...options.headers };
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = getCsrfToken();
  }
  const response = await fetch(path, {
    ...options,
    headers
  });
  if (response.status === 401) {
    handleSessionExpired();
    throw new Error("Session expired");
  }
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
        <td>${escapeHtml(container.names[0] || container.shortId)}</td>
        <td>${escapeHtml(container.image)}</td>
        <td>${escapeHtml(container.state)}</td>
        <td>${escapeHtml(container.status)}</td>
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
    containersBody.innerHTML = `<tr><td colspan="6">Error: ${escapeHtml(error.message)}</td></tr>`;
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
        <td>${escapeHtml(image.tags.join(", "))}</td>
        <td>${escapeHtml(image.shortId)}</td>
        <td>${escapeHtml(formatDateTime(image.created))}</td>
        <td>${escapeHtml(formatBytes(image.size))}</td>
        <td>${escapeHtml(String(image.containers))}</td>
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
    imagesBody.innerHTML = `<tr><td colspan="6">Error: ${escapeHtml(error.message)}</td></tr>`;
  } finally {
    finishPaneLoading(pane);
  }
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
          <td>${escapeHtml(container.name)}</td>
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
        <td>${escapeHtml(container.name)}</td>
        <td>${escapeHtml(formatPercent(metrics.cpuPercent))}</td>
        <td>${escapeHtml(formatPercent(metrics.memoryPercent))} (${escapeHtml(formatBytes(metrics.memoryUsage))})</td>
        <td>${escapeHtml(formatBytes(metrics.network.rxBytes))} / ${escapeHtml(formatBytes(metrics.network.txBytes))}</td>
        <td>${escapeHtml(formatRate(metrics.network.rxRate))} / ${escapeHtml(formatRate(metrics.network.txRate))}</td>
        <td>${escapeHtml(formatBytes(metrics.disk.readBytes))} / ${escapeHtml(formatBytes(metrics.disk.writeBytes))}</td>
      `;
      containerPerformanceBody.appendChild(row);
    });
  } catch (error) {
    hostPerformance.textContent = `Error: ${error.message}`;
    containerPerformanceBody.innerHTML = `<tr><td colspan="6">Error: ${escapeHtml(error.message)}</td></tr>`;
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
    if (isSessionExpired) {
      return;
    }
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
    if (!isPaneHidden("containers")) { loadContainers({ showLoading: false }); }
    if (!isPaneHidden("images")) { loadImages({ showLoading: false }); }
    if (!isPaneHidden("system")) { loadSystemInfo({ showLoading: false }); }
    if (!isPaneHidden("performance")) { loadPerformance({ showLoading: false }); }
  }, 5000);

}

closeLogsBtn.addEventListener("click", () => {
  if (logsSocket) {
    logsSocket.close();
    logsSocket = null;
  }
  logsTarget.textContent = "No container selected";
});

document.querySelector("#logout-btn").addEventListener("click", logout);

loadSessionTtl().then(() => {
  startInactivityCheck();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

initializePaneLayout().then(() => {
  if (!isPaneHidden("containers")) { loadContainers(); }
  if (!isPaneHidden("images")) { loadImages(); }
  if (!isPaneHidden("system")) { loadSystemInfo(); }
  if (!isPaneHidden("performance")) { loadPerformance(); }
  if (!isPaneHidden("events")) { connectEvents(); }
  setAutoRefresh();
});
