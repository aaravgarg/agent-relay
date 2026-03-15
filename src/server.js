const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3000;
const TEAM_TOKEN = process.env.TEAM_TOKEN;
const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
const MESSAGE_TTL = 60 * 60 * 24 * 7; // 7 days

if (!TEAM_TOKEN) {
  console.error('TEAM_TOKEN env var is required');
  process.exit(1);
}

// --- Redis ---
let redis = null;
let redisPub = null;
let redisSub = null;
const REDIS_CHANNEL = 'relay:messages';

if (REDIS_URL) {
  redis = new Redis(REDIS_URL);
  redisPub = new Redis(REDIS_URL);
  redisSub = new Redis(REDIS_URL);

  redis.on('connect', () => console.log('[redis] connected'));
  redisPub.on('connect', () => console.log('[redis] pub connected'));
  redisSub.on('connect', () => console.log('[redis] sub connected'));
  redis.on('error', (e) => console.error('[redis] error:', e.message));
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
} else {
  console.warn('[warn] No REDIS_URL — message queue disabled, only real-time delivery');
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
const teams = new Map();
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

// --- Message Queue (Redis) ---
function queueKey(teamId, instanceId) {
  return `relay:queue:${teamId}:${instanceId}`;
}

async function enqueueMessage(teamId, instanceId, payload) {
  if (!redis) return;
  const key = queueKey(teamId, instanceId);
  await redis.rpush(key, payload);
  await redis.expire(key, MESSAGE_TTL);
}

async function dequeueMessages(teamId, instanceId, limit = 100) {
  if (!redis) return [];
  const key = queueKey(teamId, instanceId);
  const messages = await redis.lrange(key, 0, limit - 1);
  if (messages.length > 0) {
    await redis.ltrim(key, messages.length, -1);
  }
  return messages;
}

async function peekMessages(teamId, instanceId, limit = 100) {
  if (!redis) return [];
  const key = queueKey(teamId, instanceId);
  return redis.lrange(key, 0, limit - 1);
}

async function queueLength(teamId, instanceId) {
  if (!redis) return 0;
  const key = queueKey(teamId, instanceId);
  return redis.llen(key);
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

async function routeMessage(teamId, from, envelope) {
  const { to, topic, message, meta } = envelope;
  const msgId = uuidv4();
  const payload = JSON.stringify({
    id: msgId,
    from,
    to: to || null,
    topic: topic || null,
    message,
    meta: meta || {},
    ts: Date.now(),
  });

  const localDelivered = deliverLocal(teamId, from, envelope, payload);

  // If target is offline and it's a direct message, queue it
  if (to && localDelivered === 0 && redis) {
    await enqueueMessage(teamId, to, payload);
  }

  // For broadcasts/topics with no listeners, queue for all known instances
  if (!to && !topic && localDelivered === 0 && redis) {
    // Get all known instances from Redis
    const knownKey = `relay:known:${teamId}`;
    const knownInstances = await redis.smembers(knownKey);
    for (const inst of knownInstances) {
      if (inst !== from) {
        await enqueueMessage(teamId, inst, payload);
      }
    }
  }

  // Publish to Redis for other replicas
  if (redisPub) {
    redisPub.publish(REDIS_CHANNEL, JSON.stringify({ teamId, from, envelope, payload })).catch(() => {});
  }

  return { delivered: localDelivered, queued: localDelivered === 0, id: msgId };
}

// Track known instances
async function trackInstance(teamId, instanceId) {
  if (!redis) return;
  const key = `relay:known:${teamId}`;
  await redis.sadd(key, instanceId);
}

// --- Express App ---
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connections: connMeta.size,
    teams: teams.size,
    redis: !!redis,
    queueEnabled: !!redis,
  });
});

// HTTP publish — now queues if target is offline
app.post('/publish', async (req, res) => {
  const token = extractToken(req);
  if (!authenticate(token)) return res.status(401).json({ error: 'unauthorized' });

  const { teamId, from, to, topic, message, meta } = req.body;
  if (!teamId || !from || !message) {
    return res.status(400).json({ error: 'teamId, from, and message are required' });
  }

  // Track sender as known instance
  await trackInstance(teamId, from);

  const result = await routeMessage(teamId, from, { to, topic, message, meta });
  res.json(result);
});

// Poll for queued messages (the key endpoint for async messaging)
app.get('/messages', async (req, res) => {
  const token = extractToken(req);
  if (!authenticate(token)) return res.status(401).json({ error: 'unauthorized' });

  const { teamId, instanceId, limit, peek } = req.query;
  if (!teamId || !instanceId) {
    return res.status(400).json({ error: 'teamId and instanceId query params required' });
  }

  // Track as known instance
  await trackInstance(teamId, instanceId);

  const maxMessages = Math.min(parseInt(limit) || 100, 500);

  if (peek === 'true') {
    const messages = await peekMessages(teamId, instanceId, maxMessages);
    return res.json({ messages: messages.map(m => JSON.parse(m)), count: messages.length });
  }

  // Default: dequeue (consume)
  const messages = await dequeueMessages(teamId, instanceId, maxMessages);
  res.json({ messages: messages.map(m => JSON.parse(m)), count: messages.length });
});

// Check queue depth
app.get('/messages/count', async (req, res) => {
  const token = extractToken(req);
  if (!authenticate(token)) return res.status(401).json({ error: 'unauthorized' });

  const { teamId, instanceId } = req.query;
  if (!teamId || !instanceId) {
    return res.status(400).json({ error: 'teamId and instanceId query params required' });
  }

  const count = await queueLength(teamId, instanceId);
  res.json({ count });
});

// List connected instances
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

wss.on('connection', async (ws, { teamId, instanceId }) => {
  register(ws, teamId, instanceId);
  await trackInstance(teamId, instanceId);
  console.log(`[+] ${instanceId} joined ${teamId} (${connMeta.size} total)`);

  ws.send(JSON.stringify({ type: 'connected', teamId, instanceId }));

  // Deliver any queued messages on connect
  if (redis) {
    const queued = await dequeueMessages(teamId, instanceId);
    for (const msg of queued) {
      ws.send(msg);
    }
    if (queued.length > 0) {
      console.log(`[>] delivered ${queued.length} queued messages to ${instanceId}`);
    }
  }

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
      routeMessage(teamId, instanceId, {
        to: data.to,
        topic: data.topic,
        message: data.message,
        meta: data.meta,
      }).then(result => {
        ws.send(JSON.stringify({ type: 'ack', id: data.id, ...result }));
      });
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
  console.log(`Relay server running on port ${PORT} (redis: ${!!redis}, queue: ${!!redis})`);
});
