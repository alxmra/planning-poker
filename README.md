# 🃏 Planning Poker

Self-hosted, zero-dependency planning poker with realtime rooms.

## Features

- Realtime rooms, shared via an invite link
- Votes persist per story and across restarts (saved to `data/rooms.json`)
- Auto-reveal with a 3s countdown when everyone has voted
- Estimate = average of votes rounded up to the next card, auto-saved and editable
- CSV import/export
- Spectator mode, keyboard shortcuts (press `?`), dark mode

## Run

Requires Node.js 18+.

```bash
node server.js   # or: npm start
```

Open http://localhost:3000

## Local network

The server listens on `0.0.0.0` and prints LAN URLs on start. Share `http://<your-ip>:3000/?room=...` with your team. Your firewall may need to allow the port.

## Internet via ngrok

```bash
ngrok http 3000
```

Share the `https://` URL ngrok prints. When exposing the app publicly, set a password:

```bash
PASSWORD=secret node server.js
```

or use ngrok's built-in protection: `ngrok http 3000 --basic-auth user:pass`.

## Docker

```bash
docker build -t planning-poker .
docker run -p 3000:3000 -v pp-data:/app/data -e PASSWORD=secret planning-poker
```

## VPS (public, HTTPS)

Point a domain at the server, then:

```bash
DOMAIN=poker.example.com docker compose up -d
```

Caddy gets a TLS certificate automatically and proxies to the app. The app container runs as non-root, read-only, with no capabilities and memory/pid limits.

Built-in protections:

- Rooms are created server-side with random 16-char ids; unknown rooms return 404
- Each browser holds a secret id; others only see a derived public id, so nobody can vote or act as someone else
- Idle rooms are deleted after `ROOM_TTL_HOURS` (rooms with people connected are kept)
- Per-IP rate limits (actions, connections, room creation 10/h, password attempts), max 50 players and 500 stories per room, 1 MB request limit
- Strict Content-Security-Policy, no framing

Anyone with a room link can edit that room, so share links only with your team. Set `PASSWORD` to make the whole instance private.

## Configuration

| Variable         | Default   | Description                                   |
|------------------|-----------|-----------------------------------------------|
| `PORT`           | `3000`    | HTTP port                                     |
| `HOST`           | `0.0.0.0` | Interface to listen on                        |
| `DATA_DIR`       | `./data`  | Where `rooms.json` is stored                  |
| `PASSWORD`       | unset     | Unset = open access                           |
| `ROOM_TTL_HOURS` | `168`     | Delete rooms idle for this long               |
| `MAX_ROOMS`      | `1000`    | Max rooms on the server                       |
| `TRUST_PROXY`    | unset     | `1` when behind a reverse proxy (real client IPs) |

## CSV

The first row is a header. Recognized columns (case-insensitive):

- `Key`, `Summary`, `Description`, `Link`, `Estimate`
- `Acceptance Criteria` (also `AC`, `CA`, `Critérios de Aceitação`), multiline allowed

Other columns are kept and round-tripped on export.

Example: [`examples/user-stories.csv`](examples/user-stories.csv)

## License

MIT
