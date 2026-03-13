const containersBody = document.querySelector("#containers-body");
const systemInfo = document.querySelector("#system-info");
const eventsLog = document.querySelector("#events-log");
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
  } catch (error) {
    alert(`Failed to ${action}: ${error.message}`);
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

      actionsCell.append(startBtn, stopBtn, restartBtn, logsBtn);
      containersBody.appendChild(row);
    });
  } catch (error) {
    containersBody.innerHTML = `<tr><td colspan="6">Error: ${error.message}</td></tr>`;
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
      loadSystemInfo();
    }, 5000);
  }
}

refreshBtn.addEventListener("click", () => {
  loadContainers();
  loadSystemInfo();
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
loadSystemInfo();
setAutoRefresh(true);
connectEvents();
