const $ = (selector) => document.querySelector(selector);
const state = { data: null };

function headers() {
  return {
    'Content-Type': 'application/json'
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

function showTelegramStatus(message) {
  const status = $('#telegramStatus');
  status.textContent = message;
  status.classList.add('active');
}

function renderSystemStatus(data) {
  $('#systemStatus').innerHTML = `
    <div><span class="muted">Telegram</span><strong>${data.telegramMode || 'unknown'}${data.pollingRunning ? ' / polling active' : ''}</strong></div>
    <div><span class="muted">Rust+ FCM</span><strong>${data.pairing?.status || 'unknown'}</strong></div>
    <div><span class="muted">FCM config</span><strong>${data.pairing?.configFile || 'not set'}</strong></div>
    <div><span class="muted">Rust+ servers</span><strong>${(data.rustPlus || []).map((item) => item.status).join(', ') || 'not connected'}</strong></div>
  `;
}

function entityRow(entity = {}) {
  const div = document.createElement('div');
  div.className = 'entity-row';
  div.innerHTML = `
    <input class="entity-id" placeholder="entity id" value="${entity.id || ''}">
    <input class="entity-name" placeholder="назва: Raid alarm" value="${entity.name || ''}">
    <label class="switch"><input class="entity-enabled" type="checkbox" ${entity.enabled !== false ? 'checked' : ''}> active</label>
    <button type="button" class="secondary">Видалити</button>
  `;
  div.querySelector('button').addEventListener('click', () => div.remove());
  return div;
}

function render() {
  const data = state.data;
  renderSystemStatus(data);
  const first = data.servers[0];
  if (first) {
    $('#serverId').value = first.id;
    $('#name').value = first.name;
    $('#ip').value = first.ip;
    $('#port').value = first.port;
    $('#playerId').value = first.playerId;
    $('#playerToken').value = first.playerToken;
    $('#enabled').checked = first.enabled;
    $('#entities').replaceChildren(...first.entities.map(entityRow));
  } else if (!$('#entities').children.length) {
    $('#entities').append(entityRow({ name: 'Raid alarm', enabled: true }));
  }

  $('#connectionState').textContent = data.rustPlus.map((item) => `${item.serverId}: ${item.status}`).join(', ') || 'not connected';
  showTelegramStatus(data.telegramMode === 'polling'
    ? 'Telegram mode: polling. Для локального тесту просто напиши /start боту, потім натисни Оновити.'
    : 'Telegram mode: webhook. Після Set webhook Telegram надсилатиме /start на PUBLIC_URL.');

  $('#subscribers').innerHTML = data.subscribers.map((item) => `
    <div class="item">
      <div><strong>${item.name || item.chatId}</strong><br><span class="muted">${item.chatId}${item.lastError ? ` · ${item.lastError}` : ''}</span></div>
      <button class="secondary" data-chat="${item.chatId}" data-enabled="${!item.enabled}">${item.enabled ? 'Вимкнути' : 'Увімкнути'}</button>
    </div>
  `).join('') || '<p class="muted">Ще немає підписників.</p>';

  $('#connectedServers').innerHTML = data.servers.map((server) => `
    <div class="server-card">
      <div class="server-head">
        <div>
          <strong>${server.name}</strong><br>
          <span class="muted">${server.ip}:${server.port} · ${server.enabled ? 'enabled' : 'disabled'}</span>
        </div>
        <button class="danger" data-delete-server="${server.id}">Видалити сервер</button>
      </div>
      <div class="device-list">
        ${(server.entities || []).map((entity) => `
          <div class="item">
            <div>
              <strong>${entity.name || `Entity ${entity.id}`}</strong><br>
              <span class="muted">entity ${entity.id} · ${entity.enabled ? 'enabled' : 'disabled'}</span>
            </div>
            <button class="secondary" data-delete-entity="${entity.id}" data-server="${server.id}">Видалити device</button>
          </div>
        `).join('') || '<p class="muted">Device ще не підключені.</p>'}
      </div>
    </div>
  `).join('') || '<p class="muted">Сервери ще не підключені.</p>';

  $('#pendingPairings').innerHTML = (data.pendingPairings || []).map((item) => `
    <div class="item">
      <div>
        <strong>${item.type === 'entity' ? 'Device' : 'Server'}: ${item.name || item.entityName || item.id}</strong><br>
        <span class="muted">${item.ip}:${item.port}${item.entityId ? ` · entity ${item.entityId}` : ''} · ${item.status}</span>
      </div>
      <span>${item.createdAt}</span>
    </div>
  `).join('') || '<p class="muted">Немає pending pairing.</p>';

  $('#pairingState').textContent = `FCM: ${data.pairing?.status || 'unknown'}`;
  $('#pairingLogs').innerHTML = (data.pairingLogs || []).map((item) => `
    <details class="log-item">
      <summary>
        <strong>${item.parsed ? 'parsed' : 'unparsed'}</strong>
        <span class="muted">${item.createdAt}${item.server ? ` · ${item.server}` : ''}${item.entityId ? ` · entity ${item.entityId}` : ''}</span>
      </summary>
      <pre>${item.raw || ''}</pre>
    </details>
  `).join('') || '<p class="muted">FCM push ще не приходив у bridge.</p>';

  $('#events').innerHTML = data.events.map((event) => `
    <div class="item">
      <div><strong>${event.entityName}</strong> на ${event.serverName}<br><span class="muted">${event.createdAt}</span></div>
      <span>${event.active ? 'active' : 'inactive'}</span>
    </div>
  `).join('') || '<p class="muted">Подій поки немає.</p>';

  document.querySelectorAll('[data-chat]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api('/api/subscribers', {
        method: 'PATCH',
        body: JSON.stringify({ chatId: button.dataset.chat, enabled: button.dataset.enabled === 'true' })
      });
      await load();
    });
  });

  document.querySelectorAll('[data-delete-server]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Видалити цей сервер і всі його device з bridge?')) return;
      await api(`/api/servers/${encodeURIComponent(button.dataset.deleteServer)}`, { method: 'DELETE' });
      await load();
    });
  });

  document.querySelectorAll('[data-delete-entity]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Видалити цей device з bridge?')) return;
      await api(`/api/servers/${encodeURIComponent(button.dataset.server)}/entities/${encodeURIComponent(button.dataset.deleteEntity)}`, {
        method: 'DELETE'
      });
      await load();
    });
  });
}

