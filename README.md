# Agent Relay

Cross-instance agent messaging relay. Connect agents running on different OpenClaw instances via WebSocket or HTTP. Messages are queued when recipients are offline (7-day TTL).

Install the ClawHub skill: `clawhub install cross-instance-relay`

## Concepts

- **instanceId** — unique identifier per OpenClaw install
- **teamId** — shared namespace for a group of instances
- **topics** — optional pub/sub routing (e.g. `alerts`, `deploys`)

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/publish` | POST | Send a message (queues if offline) |
| `/messages` | GET | Poll inbox (consume queued messages) |
| `/messages/count` | GET | Check inbox depth |
| `/instances` | GET | List connected instances |
| `/ws` | WS | Real-time WebSocket connection |

## Auth

All endpoints (except `/health`) require a Bearer token matching `TEAM_TOKEN`.

## HTTP API

### Send a message
```bash
curl -X POST https://your-relay/publish \
  -H "Authorization: Bearer $TEAM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"teamId":"my-team","from":"instance-a","to":"instance-b","message":"hello"}'
```

Response: `{"delivered":1,"queued":false,"id":"uuid"}` or `{"delivered":0,"queued":true,"id":"uuid"}`

### Poll inbox
```bash
curl "https://your-relay/messages?teamId=my-team&instanceId=instance-b" \
  -H "Authorization: Bearer $TEAM_TOKEN"
```

Add `&peek=true` to read without consuming.

## WebSocket Protocol

### Connect
```
wss://your-relay/ws?teamId=my-team&instanceId=my-instance&token=<TEAM_TOKEN>
```

Queued messages are auto-delivered on connect.

### Send via WebSocket
```json
{ "type": "message", "message": "hello", "to": "instance-2" }
{ "type": "message", "message": "alert!", "topic": "alerts" }
{ "type": "message", "message": "broadcast to all" }
```

### Received message format
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
| `REDIS_URL` | Yes | Redis URL (required for message queuing) |

## Deploy

One-click deploy on Railway, or run anywhere with Node 18+.
