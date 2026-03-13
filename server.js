import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import express from "express";
import Docker from "dockerode";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock"
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const dashboardPassword = process.env.DASHBOARD_PASSWORD;
if (!dashboardPassword) {
  console.error("Missing DASHBOARD_PASSWORD environment variable.");
  process.exit(1);
}

const sessionCookieName = "dd_session";
const sessionTtlMinutes = Math.max(1, Number(process.env.AUTH_SESSION_TTL_MINUTES || 30));
const sessionSecret = process.env.AUTH_SESSION_SECRET || dashboardPassword;

function formatDockerError(error) {
  const message = error?.json?.message || error?.reason || error?.message || "Unknown Docker error";
  return { error: message };
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((acc, pair) => {
    const [rawKey, ...rawValue] = pair.trim().split("=");
    if (!rawKey) {
      return acc;
    }
    acc[rawKey] = decodeURIComponent(rawValue.join("="));
    return acc;
  }, {});
}

function signValue(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function timingSafeEqual(a, b) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function createSessionToken() {
  const expiresAt = Date.now() + sessionTtlMinutes * 60 * 1000;
  const payload = String(expiresAt);
  const signature = signValue(payload);
  return `${payload}.${signature}`;
}

function isValidSessionToken(token) {
  if (!token || !token.includes(".")) {
    return false;
  }
  const tokenParts = token.split(".");
  if (tokenParts.length !== 2) {
    return false;
  }
  const [expiresAtRaw, signature] = tokenParts;
  const expected = signValue(expiresAtRaw);
  if (!timingSafeEqual(signature, expected)) {
    return false;
  }
  const expiresAt = Number(expiresAtRaw);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function isAuthenticatedFromCookieHeader(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  return isValidSessionToken(cookies[sessionCookieName]);
}

function setSessionCookie(res, req) {
  const token = createSessionToken();
  const maxAgeSeconds = sessionTtlMinutes * 60;
  const isSecure =
    req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`
  );
}

function renderLoginPage(hasError) {
  const errorHtml = hasError
    ? '<p style="color:#fca5a5;margin:0 0 12px;">Invalid password</p>'
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Docker Dashboard Login</title>
    <style>
      * { box-sizing: border-box; }
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0f172a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      .card { width:min(92vw,360px); background:#1e293b; border:1px solid #334155; border-radius:10px; padding:18px; }
      h1 { margin:0 0 12px; font-size:1.1rem; }
      input, button { display:block; width:100%; border-radius:7px; border:1px solid #475569; background:#0f172a; color:#e2e8f0; padding:10px; }
      button { cursor:pointer; margin-top:10px; background:#0ea5e9; border:none; color:#082f49; font-weight:600; }
      p { color:#94a3b8; font-size:0.9rem; margin:0 0 12px; }
    </style>
  </head>
  <body>
    <form class="card" method="POST" action="/auth/login">
      <h1>Docker Dashboard</h1>
      <p>Enter dashboard password</p>
      ${errorHtml}
      <input type="password" name="password" placeholder="Password" required autofocus />
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>`;
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

app.get("/login", (req, res) => {
  if (isAuthenticatedFromCookieHeader(req.headers.cookie)) {
    res.redirect("/");
    return;
  }
  const hasError = req.query.error === "1";
  res.type("html").send(renderLoginPage(hasError));
});

app.post("/auth/login", (req, res) => {
  const submittedPassword = String(req.body?.password || "");
  if (!timingSafeEqual(submittedPassword, dashboardPassword)) {
    res.redirect("/login?error=1");
    return;
  }
  setSessionCookie(res, req);
  res.redirect("/");
});

app.post("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.use((req, res, next) => {
  if (req.path === "/login" || req.path === "/auth/login" || req.path === "/api/health") {
    next();
    return;
  }

  if (isAuthenticatedFromCookieHeader(req.headers.cookie)) {
    next();
    return;
  }

  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.redirect("/login");
});

app.use(express.static("public"));

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
  if (!isAuthenticatedFromCookieHeader(request.headers.cookie)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
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
