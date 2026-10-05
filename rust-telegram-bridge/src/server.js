import http from 'node:http';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createStorageFromEnv } from './storage.js';
import { Telegram, escapeHtml } from './telegram.js';
import { RustPlusManager } from './rustplus-listener.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

function loadDotEnv(filePath = path.resolve(process.cwd(), '.env')) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      !trimmed.includes('=')
    ) {
      continue;
    }

    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const port = Number(process.env.PORT || 3000);
const telegramMode = process.env.TELEGRAM_MODE || 'polling';
let pollingOffset =
  Number(process.env.TELEGRAM_POLLING_OFFSET || 0) || undefined;
let pollingRunning = false;

const storage = createStorageFromEnv();

const telegram = new Telegram(
  process.env.TELEGRAM_BOT_TOKEN
);

const rustPlus = new RustPlusManager({
  storage,
  telegram,
  cooldownSeconds:
    process.env.ALERT_COOLDOWN_SECONDS || 60
});

async function handleTelegramUpdate(update) {
  // ==========================================
  // CALLBACK QUERY
  // ==========================================

  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';

    if (data.startsWith('sw_')) {
      const isTurnOn = data.startsWith('sw_on_');
      const entityId = data.replace(/^sw_(on|off)_/, '');

      try {
        await rustPlus.setSmartSwitchState(
          entityId,
          isTurnOn
        );

        await telegram.answerCallbackQuery(
          cb.id,
          `Пристрій ${
            isTurnOn ? 'увімкнено 🟢' : 'вимкнено 🔴'
          }!`
        );
      } catch (err) {
        await telegram.answerCallbackQuery(
          cb.id,
          `Помилка: ${err.message}`,
          true
        );
      }
    }

    return;
  }

  // ==========================================
  // TEXT COMMANDS
  // ==========================================

  const message = update.message;
  const chat = message?.chat;

  if (!chat?.id) return;

  const chatId = String(chat.id);
  const text = message.text || '';

  const name =
    [chat.first_name, chat.last_name]
      .filter(Boolean)
      .join(' ') ||
    chat.username ||
    chat.title ||
    chatId;

  // ==========================================
  // MAIN MENU
  // ==========================================

  const mainMenuKeyboard = {
    keyboard: [
      [
        { text: '🔌 Перемикачі' },
        { text: '📹 Камери' }
      ]
    ],
    resize_keyboard: true
  };

  // ==========================================
  // STOP
  // ==========================================

  if (text.startsWith('/stop')) {
    await storage.update((state) => {
      const subscriber = state.subscribers.find(
        (item) => item.chatId === chatId
      );

      if (subscriber) {
        subscriber.enabled = false;
      }
    });

    await telegram.sendMessage(
      chatId,
      'Сповіщення Rust+ вимкнено для цього чату.'
    );

    return;
  }

  // ==========================================
  // START
  // ==========================================

  if (text.startsWith('/start')) {
    await storage.update((state) => {
      const existing = state.subscribers.find(
        (item) => item.chatId === chatId
      );

      if (existing) {
        existing.enabled = true;
        existing.name = name;
        existing.lastSeenAt = new Date().toISOString();
      } else {
        state.subscribers.push({
          chatId,
          name,
          enabled: true,
          createdAt: new Date().toISOString()
        });
      }
    });

    await telegram.sendMessage(
      chatId,
      'Готово. Цей чат отримуватиме Rust+ сповіщення від bridge.\n\nКористуйся меню нижче для керування системою:',
      {
        reply_markup: JSON.stringify(
          mainMenuKeyboard
        )
      }
    );

    return;
  }

  // ==========================================
  // SWITCHES
  // ==========================================

  if (
    text.startsWith('/switches') ||
    text.includes('Перемикачі')
  ) {
    const state = await storage.read();

    const allEntities = state.servers.flatMap(
      (s) => s.entities || []
    );

    if (!allEntities.length) {
      await telegram.sendMessage(
        chatId,
        'Не знайдено жодного збереженого пристрою у системі. Спочатку додайте його на сайті.'
      );

      return;
    }

    for (const entity of allEntities) {
      await rustPlus.sendSwitchControlMenu(
        chatId,
        entity.id,
        entity.name
      );
    }

    return;
  }

  // ==========================================
  // ADD CAMERA
  // ==========================================

  if (text.startsWith('/addcam ')) {
    const parts = text.split(' ');

    const camId = parts[1];
    const camName =
      parts.slice(2).join(' ') || camId;

    if (!camId) {
      return await telegram.sendMessage(
        chatId,
        '⚠ Вкажіть ID камери.\nПриклад: `/addcam OILRIG1HELI Нафтовидобувна вежа`'
      );
    }

    await storage.update((state) => {
      const server = state.servers.find(
        (s) => s.enabled
      );

      if (!server) return;

      if (!server.cameras) {
        server.cameras = [];
      }

      const existing = server.cameras.find(
        (c) => c.id === camId
      );

      if (existing) {
        existing.name = camName;
      } else {
        server.cameras.push({
          id: camId,
          name: camName
        });
      }
    });

    return await telegram.sendMessage(
      chatId,
      `✅ Камеру <b>${escapeHtml(
        camName
      )}</b> додано.`
    );
  }

  // ==========================================
  // LIST CAMERAS
  // ==========================================

  if (
    text.startsWith('/cameras') ||
    text === '📹 Камери'
  ) {
    const state = await storage.read();

    const server = state.servers.find(
      (s) => s.enabled
    );

    if (!server) {
      return await telegram.sendMessage(
        chatId,
        'Немає активних серверів. Додайте сервер на сайті.'
      );
    }

    const cameras = server.cameras || [];

    if (cameras.length === 0) {
      return await telegram.sendMessage(
        chatId,
        'У вас ще немає збережених камер.\n\n' +
        'Додайте камеру командою:\n' +
        '/addcam ID Назва\n\n' +
        'Наприклад:\n' +
        '/addcam OILRIG1HELI Нафтовидобувна вежа'
      );
    }

    const publicUrl =
      process.env.PUBLIC_URL?.replace(/\/$/, '');

    if (!publicUrl) {
      return await telegram.sendMessage(
        chatId,
        '❌ Помилка: PUBLIC_URL не налаштовано.'
      );
    }

    const inline_keyboard = cameras.map(
      (cam) => [
        {
          text: `📹 ${cam.name}`,
          web_app: {
            url:
              `${publicUrl}/camera.html` +
              `?serverId=${encodeURIComponent(
                server.id
              )}` +
              `&camera=${encodeURIComponent(
                cam.id
              )}`
          }
        }
      ]
    );

    return await telegram.sendMessage(
      chatId,
      '📹 <b>Оберіть камеру для перегляду LIVE:</b>',
      {
        reply_markup: JSON.stringify({
          inline_keyboard
        })
      }
    );
  }

  // ==========================================
  // DELETE CAMERA
  // ==========================================

  if (text.startsWith('/delcam ')) {
    const camId = text.split(' ')[1];

    if (!camId) {
      return await telegram.sendMessage(
        chatId,
        '⚠ Вкажіть ID камери. Наприклад: `/delcam Roof`'
      );
    }

    await storage.update((state) => {
      const server = state.servers.find(
        (s) => s.enabled
      );

      if (server && server.cameras) {
        server.cameras =
          server.cameras.filter(
            (c) => c.id !== camId
          );
      }
    });

    return await telegram.sendMessage(
      chatId,
      `🗑 Камеру <b>${escapeHtml(
        camId
      )}</b> видалено зі списку.`
    );
  }

  // ==========================================
  // UNKNOWN COMMAND
  // ==========================================

  await telegram.sendMessage(
    chatId,
    'Доступні команди:\n' +
      '/start — Меню\n' +
      '🔌 Перемикачі — Керування девайсами\n' +
      '📹 Камери — Перегляд CCTV\n' +
      '/addcam [ID] [Назва] — Додати камеру'
  );
}

