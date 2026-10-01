import http from 'node:http';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createStorageFromEnv } from './storage.js';
import { Telegram, escapeHtml } from './telegram.js';
import { RustPlusManager } from './rustplus-listener.js';
import { PairingListener } from './pairing-listener.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

function loadDotEnv(filePath = path.resolve(process.cwd(), '.env')) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

const port = Number(process.env.PORT || 3000);
const telegramMode = process.env.TELEGRAM_MODE || 'polling';
let pollingOffset = Number(process.env.TELEGRAM_POLLING_OFFSET || 0) || undefined;
let pollingRunning = false;
const fcmMemoryLimitMb = Number(process.env.FCM_MEMORY_LIMIT_MB || 180);

const storage = createStorageFromEnv();
const telegram = new Telegram(process.env.TELEGRAM_BOT_TOKEN);
const rustPlus = new RustPlusManager({
  storage,
  telegram,
  cooldownSeconds: process.env.ALERT_COOLDOWN_SECONDS || 60
});

const pairingListener = new PairingListener({
  storage,
  telegram,
  rustPlus,
  configFile: process.env.RUSTPLUS_CONFIG_FILE || './rustplus.config.json',
  onPairing: saveAutomaticPairing
});

const fcmMemoryGuard = setInterval(() => {
  const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
  if (pairingListener.getStatus().status === 'connected' && heapMb > fcmMemoryLimitMb) {
    console.error(`Stopping Rust+ FCM listener at ${Math.round(heapMb)} MB to keep the web service alive.`);
    pairingListener.stop();
    pairingListener.status = 'memory_guard';
    pairingListener.lastError = `FCM listener exceeded ${fcmMemoryLimitMb} MB on this host.`;
  }
}, 10_000);
fcmMemoryGuard.unref?.();

function currentSteamId(req) {
  const match = (req.headers.cookie || '').match(/steamId=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function saveAutomaticPairing(pairing) {
  let outcome = 'created';
  await storage.update((state) => {
    const user = (state.users || []).find((item) => item.steamId === pairing.playerId);
    if (!user) {
      outcome = 'unknown-user';
      return;
    }
    let server = state.servers.find((item) => item.ip === pairing.ip && String(item.port) === String(pairing.port));
    if (!server) {
      server = { id: pairing.serverId || crypto.randomUUID(), name: pairing.name, ip: pairing.ip, port: pairing.port, playerId: pairing.playerId, playerToken: pairing.playerToken, enabled: true, entities: [], steamIds: [pairing.playerId] };
      state.servers.push(server);
    } else {
      server.enabled = true;
      server.steamIds = [...new Set([...(server.steamIds || []), pairing.playerId])];
      outcome = pairing.entityId ? 'device-updated' : 'server-already-linked';
    }
    if (pairing.entityId && !server.entities.some((item) => String(item.id) === String(pairing.entityId))) {
      server.entities.push({ id: pairing.entityId, name: pairing.entityName || pairing.entityType || `Device ${pairing.entityId}`, enabled: true, onlyWhenActive: true });
    }
  });
  if (outcome === 'unknown-user') {
    console.warn(`Ignoring Rust+ pairing for Steam ${pairing.playerId}: user has not signed in to the bridge.`);
    return;
  }
  await rustPlus.sync();
  const state = await storage.read();
  const recipients = state.subscribers.filter((item) => item.enabled);
  const text = pairing.entityId
    ? `Rust+ device ${escapeHtml(pairing.entityName || pairing.entityId)} підключено автоматично.`
    : outcome === 'server-already-linked'
      ? 'Цей сервер вже синхронізований для всіх гравців.'
      : `Rust+ сервер ${escapeHtml(pairing.name)} підключено автоматично.`;
  await Promise.all(recipients.map((item) => telegram.sendMessage(item.chatId, text).catch(() => {})));
}

async function verifySteamOpenId(url) {
  const params = new URLSearchParams(url.searchParams);
  params.set('openid.mode', 'check_authentication');
  const response = await fetch('https://steamcommunity.com/openid/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  return response.ok && (await response.text()).includes('is_valid:true');
}

async function handleTelegramUpdate(update) {
  const message = update.message;
  const chat = message?.chat;
  if (!chat?.id) return;

  const chatId = String(chat.id);
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || chat.title || chatId;

  if (message.text?.startsWith('/stop')) {
    await storage.update((state) => {
      const subscriber = state.subscribers.find((item) => item.chatId === chatId);
      if (subscriber) subscriber.enabled = false;
    });
    await telegram.sendMessage(chatId, 'Сповіщення Rust+ вимкнено для цього чату.');
    return;
  }

  if (message.text?.startsWith('/start')) {
    const code = message.text.trim().split(/\s+/, 2)[1];
    let bound = false;
    await storage.update((state) => {
      const user = (state.users || []).find((item) => item.telegramLinkCode === code && Date.parse(item.telegramLinkExpiresAt) > Date.now());
      const existing = state.subscribers.find((item) => item.chatId === chatId);
      if (user) bound = true;
      if (existing) {
        existing.enabled = true;
        existing.name = name;
        if (user) existing.steamId = user.steamId;
        existing.lastSeenAt = new Date().toISOString();
      } else {
        state.subscribers.push({ chatId, name, steamId: user?.steamId ?? null, enabled: true, createdAt: new Date().toISOString() });
      }
      if (user) {
        delete user.telegramLinkCode;
        delete user.telegramLinkExpiresAt;
      }
    });
    await telegram.sendMessage(chatId, bound ? 'Готово. Telegram прив’язано до Steam, а чат підписано на Rust+ сповіщення.' : 'Готово. Цей чат підписано на Rust+ сповіщення.');
    return;
  }

  await telegram.sendMessage(chatId, 'Напиши /start, щоб підписатися, або /stop, щоб вимкнути сповіщення.');
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    ...headers
  });
  res.end(payload);
}

async function parseJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sanitizeServer(input) {
  return {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || 'Rust server'),
    ip: String(input.ip || ''),
    port: Number(input.port || 28082),
    playerId: String(input.playerId || ''),
    playerToken: String(input.playerToken || ''),
    enabled: Boolean(input.enabled),
    entities: (input.entities || []).map((entity) => ({
      id: String(entity.id || ''),
      name: String(entity.name || ''),
      enabled: Boolean(entity.enabled),
      onlyWhenActive: entity.onlyWhenActive !== false
    })).filter((entity) => entity.id)
  };
}

