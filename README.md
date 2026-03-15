# Agent Relay

Cross-instance agent messaging relay. Connect agents running on different OpenClaw instances in real-time via WebSocket or HTTP.

## Concepts

- **instanceId** — unique identifier per OpenClaw install
- **teamId** — shared namespace for a group of instances
- **topics** — optional pub/sub routing (e.g. `alerts`, `deploys`)

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
ws://host/ws?teamId=my-team&instanceId=my-instance&token=<TEAM_TOKEN>
```

### Subscribe to topics
```json
{ "type": "subscribe", "topics": ["alerts", "deploys"] }
```

### Send a message
```json
{ "type": "message", "message": "hello", "to": "instance-2" }
{ "type": "message", "message": "alert!", "topic": "alerts" }
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
| `REDIS_URL` | No | Redis URL for multi-replica pub/sub |

## Deploy

One-click deploy on Railway, or run anywhere with Node 18+.