// ==========================================
// HTTP HELPERS
// ==========================================

function send(
  res,
  status,
  body,
  headers = {}
) {
  const isJson =
    typeof body !== 'string' &&
    !Buffer.isBuffer(body);

  const payload = isJson
    ? JSON.stringify(body)
    : body;

  res.writeHead(status, {
    'Content-Type': isJson
      ? 'application/json; charset=utf-8'
      : 'text/html; charset=utf-8',
    ...headers
  });

  res.end(payload);
}

async function parseJson(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(
    Buffer.concat(chunks).toString('utf8')
  );
}

// ==========================================
// SERVER SANITIZATION
// ==========================================

function sanitizeServer(input) {
  return {
    id: input.id || crypto.randomUUID(),

    name: String(
      input.name || 'Rust server'
    ),

    ip: String(input.ip || ''),

    port: Number(
      input.port || 28082
    ),

    playerId: String(
      input.playerId || ''
    ),

    playerToken: String(
      input.playerToken || ''
    ),

    enabled: Boolean(
      input.enabled
    ),

    entities: (
      input.entities || []
    )
      .map((entity) => ({
        id: String(
          entity.id || ''
        ),

        name: String(
          entity.name || ''
        ),

        enabled: Boolean(
          entity.enabled
        ),

        onlyWhenActive:
          entity.onlyWhenActive !== false
      }))
      .filter(
        (entity) => entity.id
      ),

    cameras:
      input.cameras || []
  };
}

// ==========================================
// API ROUTES
// ==========================================