async function routeApi(req, res, url) {
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;

  if (url.pathname === '/health') return send(res, 200, { ok: true, telegramMode, pollingRunning, rustPlus: rustPlus.statuses(), pairing: pairingListener.getStatus() });

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const steamId = currentSteamId(req);
    if (!steamId) return send(res, 401, { error: 'Steam sign-in is required.' });
    const state = await storage.read();
    const servers = state.servers.filter((server) => (server.steamIds || []).includes(steamId)).map(({ playerId, playerToken, ...server }) => server);
    return send(res, 200, { user: (state.users || []).find((user) => user.steamId === steamId) || null, servers, subscribers: state.subscribers.filter((item) => item.steamId === steamId).map(({ chatId, name, enabled }) => ({ chatId, name, enabled })), events: state.events.filter((event) => servers.some((server) => server.id === event.serverId)), telegramMode, pollingRunning, rustPlus: rustPlus.statuses(), pairing: pairingListener.getStatus() });
  }

/* --- STEAM AUTH MODULE --- */

if (url.pathname === '/api/auth/steam' && req.method === 'GET') {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${publicUrl}/api/auth/steam/callback`,
    'openid.realm': publicUrl,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  });

  const redirectUrl =
    `https://steamcommunity.com/openid/login?${params.toString()}`;

  console.log('Steam OpenID redirect:', redirectUrl);

  res.writeHead(302, {
    Location: redirectUrl
  });

  return res.end();
}

