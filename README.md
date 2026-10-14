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
docker run -p 3000:3000 -v ./data:/app/data -e PASSWORD=secret planning-poker
```

## Configuration

| Variable   | Default    | Description                         |
|------------|------------|-------------------------------------|
| `PORT`     | `3000`     | HTTP port                           |
| `HOST`     | `0.0.0.0`  | Interface to listen on              |
| `DATA_DIR` | `./data`   | Where `rooms.json` is stored        |
| `PASSWORD` | unset      | Unset = open access, no login       |

## CSV

The first row is a header. Recognized columns (case-insensitive):

- `Key`, `Summary`, `Description`, `Link`, `Estimate`

Other columns are kept and round-tripped on export.

## License

MIT
