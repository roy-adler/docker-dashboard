# Docker Dashboard

Simple Docker dashboard app that talks directly to the Docker daemon.

## Features

- List containers (running + stopped)
- Start, stop, restart containers
- Live Docker event stream
- Container logs (historical + live follow)
- Basic Docker engine/system info

## Run with Docker Compose

```bash
DASHBOARD_PASSWORD="your-strong-password" docker compose up --build
```

Or put it in a `.env` file:

```bash
DASHBOARD_PASSWORD=your-strong-password
docker compose up --build
```

Open: [http://localhost:3000](http://localhost:3000)

## Run locally (without container)

```bash
npm install
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

This app requires access to Docker socket (`/var/run/docker.sock`), which effectively gives host-level Docker control. Restrict network access and add authentication before exposing beyond trusted environments.