if (url.pathname === '/api/auth/steam/callback' && req.method === 'GET') {
  const claimedId = url.searchParams.get('openid.claimed_id');

  if (claimedId) {
    if (!await verifySteamOpenId(url)) {
      return send(res, 400, { error: 'Steam authentication could not be verified.' });
    }
    const steamId = claimedId.split('/').pop();

    let displayName = `Player ${steamId}`;
    let avatar = '';

    if (process.env.STEAM_API_KEY) {
      try {
        const steamParams = new URLSearchParams({
          key: process.env.STEAM_API_KEY,
          steamids: steamId
        });

        const steamRes = await fetch(
          `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?${steamParams.toString()}`
        );

        const data = await steamRes.json();
        const player = data?.response?.players?.[0];

        if (player) {
          displayName = player.personaname;
          avatar = player.avatarfull;
        }
      } catch (e) {
        console.error(
          'Failed to fetch Steam profile:',
          e.message
        );
      }
    }

    await storage.update((state) => {
      if (!state.users) {
        state.users = [];
      }

      const index = state.users.findIndex(
        (u) => u.steamId === steamId
      );

      if (index >= 0) {
        state.users[index].displayName = displayName;
        state.users[index].avatar = avatar;
        state.users[index].updatedAt =
          new Date().toISOString();
      } else {
        state.users.push({
          steamId,
          displayName,
          avatar,
          createdAt: new Date().toISOString()
        });
      }
    });

    res.writeHead(302, {
      'Set-Cookie':
        `steamId=${steamId}; Path=/; HttpOnly; SameSite=Lax`,
      Location: '/'
    });

    return res.end();
  }

  return send(res, 400, {
    error: 'Steam authentication failed'
  });
}

if (url.pathname === '/api/auth/me' && req.method === 'GET') {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/steamId=([^;]+)/);
  const steamId = match ? match[1] : null;

  if (!steamId) {
    return send(res, 200, {
      authenticated: false
    });
  }

  const state = await storage.read();

  const user = (state.users || []).find(
    (u) => u.steamId === steamId
  );

  return send(res, 200, {
    authenticated: Boolean(user),
    user: user || null
  });
}

if (url.pathname === '/api/telegram-link' && req.method === 'POST') {
  const steamId = currentSteamId(req);
  if (!steamId) return send(res, 401, { error: 'Steam sign-in is required.' });
  const code = crypto.randomBytes(18).toString('base64url');
  await storage.update((state) => {
    const user = state.users.find((item) => item.steamId === steamId);
    if (!user) throw new Error('Steam user not found.');
    user.telegramLinkCode = code;
    user.telegramLinkExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  });
  const me = await telegram.call('getMe', {});
  return send(res, 200, { url: `https://t.me/${me.username}?start=${code}`, expiresInSeconds: 900 });
}

