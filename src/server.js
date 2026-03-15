const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3000;
const TEAM_TOKEN = process.env.TEAM_TOKEN;
const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;

if (!TEAM_TOKEN) {
  console.error('TEAM_TOKEN env var is required');
  process.exit(1);
}

// --- Redis (optional, enables multi-replica) ---
let redisPub = null;
let redisSub = null;
const REDIS_CHANNEL = 'relay:messages';

if (REDIS_URL) {
  redisPub = new Redis(REDIS_URL);
  redisSub = new Redis(REDIS_URL);

  redisPub.on('connect', () => console.log('[redis] pub connected'));
  redisSub.on('connect', () => console.log('[redis] sub connected'));
  redisPub.on('error', (e) => console.error('[redis] pub error:', e.message));
  redisSub.on('error', (e) => console.error('[redis] sub error:', e.message));

  redisSub.subscribe(REDIS_CHANNEL, (err) => {
    if (err) console.error('[redis] subscribe error:', err.message);
    else console.log('[redis] subscribed to', REDIS_CHANNEL);
  });

  redisSub.on('message', (channel, raw) => {
    if (channel !== REDIS_CHANNEL) return;
    try {
      const { teamId, from, envelope, payload } = JSON.parse(raw);
      deliverLocal(teamId, from, envelope, payload);
    } catch {}
  });
}

// --- Auth ---
function authenticate(token) {
  return token === TEAM_TOKEN;
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('token') || '';
}

// --- Connection Registry ---
// Map<teamId, Map<instanceId, Set<WebSocket>>>
const teams = new Map();
// Map<ws, { teamId, instanceId, topics }>
const connMeta = new Map();

function getTeam(teamId) {
  if (!teams.has(teamId)) teams.set(teamId, new Map());
  return teams.get(teamId);
}

function register(ws, teamId, instanceId) {
  const team = getTeam(teamId);
  if (!team.has(instanceId)) team.set(instanceId, new Set());
  team.get(instanceId).add(ws);
  connMeta.set(ws, { teamId, instanceId, topics: new Set() });
}

function unregister(ws) {
  const meta = connMeta.get(ws);
  if (!meta) return;
  const { teamId, instanceId } = meta;
  const team = teams.get(teamId);
  if (team) {
    const conns = team.get(instanceId);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) team.delete(instanceId);
    }
    if (team.size === 0) teams.delete(teamId);
  }
  connMeta.delete(ws);
}

// --- Message Routing ---
function deliverLocal(teamId, from, envelope, payload) {
  const team = teams.get(teamId);
  if (!team) return 0;

  const { to, topic } = envelope;
  let delivered = 0;

  if (to) {
    const conns = team.get(to);
    if (conns) {
      for (const ws of conns) {
        if (ws.readyState === 1) { ws.send(payload); delivered++; }
      }
    }
  } else if (topic) {
    for (const [instId, conns] of team) {
      if (instId === from) continue;
      for (const ws of conns) {
        const m = connMeta.get(ws);
        if (m && m.topics.has(topic) && ws.readyState === 1) {
          ws.send(payload); delivered++;
        }
      }
    }
  } else {
    for (const [instId, conns] of team) {
      if (instId === from) continue;
      for (const ws of conns) {
        if (ws.readyState === 1) { ws.send(payload); delivered++; }
      }
    }
  }

  return delivered;
}

function routeMessage(teamId, from, envelope) {
  const { to, topic, message, meta } = envelope;
  const payload = JSON.stringify({
    id: uuidv4(),
    from,
    to: to || null,
    topic: topic || null,
    message,
    meta: meta || {},
    ts: Date.now(),
  });

  const localDelivered = deliverLocal(teamId, from, envelope, payload);

  // Publish to Redis for other replicas
  if (redisPub) {
    redisPub.publish(REDIS_CHANNEL, JSON.stringify({ teamId, from, envelope, payload })).catch(() => {});
  }

  return localDelivered;
}

// --- Express App ---
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  const totalConns = connMeta.size;
  const teamCount = teams.size;
  res.json({
    status: 'ok',
    connections: totalConns,
    teams: teamCount,
    redis: !!redisPub,
  });
});

app.post('/publish', (req, res) => {
  const token = extractToken(req);
  if (!authenticate(token)) return res.status(401).json({ error: 'unauthorized' });

  const { teamId, from, to, topic, message, meta } = req.body;
  if (!teamId || !from || !message) {
    return res.status(400).json({ error: 'teamId, from, and message are required' });
  }

  const delivered = routeMessage(teamId, from, { to, topic, message, meta });
  res.json({ delivered, id: uuidv4() });
});

app.get('/instances', (req, res) => {
  const token = extractToken(req);
  if (!authenticate(token)) return res.status(401).json({ error: 'unauthorized' });

  const teamId = req.query.teamId;
  if (!teamId) return res.status(400).json({ error: 'teamId query param required' });

  const team = teams.get(teamId);
  if (!team) return res.json({ instances: [] });

  const instances = [];
  for (const [instId, conns] of team) {
    instances.push({ instanceId: instId, connections: conns.size });
  }
  res.json({ instances });
});

// --- HTTP Server + WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const token = extractToken(req);
  if (!authenticate(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const teamId = url.searchParams.get('teamId');
  const instanceId = url.searchParams.get('instanceId');

  if (!teamId || !instanceId) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, { teamId, instanceId });
  });
});

wss.on('connection', (ws, { teamId, instanceId }) => {
  register(ws, teamId, instanceId);
  console.log(`[+] ${instanceId} joined ${teamId} (${connMeta.size} total)`);

  ws.send(JSON.stringify({ type: 'connected', teamId, instanceId }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'subscribe' && data.topics) {
      const meta = connMeta.get(ws);
      if (meta) {
        for (const t of data.topics) meta.topics.add(t);
        ws.send(JSON.stringify({ type: 'subscribed', topics: [...meta.topics] }));
      }
      return;
    }

    if (data.type === 'unsubscribe' && data.topics) {
      const meta = connMeta.get(ws);
      if (meta) {
        for (const t of data.topics) meta.topics.delete(t);
        ws.send(JSON.stringify({ type: 'unsubscribed', topics: [...meta.topics] }));
      }
      return;
    }

    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    if (data.type === 'message' && data.message) {
      const delivered = routeMessage(teamId, instanceId, {
        to: data.to,
        topic: data.topic,
        message: data.message,
        meta: data.meta,
      });
      ws.send(JSON.stringify({ type: 'ack', id: data.id, delivered }));
      return;
    }
  });

  ws.on('close', () => {
    unregister(ws);
    console.log(`[-] ${instanceId} left ${teamId} (${connMeta.size} total)`);
  });

  ws.on('error', (err) => {
    console.error(`[!] ${instanceId}: ${err.message}`);
    unregister(ws);
  });
});

// --- Heartbeat ---
setInterval(() => {
  for (const [ws] of connMeta) {
    if (ws.readyState !== 1) { unregister(ws); continue; }
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Relay server running on port ${PORT} (redis: ${!!redisPub})`);
});