async function load() {
  state.data = await api('/api/state');
  render();
}

$('#addEntity').addEventListener('click', () => $('#entities').append(entityRow()));

$('#serverForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const entities = [...document.querySelectorAll('.entity-row')].map((row) => ({
    id: row.querySelector('.entity-id').value.trim(),
    name: row.querySelector('.entity-name').value.trim(),
    enabled: row.querySelector('.entity-enabled').checked,
    onlyWhenActive: true
  }));
  await api('/api/servers', {
    method: 'POST',
    body: JSON.stringify({
      id: $('#serverId').value || undefined,
      name: $('#name').value,
      ip: $('#ip').value,
      port: $('#port').value,
      playerId: $('#playerId').value,
      playerToken: $('#playerToken').value,
      enabled: $('#enabled').checked,
      entities
    })
  });
  await load();
});

$('#setWebhook').addEventListener('click', async () => {
  try {
    await api('/api/telegram/webhook', { method: 'POST' });
    showTelegramStatus('Telegram webhook configured. Тепер напиши /start боту.');
  } catch (error) {
    showTelegramStatus(error.message);
  }
});

$('#refresh').addEventListener('click', load);
$('#refreshStatus').addEventListener('click', load);

load().catch((error) => {
  console.error(error);
  alert(error.message);
});
