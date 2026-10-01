const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

function render(data) {
  $('#user').textContent = data.user ? `Steam: ${data.user.displayName || data.user.steamId}` : 'Увійдіть через Steam';
  $('#telegram').textContent = data.subscribers?.length ? `Telegram підключено: ${data.subscribers.map((item) => item.name || item.chatId).join(', ')}` : 'Telegram ще не підключено';
  $('#status').textContent = `FCM: ${data.pairing?.status || 'unknown'}; Rust+ connections: ${data.rustPlus?.map((item) => item.status).join(', ') || 'немає'}`;
  $('#servers').innerHTML = data.servers.length ? data.servers.map((server) => `<article class="server-card"><div><strong>${server.name}</strong><br><span class="muted">${server.ip}:${server.port}</span></div><button class="secondary" data-delete-server="${server.id}">Відв’язати</button><div class="device-list">${server.entities?.length ? server.entities.map((device) => `<div class="item"><span>${device.name || `Device ${device.id}`}</span><button class="secondary" data-delete-device="${device.id}" data-server="${server.id}">Видалити</button></div>`).join('') : '<span class="muted">Девайсів ще немає.</span>'}</div></article>`).join('') : '<p class="muted">Серверів ще немає. Натисніть Pair Server, а потім Pair with Server у Rust+.</p>';
  document.querySelectorAll('[data-delete-server]').forEach((button) => button.addEventListener('click', async () => { await api(`/api/servers/${encodeURIComponent(button.dataset.deleteServer)}`, { method: 'DELETE' }); load(); }));
}

async function load() {
  try { render(await api('/api/state')); }
  catch (error) { $('#status').textContent = error.message; }
}

$('#connectTelegram').addEventListener('click', async () => {
  const { url } = await api('/api/telegram-link', { method: 'POST' });
  window.location.assign(url);
});
$('#refresh').addEventListener('click', load);
load();
