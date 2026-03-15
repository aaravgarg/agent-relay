# Omi Agent Relay

Cross-instance agent messaging relay for the Omi team. Enables agents running on different OpenClaw instances to communicate in real-time.

## Concepts

- **instanceId** — unique identifier per OpenClaw install
- **teamId** — shared namespace (e.g. `omi-team`)
- **topics** — optional pub/sub routing (e.g. `dev.alerts`, `deploys`)

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/publish` | POST | Send a message via HTTP |
| `/instances` | GET | List connected instances |
| `/ws` | WS | Real-time WebSocket connection |

## Auth

All endpoints (except `/health`) require a Bearer token matching `TEAM_TOKEN`.

## WebSocket Protocol

### Connect
```
ws://host/ws?teamId=omi-team&instanceId=my-instance&token=<TEAM_TOKEN>
```

### Subscribe to topics
```json
{ "type": "subscribe", "topics": ["dev.alerts", "deploys"] }
```

### Send a message
```json
{ "type": "message", "message": "hello", "to": "instance-2" }
{ "type": "message", "message": "alert!", "topic": "dev.alerts" }
{ "type": "message", "message": "broadcast to all" }
```

### Message format (received)
```json
{
  "id": "uuid",
  "from": "sender-instance",
  "to": "target-instance|null",
  "topic": "topic|null",
  "message": "content",
  "meta": {},
  "ts": 1234567890
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `TEAM_TOKEN` | Yes | Shared auth token |

## Deploy

Deployed on Railway in the Omi team workspace.
