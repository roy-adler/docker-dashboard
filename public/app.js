const containersBody = document.querySelector("#containers-body");
const systemInfo = document.querySelector("#system-info");
const eventsLog = document.querySelector("#events-log");
const hostPerformance = document.querySelector("#host-performance");
const containerPerformanceBody = document.querySelector("#container-performance-body");
const imagesBody = document.querySelector("#images-body");
const containerLogs = document.querySelector("#container-logs");
const logsTarget = document.querySelector("#logs-target");
const refreshBtn = document.querySelector("#refresh-btn");
const autoRefreshCheckbox = document.querySelector("#auto-refresh");
const closeLogsBtn = document.querySelector("#close-logs-btn");

let refreshTimer = null;
let eventsSocket = null;
let logsSocket = null;

function setSystemInfoText(text) {
  systemInfo.textContent = text;
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

function formatPorts(ports) {
  if (!ports || ports.length === 0) {
    return "-";
  }
  return ports
    .map((port) => {
      const privatePort = `${port.PrivatePort}/${port.Type}`;
      if (port.PublicPort) {
        return `${port.IP || "0.0.0.0"}:${port.PublicPort} -> ${privatePort}`;
      }
      return privatePort;
    })
    .join(", ");
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

async function loadSystemInfo() {
  try {
    const payload = await api("/api/system/info");
    setSystemInfoText(
      `${payload.info.Name} | ${payload.info.OperatingSystem} | ${payload.version.Version} | ${payload.info.ContainersRunning} running / ${payload.info.Containers} total`
    );
  } catch (error) {
    setSystemInfoText(`Error: ${error.message}`);
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

async function loadContainers() {
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
        <td>${formatPorts(container.ports)}</td>
        <td class="actions"></td>
      `;
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
  }
}

async function loadImages() {
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

async function loadPerformance() {
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

function setAutoRefresh(enabled) {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (enabled) {
    refreshTimer = setInterval(() => {
      loadContainers();
      loadImages();
      loadSystemInfo();
      loadPerformance();
    }, 5000);
  }
}

refreshBtn.addEventListener("click", () => {
  loadContainers();
  loadImages();
  loadSystemInfo();
  loadPerformance();
});

autoRefreshCheckbox.addEventListener("change", () => {
  setAutoRefresh(autoRefreshCheckbox.checked);
});

closeLogsBtn.addEventListener("click", () => {
  if (logsSocket) {
    logsSocket.close();
    logsSocket = null;
  }
  logsTarget.textContent = "No container selected";
});

loadContainers();
loadImages();
loadSystemInfo();
loadPerformance();
setAutoRefresh(true);
connectEvents();
