import http from "node:http";
import { URL } from "node:url";
import express from "express";
import Docker from "dockerode";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock"
});

app.use(express.json());
app.use(express.static("public"));

function formatDockerError(error) {
  const message = error?.json?.message || error?.reason || error?.message || "Unknown Docker error";
  return { error: message };
}

function normalizeContainer(container) {
  return {
    id: container.Id,
    shortId: container.Id.slice(0, 12),
    names: (container.Names || []).map((name) => name.replace(/^\//, "")),
    image: container.Image,
    imageId: container.ImageID,
    command: container.Command,
    created: container.Created,
    state: container.State,
    status: container.Status,
    ports: container.Ports || [],
    labels: container.Labels || {}
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/system/info", async (_req, res) => {
  try {
    const [info, version] = await Promise.all([docker.info(), docker.version()]);
    res.json({ info, version });
  } catch (error) {
    res.status(500).json(formatDockerError(error));
  }
});

app.get("/api/containers", async (req, res) => {
  try {
    const all = req.query.all !== "false";
    const containers = await docker.listContainers({ all });
    res.json(containers.map(normalizeContainer));
  } catch (error) {
    res.status(500).json(formatDockerError(error));
  }
});

app.get("/api/containers/:id/json", async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const details = await container.inspect();
    res.json(details);
  } catch (error) {
    res.status(500).json(formatDockerError(error));
  }
});

app.post("/api/containers/:id/start", async (req, res) => {
  try {
    await docker.getContainer(req.params.id).start();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json(formatDockerError(error));
  }
});

app.post("/api/containers/:id/stop", async (req, res) => {
  try {
    await docker.getContainer(req.params.id).stop({ t: 10 });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json(formatDockerError(error));
  }
});

app.post("/api/containers/:id/restart", async (req, res) => {
  try {
    await docker.getContainer(req.params.id).restart({ t: 10 });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json(formatDockerError(error));
  }
});

app.get("/api/containers/:id/logs", async (req, res) => {
  try {
    const tail = Number(req.query.tail || 300);
    const logsStream = await docker.getContainer(req.params.id).logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: Number.isNaN(tail) ? 300 : tail
    });
    res.type("text/plain").send(logsStream.toString("utf8"));
  } catch (error) {
    res.status(500).json(formatDockerError(error));
  }
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (socket, request) => {
  const requestUrl = new URL(request.url || "", "http://localhost");
  const mode = requestUrl.searchParams.get("mode") || "events";

  if (mode === "events") {
    let stream;
    try {
      stream = await docker.getEvents();
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", payload: formatDockerError(error) }));
      socket.close();
      return;
    }

    stream.on("data", (chunk) => {
      const payload = chunk.toString("utf8").trim();
      if (!payload) {
        return;
      }
      socket.send(
        JSON.stringify({
          type: "event",
          payload
        })
      );
    });

    stream.on("error", (error) => {
      socket.send(JSON.stringify({ type: "error", payload: formatDockerError(error) }));
    });

    socket.on("close", () => {
      stream.destroy();
    });
    return;
  }

  if (mode === "logs") {
    const id = requestUrl.searchParams.get("id");
    if (!id) {
      socket.send(JSON.stringify({ type: "error", payload: { error: "Missing container id" } }));
      socket.close();
      return;
    }

    let stream;
    try {
      stream = await docker.getContainer(id).logs({
        stdout: true,
        stderr: true,
        follow: true,
        tail: Number(requestUrl.searchParams.get("tail") || 200),
        timestamps: true
      });
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", payload: formatDockerError(error) }));
      socket.close();
      return;
    }

    stream.on("data", (chunk) => {
      socket.send(
        JSON.stringify({
          type: "log",
          payload: chunk.toString("utf8")
        })
      );
    });

    stream.on("error", (error) => {
      socket.send(JSON.stringify({ type: "error", payload: formatDockerError(error) }));
    });

    socket.on("close", () => {
      stream.destroy();
    });
    return;
  }

  socket.send(JSON.stringify({ type: "error", payload: { error: "Unknown WebSocket mode" } }));
  socket.close();
});

server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Docker dashboard running on http://localhost:${port}`);
});
