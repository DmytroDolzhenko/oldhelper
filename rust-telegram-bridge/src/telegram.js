export class Telegram {
  constructor(token) {
    this.token = token;
    this.apiBase = token ? `https://api.telegram.org/bot${token}` : null;
  }

  enabled() {
    return Boolean(this.apiBase);
  }

  async call(method, payload) {
    if (!this.enabled()) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(body)}`);
    }
    return body.result;
  }

  getUpdates({ offset, timeout = 25 } = {}) {
    return this.call('getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message']
    });
  }

  deleteWebhook() {
    return this.call('deleteWebhook', {
      drop_pending_updates: false
    });
  }

  getWebhookInfo() {
    return this.call('getWebhookInfo', {});
  }

  sendMessage(chatId, text) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  }

  setWebhook(url) {
    return this.call('setWebhook', {
      url,
      allowed_updates: ['message']
    });
  }
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