/* --- END STEAM AUTH MODULE --- */

  /* --- PAIRINGS MANAGEMENT --- */
  if (url.pathname === '/api/pairings/confirm' && req.method === 'POST') {
    const payload = await parseJson(req);
    await storage.update((state) => {
      const pendingIndex = (state.pendingPairings || []).findIndex((p) => p.id === payload.pairingId);
      if (pendingIndex === -1) return;

      const pairing = state.pendingPairings[pendingIndex];

      let server = state.servers.find((s) => s.ip === pairing.ip || s.id === pairing.serverId);
      if (!server) {
        server = {
          id: pairing.serverId || crypto.randomUUID(),
          name: pairing.serverName || 'Rust Server',
          ip: pairing.ip || '',
          port: pairing.port || 28082,
          playerId: pairing.createdBySteamId || '',
          playerToken: pairing.playerToken || '',
          enabled: true,
          entities: []
        };
        state.servers.push(server);
      }

      if (!server.entities.some((e) => String(e.id) === String(pairing.entityId))) {
        server.entities.push({
          id: String(pairing.entityId),
          name: pairing.entityName || `Device ${pairing.entityId}`,
          enabled: true,
          onlyWhenActive: true
        });
      }

      state.pendingPairings.splice(pendingIndex, 1);
    });

    await rustPlus.sync();
    return send(res, 200, { ok: true });
  }

  if (url.pathname.startsWith('/api/pairings/delete/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    await storage.update((state) => {
      state.pendingPairings = (state.pendingPairings || []).filter((p) => p.id !== id);
    });
    return send(res, 200, { ok: true });
  }
  /* --- END PAIRINGS MANAGEMENT --- */

  if (url.pathname === '/api/servers' && req.method === 'POST') {
    const payload = await parseJson(req);
    await storage.update((state) => {
      const server = sanitizeServer(payload);
      const index = state.servers.findIndex((item) => item.id === server.id);
      if (index >= 0) state.servers[index] = server;
      else state.servers.push(server);
    });
    await rustPlus.sync();
    return send(res, 200, { ok: true });
  }

  if (url.pathname.startsWith('/api/servers/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    await storage.update((state) => {
      state.servers = state.servers.filter((server) => server.id !== id);
    });
    await rustPlus.sync();
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/subscribers' && req.method === 'PATCH') {
    const payload = await parseJson(req);
    await storage.update((state) => {
      const subscriber = state.subscribers.find((item) => item.chatId === String(payload.chatId));
      if (subscriber) subscriber.enabled = Boolean(payload.enabled);
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/telegram/webhook' && req.method === 'POST') {
    const publicUrlEnv = process.env.PUBLIC_URL?.replace(/\/$/, '');
    if (!publicUrlEnv) {
      return send(res, 400, {
        error: 'PUBLIC_URL is required. Add PUBLIC_URL to .env, restart the server, then try again.'
      });
    }
    if (publicUrlEnv.includes('localhost') || publicUrlEnv.includes('127.0.0.1')) {
      return send(res, 400, {
        error: 'Telegram cannot call localhost. Use a public tunnel URL or deploy the app, set PUBLIC_URL to that https URL, restart, then press Set webhook.'
      });
    }
    await telegram.setWebhook(`${publicUrlEnv}/telegram/webhook`);
    await storage.update((state) => {
      state.settings.telegramWebhookConfiguredAt = new Date().toISOString();
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/telegram/webhook-info' && req.method === 'GET') {
    return send(res, 200, { ok: true, webhook: await telegram.getWebhookInfo() });
  }

  if (url.pathname === '/api/telegram/delete-webhook' && req.method === 'POST') {
    await telegram.deleteWebhook();
    return send(res, 200, { ok: true });
  }

  return false;
}

async function routeTelegram(req, res) {
  const update = await parseJson(req);
  await handleTelegramUpdate(update);
  return send(res, 200, { ok: true });
}

async function startTelegramPolling() {
  if (!telegram.enabled() || telegramMode !== 'polling') return;
  pollingRunning = true;
  await telegram.deleteWebhook().catch((error) => console.warn('Telegram deleteWebhook failed:', error.message));
  console.log('Telegram polling started. Send /start to the bot.');

  while (pollingRunning) {
    try {
      const updates = await telegram.getUpdates({ offset: pollingOffset, timeout: 25 });
      for (const update of updates) {
        pollingOffset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (error) {
      console.error('Telegram polling failed:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function startTelegramWebhook() {
  if (!telegram.enabled() || telegramMode !== 'webhook') return;
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, '');
  if (!publicUrl || publicUrl.includes('localhost')) {
    console.warn('Telegram webhook skipped: PUBLIC_URL must be a public HTTPS URL.');
    return;
  }
  await telegram.setWebhook(`${publicUrl}/telegram/webhook`);
  console.log('Telegram webhook configured.');
}

async function serveStatic(req, res, url) {
  const fileName = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = path.resolve(publicDir, fileName);
  if (!filePath.startsWith(publicDir)) return send(res, 403, 'Forbidden');
  try {
    const body = await fs.readFile(filePath);
    const type = filePath.endsWith('.css') ? 'text/css; charset=utf-8' : filePath.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    send(res, 200, body, { 'Content-Type': type });
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/telegram/webhook' && req.method === 'POST') return await routeTelegram(req, res);
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      const handled = await routeApi(req, res, url);
      if (handled === false) return send(res, 404, { error: 'Not found' });
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    send(res, 500, { error: error.message });
  }
});

server.listen(port, '0.0.0.0', async () => {
  console.log(`Rust Telegram Bridge listening on :${port}`);
  rustPlus.sync().catch((error) => console.error('Rust+ sync failed:', error));
  pairingListener.start().catch((error) => console.error('Rust+ pairing listener crashed:', error));
  startTelegramPolling().catch((error) => console.error('Telegram polling crashed:', error));
  startTelegramWebhook().catch((error) => console.error('Telegram webhook setup failed:', error));
});

process.on('SIGTERM', () => {
  clearInterval(fcmMemoryGuard);
  pairingListener.stop();
  server.close(() => process.exit(0));
});
