import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';

import { escapeHtml } from './telegram.js';

const require = createRequire(import.meta.url);

// ВАЖЛИВО:
// Не завантажуємо push-receiver при імпорті цього файлу.
// Він буде завантажений тільки всередині start().
let PushReceiverClient = null;

const MAX_RAW_LOG_LENGTH = 4000;
const MAX_PENDING_NOTIFICATIONS = 50;
const MAX_PERSISTENT_IDS = 100;

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readConfig(filePath, encodedConfig) {
  if (encodedConfig) {
    try {
      return JSON.parse(
        Buffer.from(encodedConfig, 'base64').toString('utf8')
      );
    } catch {
      throw new Error(
        'RUSTPLUS_CONFIG_BASE64 is not valid Base64 JSON.'
      );
    }
  }

  return readJson(filePath);
}

function appDataToObject(appData) {
  if (!appData) {
    return {};
  }

  if (Array.isArray(appData)) {
    return Object.fromEntries(
      appData
        .filter((item) => item?.key)
        .map((item) => [item.key, item.value])
    );
  }

  if (typeof appData === 'object') {
    return appData;
  }

  return {};
}

function tryParseJson(value) {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractPairingSource(raw) {
  const candidates = [
    raw?.data,
    raw?.Data,
    raw?.notification?.data,
    raw?.notification?.Data,
    raw?.message?.data,
    raw?.message?.Data,
    raw?.appData
      ? appDataToObject(raw.appData)
      : null,
    raw
  ].filter(
    (item) => item && typeof item === 'object'
  );

  for (const candidate of candidates) {
    const nested =
      tryParseJson(candidate.body) ||
      tryParseJson(candidate.message) ||
      tryParseJson(candidate.data);

    if (nested && typeof nested === 'object') {
      candidates.unshift(nested);
    }
  }

  return candidates.find(
    (candidate) =>
      candidate.ip &&
      candidate.port &&
      candidate.playerId &&
      candidate.playerToken
  ) || null;
}

function safeRaw(raw) {
  let text;

  try {
    text = JSON.stringify(raw);
  } catch {
    text = String(raw);
  }

  if (text.length > MAX_RAW_LOG_LENGTH) {
    return `${text.slice(0, MAX_RAW_LOG_LENGTH)}...`;
  }

  return text;
}

function normalizePairing(raw) {
  const source = extractPairingSource(raw);

  if (!source || typeof source !== 'object') {
    return null;
  }

  const entityId =
    source.entityId ||
    source.entity_id;

  if (
    !source.ip ||
    !source.port ||
    !source.playerId ||
    !source.playerToken
  ) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',

    type: entityId
      ? 'entity'
      : 'server',

    ip: String(source.ip),

    port: Number(source.port),

    serverId: String(
      source.id ||
      source.serverId ||
      ''
    ),

    name: String(
      source.name ||
      source.title ||
      'Rust server'
    ),

    desc: String(
      source.desc ||
      ''
    ),

    playerId: String(
      source.playerId
    ),

    playerToken: String(
      source.playerToken
    ),

    entityId: entityId
      ? String(entityId)
      : '',

    entityName: String(
      source.entityName ||
      ''
    ),

    entityType: String(
      source.entityType ||
      source.type ||
      ''
    )
  };
}

function confirmationText(pairing) {
  const title =
    pairing.type === 'entity'
      ? 'Новий Rust+ device'
      : 'Новий Rust+ сервер';

  return [
    `🔗 <b>${title}</b>`,
    `<b>Server:</b> ${escapeHtml(pairing.name)}`,
    `<b>Address:</b> ${escapeHtml(pairing.ip)}:${escapeHtml(pairing.port)}`,

    pairing.entityId
      ? `<b>Entity:</b> ${escapeHtml(
          pairing.entityName ||
          pairing.entityId
        )} ${escapeHtml(
          pairing.entityType ||
          ''
        )}`
      : null,

    '',

    'Підключити це до bridge?'
  ]
    .filter(Boolean)
    .join('\n');
}

