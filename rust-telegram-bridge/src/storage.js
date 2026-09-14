import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = {
  servers: [],
  subscribers: [],
  events: [],
  settings: {
    telegramWebhookConfiguredAt: null
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(state) {
  return {
    ...clone(DEFAULT_STATE),
    ...state,
    settings: { ...DEFAULT_STATE.settings, ...(state?.settings ?? {}) },
    servers: Array.isArray(state?.servers) ? state.servers : [],
    subscribers: Array.isArray(state?.subscribers) ? state.subscribers : [],
    events: Array.isArray(state?.events) ? state.events : []
  };
}

export class JsonStorage {
  constructor(filePath) {
    this.filePath = path.resolve(filePath || './data.json');
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT') return clone(DEFAULT_STATE);
      throw error;
    }
  }

  async write(state) {
    const next = normalizeState(state);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(next, null, 2));
    return next;
  }

  async update(mutator) {
    this.queue = this.queue.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await this.write(state);
      return result ?? state;
    });
    return this.queue;
  }
}

export class SupabaseStorage {
  constructor({ url, serviceRoleKey }) {
    this.url = url?.replace(/\/$/, '');
    this.serviceRoleKey = serviceRoleKey;
    if (!this.url || !this.serviceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase storage.');
    }
  }

  headers(extra = {}) {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async read() {
    const response = await fetch(`${this.url}/rest/v1/app_state?id=eq.main&select=data`, {
      headers: this.headers()
    });
    if (!response.ok) throw new Error(`Supabase read failed: ${response.status} ${await response.text()}`);
    const rows = await response.json();
    return normalizeState(rows[0]?.data ?? DEFAULT_STATE);
  }

  async write(state) {
    const next = normalizeState(state);
    const response = await fetch(`${this.url}/rest/v1/app_state`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify({ id: 'main', data: next })
    });
    if (!response.ok) throw new Error(`Supabase write failed: ${response.status} ${await response.text()}`);
    return next;
  }

  async update(mutator) {
    const state = await this.read();
    const result = await mutator(state);
    await this.write(state);
    return result ?? state;
  }
}

export function createStorageFromEnv(env = process.env) {
  if (env.STORAGE_DRIVER === 'supabase') {
    return new SupabaseStorage({
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
    });
  }
  return new JsonStorage(env.DATA_FILE);
}
