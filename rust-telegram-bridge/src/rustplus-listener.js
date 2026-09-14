import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { escapeHtml } from './telegram.js';

export class RustPlusManager extends EventEmitter {
  constructor({ storage, telegram, cooldownSeconds = 60 }) {
    super();
    this.storage = storage;
    this.telegram = telegram;
    this.cooldownMs = Number(cooldownSeconds) * 1000;
    this.clients = new Map();
    this.lastAlertAt = new Map();
    this.RustPlus = null;
  }

  async loadRustPlus() {
    if (this.RustPlus) return this.RustPlus;
    const mod = await import('@liamcottle/rustplus.js');
    this.RustPlus = mod.default ?? mod;
    return this.RustPlus;
  }

  async sync() {
    const state = await this.storage.read();
    const desired = new Set(state.servers.filter((server) => server.enabled).map((server) => server.id));

    for (const [id, record] of this.clients.entries()) {
      if (!desired.has(id)) {
        record.client.disconnect?.();
        this.clients.delete(id);
      }
    }

    for (const server of state.servers) {
      if (server.enabled && !this.clients.has(server.id)) {
        await this.connect(server);
      }
    }
  }

  async connect(server) {
    const RustPlus = await this.loadRustPlus();
    const client = new RustPlus(server.ip, String(server.port), String(server.playerId), Number(server.playerToken));
    const record = { client, serverId: server.id, status: 'connecting' };
    this.clients.set(server.id, record);

    client.on('connected', () => {
      record.status = 'connected';
      this.emit('status', { serverId: server.id, status: 'connected' });
      for (const entity of server.entities ?? []) {
        if (entity.enabled) client.getEntityInfo(Number(entity.id), () => false);
      }
    });

    client.on('disconnected', () => {
      record.status = 'disconnected';
      this.emit('status', { serverId: server.id, status: 'disconnected' });
      setTimeout(() => this.reconnect(server.id), 15_000).unref?.();
    });

    client.on('error', (error) => {
      record.status = 'error';
      record.error = error.message;
      this.emit('status', { serverId: server.id, status: 'error', error: error.message });
    });

    client.on('message', (message) => {
      this.handleMessage(server.id, message).catch((error) => {
        this.emit('status', { serverId: server.id, status: 'alert_error', error: error.message });
      });
    });

    client.connect();
  }

  async reconnect(serverId) {
    const state = await this.storage.read();
    const server = state.servers.find((item) => item.id === serverId && item.enabled);
    if (!server) return;
    const current = this.clients.get(serverId);
    if (current?.status === 'connected') return;
    this.clients.delete(serverId);
    await this.connect(server);
  }

  async handleMessage(serverId, message) {
    const changed = message?.broadcast?.entityChanged;
    if (!changed) return;

    const state = await this.storage.read();
    const server = state.servers.find((item) => item.id === serverId);
    const entity = server?.entities?.find((item) => String(item.id) === String(changed.entityId));
    if (!server || !entity?.enabled) return;

    const value = Boolean(changed.payload?.value);
    if (entity.onlyWhenActive !== false && !value) return;

    const cooldownKey = `${serverId}:${entity.id}:${value}`;
    const now = Date.now();
    if (now - (this.lastAlertAt.get(cooldownKey) ?? 0) < this.cooldownMs) return;
    this.lastAlertAt.set(cooldownKey, now);

    const event = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      serverId,
      serverName: server.name,
      entityId: String(entity.id),
      entityName: entity.name || `Entity ${entity.id}`,
      active: value
    };

    await this.storage.update((draft) => {
      draft.events.unshift(event);
      draft.events = draft.events.slice(0, 100);
    });

    const text = [
      '🚨 <b>Rust+ Alert</b>',
      `<b>Server:</b> ${escapeHtml(server.name)}`,
      `<b>Device:</b> ${escapeHtml(event.entityName)}`,
      `<b>Status:</b> ${value ? 'active' : 'inactive'}`,
      `<b>Time:</b> ${escapeHtml(event.createdAt)}`
    ].join('\n');

    for (const subscriber of state.subscribers.filter((item) => item.enabled)) {
      await this.telegram.sendMessage(subscriber.chatId, text).catch(async (error) => {
        await this.storage.update((draft) => {
          const target = draft.subscribers.find((item) => item.chatId === subscriber.chatId);
          if (target) target.lastError = error.message;
        });
      });
    }
  }

  statuses() {
    return [...this.clients.entries()].map(([serverId, record]) => ({
      serverId,
      status: record.status,
      error: record.error ?? null
    }));
  }
}