function sameServer(server, pairing) {
  return (
    server.ip === pairing.ip &&
    String(server.port) === String(pairing.port)
  );
}

function syncedPairingMessage(pairing) {
  if (pairing.type === 'entity') {
    return 'Цей девайс вже синхронізований для всіх гравців.';
  }

  return 'Цей сервер вже синхронізований для всіх гравців.';
}

export class PairingListener {
  constructor({
    storage,
    telegram,
    rustPlus,
    onPairing,
    configFile = './rustplus.config.json',
    configBase64 = process.env.RUSTPLUS_CONFIG_BASE64
  }) {
    this.storage = storage;
    this.telegram = telegram;
    this.rustPlus = rustPlus;
    this.onPairing = onPairing;
    this.configBase64 = configBase64;

    this.configFile = path.resolve(
      configFile
    );

    this.client = null;

    this.status = 'idle';

    this.lastError = null;

    this.stopped = false;

    this.connecting = false;

    this.notificationQueue = [];
    this.processingNotifications = false;
    this.droppedNotifications = 0;
  }

  async start() {
    // Не дозволяємо створити декілька FCM-клієнтів.
    if (this.connecting || this.client) {
      console.warn(
        'Rust+ pairing listener is already running.'
      );

      return;
    }

    this.connecting = true;
    this.stopped = false;

    try {
      if (!this.telegram.enabled()) {
        this.status = 'telegram_disabled';
        return;
      }

      if (
        !this.configBase64 &&
        !existsSync(this.configFile)
      ) {
        this.status = 'missing_config';

        console.warn(
          `Rust+ pairing listener skipped: ${this.configFile} not found.`
        );

        return;
      }

      const config = readConfig(
        this.configFile,
        this.configBase64
      );

      const credentials =
        config?.fcm_credentials;

      if (
        !credentials?.gcm?.androidId ||
        !credentials?.gcm?.securityToken
      ) {
        this.status = 'missing_fcm_credentials';

        console.warn(
          'Rust+ pairing listener skipped: fcm_credentials missing in rustplus.config.json.'
        );

        return;
      }

      /*
       * ВАЖЛИВО:
       * push-receiver завантажується тут, а не на рівні
       * модуля. Тому проблема з FCM не повинна блокувати
       * імпорт server.js.
       */
      if (!PushReceiverClient) {
        PushReceiverClient = require(
          '@liamcottle/push-receiver/src/client'
        );
      }

      this.client = new PushReceiverClient(
        credentials.gcm.androidId,
        credentials.gcm.securityToken,
        []
      );

      this.client.on(
        'connect',
        () => {
          this.status = 'connected';
          this.lastError = null;

          console.log(
            'Rust+ FCM socket connected.'
          );
        }
      );

      this.client.on(
        'disconnect',
        () => {
          if (this.stopped) {
            this.status = 'stopped';
            return;
          }

          this.status = 'disconnected';

          console.warn(
            'Rust+ FCM socket disconnected, push-receiver will retry.'
          );
        }
      );

      this.client.on(
        'error',
        (error) => {
          this.status = 'error';

          this.lastError =
            error?.message ||
            String(error);

          console.error(
            'Rust+ FCM socket error:',
            this.lastError
          );
        }
      );

      this.client.on(
        'ON_DATA_RECEIVED',
        (data) => {
          this.trimPersistentIds();
          this.enqueueNotification(data);
        }
      );

      this.client.on(
        'ON_NOTIFICATION_RECEIVED',
        ({ notification, object }) => {
          this.trimPersistentIds();
          this.enqueueNotification(
            notification || object
          );
        }
      );

      this.status = 'connecting';

      /*
       * НЕ await-имо connect().
       *
       * FCM socket є довгоживучим з'єднанням.
       * HTTP-сервер не повинен чекати його завершення.
       *
       * Також ми не створюємо тут власний цикл
       * повторного connect(). Якщо push-receiver
       * має власний механізм reconnect — він працює
       * самостійно.
       */
      Promise.resolve()
        .then(() => {
          if (
            this.stopped ||
            !this.client
          ) {
            return null;
          }

          return this.client.connect();
        })
        .then(() => {
          if (!this.stopped) {
            console.log(
              'Rust+ pairing listener started. FCM connection is active.'
            );
          }
        })
        .catch((error) => {
          if (this.stopped) {
            return;
          }

          this.status = 'error';

          this.lastError =
            error?.message ||
            String(error);

          console.error(
            'Rust+ FCM connect error:',
            this.lastError
          );

          /*
           * НЕ викликаємо connect() повторно тут.
           * Інакше можемо створити власний нескінченний
           * цикл reconnect.
           */
        });

    } catch (error) {
      this.status = 'error';

      this.lastError =
        error?.message ||
        String(error);

      console.error(
        'Rust+ pairing listener startup failed:',
        this.lastError
      );
    } finally {
      this.connecting = false;
    }
  }

