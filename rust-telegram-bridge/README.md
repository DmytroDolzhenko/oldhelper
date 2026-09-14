# Rust Telegram Bridge

Self-hosted bridge для Rust+ smart alarms/device broadcasts -> Telegram bot.

## Що воно робить

- власник один раз авторизується у Rust+ через Steam і отримує `playerId/playerToken`;
- сервіс постійно тримає Rust+ WebSocket до сервера;
- коли Smart Alarm або інший paired entity змінює стан, сервіс надсилає повідомлення в Telegram;
- будь-хто може отримувати сповіщення без Steam: достатньо написати `/start` Telegram-боту;
- UI дозволяє зберігати сервер, пристрої, webhook і керувати підписниками.

## Обмеження Rust+

Rust+ не має стабільного офіційного публічного API. Цей bridge використовує community library `@liamcottle/rustplus.js`, яка працює з тим самим companion WebSocket, що й мобільний застосунок. Якщо Facepunch змінить протокол, залежність може потребувати оновлення. У 2026 році в upstream є відкриті issues про protobuf-поля на нових Rust-серверах; якщо listener падає з `ProtocolError`, треба оновити/пропатчити `rustplus.proto` у залежності або перейти на активніший fork.

## Підготовка Rust+ credentials

На своєму ПК, де є Chrome:

```bash
npx @liamcottle/rustplus.js fcm-register
npx @liamcottle/rustplus.js fcm-listen
```

Після цього зайди на Rust-сервер у грі, відкрий `ESC -> Rust+ -> Pair with Server`. У виводі `fcm-listen` з'являться `ip`, `port`, `playerId`, `playerToken`. Для Smart Alarm або іншого device натисни `Pair` у грі і запиши `entityId`.

Якщо ти адмін сервера, companion port можна перевірити командою `app.info`. За замовчуванням це часто game/RCON port + 67, але порт має бути відкритий назовні.

## Telegram

1. Створи бота через BotFather.
2. Скопіюй token у `TELEGRAM_BOT_TOKEN`.
3. Після деплою зайди в UI і натисни `Set webhook`.
4. Користувачі або група пишуть боту `/start`.

Для групи: додай бота в групу і напиши `/start` у групі.

## Локальний запуск

```bash
npm install
cp .env.example .env
npm start
```

Відкрий `http://localhost:3000`, додай сервер і entities.

`node src/server.js` автоматично читає `.env` з поточної папки. Після зміни `PUBLIC_URL`, `TELEGRAM_BOT_TOKEN` або storage env vars треба перезапустити процес.

Для локального тесту постав:

```env
TELEGRAM_MODE=polling
PUBLIC_URL=http://localhost:3000
```

У цьому режимі кнопку `Set webhook` натискати не треба. Сервер сам опитує Telegram, тому просто напиши `/start` боту, потім натисни `Оновити` в UI. Підписник має з'явитися у блоці Telegram.

Для Telegram webhook `PUBLIC_URL` не може бути `localhost`, бо Telegram має відправляти HTTP-запити на твій сервіс з інтернету. Для локального тесту використай tunnel, наприклад `localtunnel`, `ngrok` або Cloudflare Tunnel, і постав `PUBLIC_URL` на його `https://...` адресу.

Для деплою в інтернет краще постав:

```env
TELEGRAM_MODE=webhook
PUBLIC_URL=https://your-app.example.com
```

## Supabase schema

На free-хостингах файлове сховище часто ephemeral, тому для реального деплою краще Supabase Free.

1. Створи Supabase project.
2. Відкрий SQL editor.
3. Виконай `supabase.sql`.
4. У Render/Koyeb env vars постав:

```env
STORAGE_DRIVER=supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Service role key не можна показувати клієнту. Тут він використовується тільки на backend.

## Безкоштовний деплой

Найпростіше: Render Free Web Service.

1. Запуш цей каталог у GitHub repository.
2. Render -> New -> Web Service -> вибери repo.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Додай env vars з `.env.example`.
6. `PUBLIC_URL` має бути повним URL Render-сервісу, наприклад `https://rust-telegram-bridge.onrender.com`.

Важливо: Render Free може засинати після idle. Станом на 2026 рік WebSocket messages рахуються як активність, але для дуже тихого сервера можливий cold start. Для hobby bridge це ок, для рейд-алертів без компромісів потрібен платний always-on VPS або хоча б дуже дешевий instance.

## Майбутні покращення

- Steam OpenID login саме для адмін-UI;
- кілька серверів і профілі wipe;
- Telegram topics/roles для різних типів alarm;
- map markers: Cargo, Heli, Chinook, locked crate;
- team chat mirror;
- camera snapshots;
- health monitor з повідомленням, якщо Rust+ WebSocket відвалився.