async function routeApi(
  req,
  res,
  url
) {
  // HEALTH

  if (
    url.pathname === '/health'
  ) {
    return send(
      res,
      200,
      {
        ok: true,
        telegramMode,
        pollingRunning,
        rustPlus:
          rustPlus.statuses()
      }
    );
  }

  // STATE

  if (
    url.pathname === '/api/state' &&
    req.method === 'GET'
  ) {
    const state =
      await storage.read();

    return send(
      res,
      200,
      {
        ...state,
        telegramMode,
        pollingRunning,
        rustPlus:
          rustPlus.statuses()
      }
    );
  }

  // ADD / UPDATE SERVER

  if (
    url.pathname === '/api/servers' &&
    req.method === 'POST'
  ) {
    const payload =
      await parseJson(req);

    await storage.update(
      (state) => {
        const server =
          sanitizeServer(
            payload
          );

        const index =
          state.servers.findIndex(
            (item) =>
              item.id === server.id
          );

        if (index >= 0) {
          server.cameras =
            state.servers[index]
              .cameras || [];

          state.servers[index] =
            server;
        } else {
          state.servers.push(
            server
          );
        }
      }
    );

    await rustPlus.sync();

    return send(
      res,
      200,
      { ok: true }
    );
  }

  // DELETE SERVER

  if (
    url.pathname.startsWith(
      '/api/servers/'
    ) &&
    req.method === 'DELETE'
  ) {
    const id =
      decodeURIComponent(
        url.pathname
          .split('/')
          .pop()
      );

    await storage.update(
      (state) => {
        state.servers =
          state.servers.filter(
            (server) =>
              server.id !== id
          );
      }
    );

    await rustPlus.sync();

    return send(
      res,
      200,
      { ok: true }
    );
  }

  // UPDATE SUBSCRIBER

  if (
    url.pathname ===
      '/api/subscribers' &&
    req.method === 'PATCH'
  ) {
    const payload =
      await parseJson(req);

    await storage.update(
      (state) => {
        const subscriber =
          state.subscribers.find(
            (item) =>
              item.chatId ===
              String(
                payload.chatId
              )
          );

        if (subscriber) {
          subscriber.enabled =
            Boolean(
              payload.enabled
            );
        }
      }
    );

    return send(
      res,
      200,
      { ok: true }
    );
  }

  // SET TELEGRAM WEBHOOK

  if (
    url.pathname ===
      '/api/telegram/webhook' &&
    req.method === 'POST'
  ) {
    const publicUrl =
      process.env.PUBLIC_URL?.replace(
        /\/$/,
        ''
      );

    if (!publicUrl) {
      return send(
        res,
        400,
        {
          error:
            'PUBLIC_URL is required. Add PUBLIC_URL to .env, restart the server, then try again.'
        }
      );
    }

    if (
      publicUrl.includes(
        'localhost'
      ) ||
      publicUrl.includes(
        '127.0.0.1'
      )
    ) {
      return send(
        res,
        400,
        {
          error:
            'Telegram cannot call localhost. Use a public tunnel URL or deploy the app, set PUBLIC_URL to that https URL, restart, then press Set webhook.'
        }
      );
    }

    await telegram.setWebhook(
      `${publicUrl}/telegram/webhook`
    );

    await storage.update(
      (state) => {
        state.settings.telegramWebhookConfiguredAt =
          new Date().toISOString();
      }
    );

    return send(
      res,
      200,
      { ok: true }
    );
  }

  // WEBHOOK INFO

  if (
    url.pathname ===
      '/api/telegram/webhook-info' &&
    req.method === 'GET'
  ) {
    return send(
      res,
      200,
      {
        ok: true,
        webhook:
          await telegram.getWebhookInfo()
      }
    );
  }

  // DELETE WEBHOOK

  if (
    url.pathname ===
      '/api/telegram/delete-webhook' &&
    req.method === 'POST'
  ) {
    await telegram.deleteWebhook();

    return send(
      res,
      200,
      { ok: true }
    );
  }

  return false;
}

// ==========================================
// TELEGRAM WEBHOOK
// ==========================================

async function routeTelegram(
  req,
  res
) {
  const update =
    await parseJson(req);

  await handleTelegramUpdate(
    update
  );

  return send(
    res,
    200,
    { ok: true }
  );
}

// ==========================================
// TELEGRAM POLLING
// ==========================================

async function startTelegramPolling() {
  if (
    !telegram.enabled() ||
    telegramMode !== 'polling'
  ) {
    return;
  }

  pollingRunning = true;

  await telegram
    .deleteWebhook()
    .catch((error) =>
      console.warn(
        'Telegram deleteWebhook failed:',
        error.message
      )
    );

  console.log(
    'Telegram polling started. Send /start to the bot.'
  );

  while (pollingRunning) {
    try {
      const updates =
        await telegram.getUpdates({
          offset: pollingOffset,
          timeout: 25
        });

      for (const update of updates) {
        pollingOffset =
          update.update_id + 1;

        await handleTelegramUpdate(
          update
        );
      }
    } catch (error) {
      console.error(
        'Telegram polling failed:',
        error.message
      );

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 5000)
      );
    }
  }
}

