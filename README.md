# Docker Dashboard

Simple Docker dashboard app that talks directly to the Docker daemon.

## Features

- List containers (running + stopped)
- Start, stop, restart containers
- Live Docker event stream
- Container logs (historical + live follow)
- Basic Docker engine/system info

## Run with Docker Compose

**Behind Authelia (recommended):** the app trusts the `Remote-User` header from your reverse proxy after Authelia forward-auth. Do not expose the container directly to untrusted networks.

```bash
AUTH_MODE=authelia docker compose up --build
```

Optional:

- `REMOTE_USER_HEADER` — header to read (default: `Remote-User`, matching Authelia)
- `AUTHELIA_LOGOUT_URL` — URL for the dashboard **Logout** button (your Authelia portal sign-out URL)

**Standalone password auth (legacy):**

```bash
DASHBOARD_PASSWORD="your-strong-password" docker compose up --build
```

Or put variables in a `.env` file, then `docker compose up --build`.

Open: [http://localhost:3000](http://localhost:3000)

## Run locally (without container)

```bash
npm install
AUTH_MODE=authelia npm start
# or
DASHBOARD_PASSWORD=your-strong-password AUTH_SESSION_TTL_MINUTES=30 npm start
```

## API endpoints

- `GET /api/system/info`
- `GET /api/containers`
- `GET /api/containers/:id/json`
- `POST /api/containers/:id/start`
- `POST /api/containers/:id/stop`
- `POST /api/containers/:id/restart`
- `GET /api/containers/:id/logs?tail=300`
- `WS /ws?mode=events`
- `WS /ws?mode=logs&id=<container-id>&tail=200`

## Security note

This app requires access to Docker socket (`/var/run/docker.sock`), which effectively gives host-level Docker control. Restrict network access. With `AUTH_MODE=authelia`, only place the dashboard behind Authelia and a reverse proxy that strips or overwrites `Remote-User` from client requests (normal forward-auth setup).