  stop() {
    this.stopped = true;

    try {
      this.client?.disconnect?.();
    } catch (error) {
      console.error(
        'Rust+ FCM disconnect error:',
        error?.message || error
      );
    }

    this.client = null;
    this.notificationQueue = [];
    this.status = 'stopped';
  }

  trimPersistentIds() {
    if (
      this.client?._persistentIds?.length >
      MAX_PERSISTENT_IDS
    ) {
      this.client._persistentIds.splice(
        0,
        this.client._persistentIds.length -
          MAX_PERSISTENT_IDS
      );
    }
  }

  enqueueNotification(raw) {
    if (
      this.notificationQueue.length >=
      MAX_PENDING_NOTIFICATIONS
    ) {
      this.droppedNotifications += 1;
      return;
    }

    this.notificationQueue.push(raw);

    if (!this.processingNotifications) {
      this.processNotificationQueue();
    }
  }

  async processNotificationQueue() {
    this.processingNotifications = true;

    try {
      while (
        !this.stopped &&
        this.notificationQueue.length
      ) {
        const raw =
          this.notificationQueue.shift();

        try {
          await this.handlePairing(raw);
        } catch (error) {
          console.error(
            'Pairing notification failed:',
            error?.message || error
          );
        }
      }
    } finally {
      this.processingNotifications = false;
    }
  }

  async handlePairing(raw) {
    const pairing =
      normalizePairing(raw);

    /*
     * Звичайні Rust+ повідомлення bridge не цікавлять.
     * Обробляємо тільки повідомлення, які містять
     * необхідні дані pairing.
     */
    if (!pairing) {
      return;
    }

    /*
     * Якщо server.js передав onPairing —
     * використовуємо автоматичну обробку.
     */
    if (this.onPairing) {
      await this.onPairing(
        pairing,
        raw
      );

      return;
    }

    /*
     * Старий fallback:
     * зберігаємо pairing і відправляємо
     * Telegram confirmation.
     */
    await this.storage.update(
      (draft) => {
        if (
          !Array.isArray(
            draft.pairingLogs
          )
        ) {
          draft.pairingLogs = [];
        }

        draft.pairingLogs.unshift({
          id: crypto.randomUUID(),

          createdAt:
            new Date().toISOString(),

          parsed:
            Boolean(pairing),

          type:
            pairing?.type ||
            null,

          server:
            pairing
              ? `${pairing.ip}:${pairing.port}`
              : null,

          entityId:
            pairing?.entityId ||
            null,

          raw:
            safeRaw(raw)
        });

        draft.pairingLogs =
          draft.pairingLogs.slice(
            0,
            25
          );
      }
    );

    const state =
      await this.storage.read();

    const syncedServer =
      state.servers.find(
        (server) =>
          sameServer(
            server,
            pairing
          )
      );

    const syncedEntity =
      pairing.entityId &&
      syncedServer?.entities?.some(
        (entity) =>
          String(entity.id) ===
          String(pairing.entityId)
      );

    if (
      (
        pairing.type === 'server' &&
        syncedServer
      ) ||
      syncedEntity
    ) {
      await this.notifySubscribers(
        state,
        syncedPairingMessage(pairing)
      );

      return;
    }

    const duplicate =
      state.pendingPairings.find(
        (item) =>
          item.status === 'pending' &&
          item.ip === pairing.ip &&
          String(item.port) ===
            String(pairing.port) &&
          item.playerId ===
            pairing.playerId &&
          String(
            item.entityId || ''
          ) ===
            String(
              pairing.entityId || ''
            )
      );

    if (duplicate) {
      return;
    }

    await this.storage.update(
      (draft) => {
        if (
          !Array.isArray(
            draft.pendingPairings
          )
        ) {
          draft.pendingPairings = [];
        }

        draft.pendingPairings.unshift(
          pairing
        );

        draft.pendingPairings =
          draft.pendingPairings.slice(
            0,
            50
          );
      }
    );

    const subscribers =
      state.subscribers.filter(
        (item) => item.enabled
      );

    if (!subscribers.length) {
      console.warn(
        'Pairing notification received, but there are no Telegram subscribers yet.'
      );

      return;
    }

    for (const subscriber of subscribers) {
      await this.telegram
        .sendMessage(
          subscriber.chatId,
          confirmationText(pairing),
          {
            reply_markup: {
              inline_keyboard: [[
                {
                  text: 'Підключити',
                  callback_data:
                    `pair:accept:${pairing.id}`
                },
                {
                  text: 'Ігнорувати',
                  callback_data:
                    `pair:reject:${pairing.id}`
                }
              ]]
            }
          }
        )
        .catch((error) => {
          console.error(
            'Pairing confirmation send failed:',
            error?.message || error
          );
        });
    }
  }