// ==========================================
// STATIC FILES
// ==========================================

async function serveStatic(
  req,
  res,
  url
) {
  const fileName =
    url.pathname === '/'
      ? 'index.html'
      : url.pathname.slice(1);

  const filePath =
    path.resolve(
      publicDir,
      fileName
    );

  if (
    !filePath.startsWith(
      publicDir
    )
  ) {
    return send(
      res,
      403,
      'Forbidden'
    );
  }

  try {
    const body =
      await fs.readFile(
        filePath
      );

    const type =
      filePath.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : filePath.endsWith('.js')
          ? 'application/javascript; charset=utf-8'
          : 'text/html; charset=utf-8';

    send(
      res,
      200,
      body,
      {
        'Content-Type': type
      }
    );
  } catch {
    send(
      res,
      404,
      'Not found'
    );
  }
}

// ==========================================
// HTTP SERVER
// ==========================================

const server =
  http.createServer(
    async (req, res) => {
      try {
        const url = new URL(
          req.url,
          `http://${req.headers.host}`
        );

        if (
          url.pathname ===
            '/telegram/webhook' &&
          req.method === 'POST'
        ) {
          return await routeTelegram(
            req,
            res
          );
        }

        if (
          url.pathname.startsWith(
            '/api/'
          ) ||
          url.pathname === '/health'
        ) {
          const handled =
            await routeApi(
              req,
              res,
              url
            );

          if (handled === false) {
            return send(
              res,
              404,
              {
                error:
                  'Not found'
              }
            );
          }

          return;
        }

        await serveStatic(
          req,
          res,
          url
        );
      } catch (error) {
        console.error(error);

        send(
          res,
          500,
          {
            error:
              error.message
          }
        );
      }
    }
  );

// ==========================================
// WEBSOCKET SERVER
// ДЛЯ СТРІМІНГУ КАМЕР
// ==========================================

const wss =
  new WebSocketServer({
    server
  });

wss.on(
  'connection',
  (ws, req) => {
    const query =
      req.url.split('?')[1] || '';

    const urlParams =
      new URLSearchParams(
        query
      );

    const cameraName =
      urlParams.get('camera');

    const serverId =
      urlParams.get('serverId');

    if (
      !cameraName ||
      !serverId
    ) {
      ws.close(
        1008,
        'Missing parameters'
      );

      return;
    }

    const record =
      rustPlus.clients.get(
        serverId
      );

    if (
      !record ||
      record.status !==
        'connected'
    ) {
      ws.close(
        1011,
        'Rust+ server not connected'
      );

      return;
    }

    const rustClient =
      record.client;

    rustClient.subscribeToCamera(
      cameraName,
      (err) => {
        if (
          err &&
          ws.readyState === ws.OPEN
        ) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message:
                err.message
            })
          );
        }
      }
    );

    const onCameraFrame =
      (frame) => {
        if (
          ws.readyState ===
          ws.OPEN
        ) {
          ws.send(
            JSON.stringify({
              type: 'frame',
              data: frame
            })
          );
        }
      };

    rustClient.on(
      'cameraFrame',
      onCameraFrame
    );

    ws.on(
      'message',
      (message) => {
        try {
          const data =
            JSON.parse(message);

          if (
            data.type ===
              'input' &&
            rustClient.sendCameraInput
          ) {
            rustClient.sendCameraInput(
              data.buttons,
              data.x,
              data.y
            );
          }
        } catch (e) {}
      }
    );

    ws.on(
      'close',
      () => {
        rustClient.removeListener(
          'cameraFrame',
          onCameraFrame
        );

        rustClient.unsubscribeFromCamera?.();
      }
    );
  }
);

// ==========================================
// START SERVER
// ==========================================

server.listen(
  port,
  () => {
    console.log(
      `Rust Telegram Bridge listening on :${port}`
    );

    console.log(
      '[Rust+] Initializing listener and syncing with database...'
    );

    rustPlus
      .sync()
      .then(() =>
        console.log(
          '[Rust+] Initial sync complete.'
        )
      )
      .catch((error) =>
        console.error(
          '[Rust+] Sync failed on startup:',
          error
        )
      );

    startTelegramPolling().catch(
      (error) =>
        console.error(
          'Telegram polling crashed:',
          error
        )
    );
  }
);

process.on(
  'SIGTERM',
  () => {
    server.close(() =>
      process.exit(0)
    );
  }
);