  async notifySubscribers(
    state,
    text
  ) {
    const subscribers =
      state.subscribers.filter(
        (item) => item.enabled
      );

    for (const subscriber of subscribers) {
      await this.telegram
        .sendMessage(
          subscriber.chatId,
          text
        )
        .catch((error) => {
          console.error(
            'Telegram notify failed:',
            error?.message || error
          );
        });
    }
  }

  async confirm(
    pairingId,
    accepted
  ) {
    let pairing;

    await this.storage.update(
      (draft) => {
        pairing =
          draft.pendingPairings.find(
            (item) =>
              item.id === pairingId
          );

        if (pairing) {
          pairing.status =
            accepted
              ? 'accepted'
              : 'rejected';
        }
      }
    );

    if (
      !pairing ||
      !accepted
    ) {
      return pairing;
    }

    await this.storage.update(
      (draft) => {
        let server =
          draft.servers.find(
            (item) =>
              sameServer(
                item,
                pairing
              )
          );

        if (!server) {
          server = {
            id:
              pairing.serverId ||
              crypto.randomUUID(),

            name:
              pairing.name ||
              'Rust server',

            ip:
              pairing.ip,

            port:
              pairing.port,

            playerId:
              pairing.playerId,

            playerToken:
              pairing.playerToken,

            enabled:
              true,

            entities:
              []
          };

          draft.servers.push(
            server
          );
        } else {
          server.playerToken =
            pairing.playerToken;

          server.enabled =
            true;
        }

        if (
          pairing.entityId &&
          !server.entities.some(
            (entity) =>
              String(entity.id) ===
              String(pairing.entityId)
          )
        ) {
          server.entities.push({
            id:
              pairing.entityId,

            name:
              pairing.entityName ||
              pairing.entityType ||
              `Entity ${pairing.entityId}`,

            enabled:
              true,

            onlyWhenActive:
              true
          });
        }
      }
    );

    await this.rustPlus.sync();

    return pairing;
  }

  getStatus() {
    return {
      status:
        this.status,

      lastError:
        this.lastError,

      configFile:
        this.configBase64
          ? 'RUSTPLUS_CONFIG_BASE64'
          : this.configFile,

      hasClient:
        Boolean(this.client),

      connecting:
        this.connecting,

      stopped:
        this.stopped
    };
  }
}