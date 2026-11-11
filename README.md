# Mod Overlay

**English** | [Русский](#russian)

An OBS overlay controlled by moderators: drawing over the stream, images and GIFs, text,
voice-over (TTS), sounds and effects. The overlay is added to OBS as a "Browser Source",
while moderators work in a panel — in the Windows app or in a browser.

## Features

- Freehand drawing: pen, marker, eraser, undo, clear. Strokes are smoothed and synchronized
  in real time.
- Images, GIFs and video: file upload (up to 25 MB) or via URL, dragging, resizing,
  opacity, fullscreen mode, auto-hide.
- Text banners: size, color, background, outline, bold font, auto-hide.
- Edge TTS voice-over: Russian and other voices, rate, pitch, volume. If the service is
  unavailable, the browser's system voice is used.
- Voice preview before going live, ready-made styles ("Narrator", "Radio", "Chipmunk", "Demon")
  and a "Stop" button that instantly stops voice-over in the overlay.
- Soundboard: your own sound library with categories, favorites, per-sound hotkeys and a playback
  queue, plus built-in presets (beep, buzzer, whoosh, drum roll, honk, pop). Upload audio files or
  add them by URL; drag pads to reorder.
- Widgets on the overlay: clock, timer/stopwatch, event counter, progress bar, fundraising goal,
  random picker and leaderboard — each with a live editor in the panel.
- Animated notifications: ready-made templates (donation, follower, subscription, success, warning,
  error, info), six screen positions, four entrance animations, custom accent/icon and a live preview.
- Live event feed: every moderator action (text, sound, drawing, effects, widgets, notifications)
  in real time, with per-action filters and search.
- Flexible permissions: grant each moderator only the rights they need — drawing, media, text, TTS,
  sounds, effects, widgets, notifications and screen clearing. Tabs and tools hide automatically.
- Effects: flash, shake, confetti.
- Multiple moderators at the same time; changes are visible to all connected overlays.
- The administrator adds moderators (login and password) right in the panel; each has their own
  profile and password change.
- The overlay is fully transparent and never shows errors on air.
- The server can be kept on a host 24/7 — the streamer doesn't need to run any program.

## Quick start (server)

Node.js 20 or newer is required.

```bat
npm install
npm run build
npm start
```

Or just run `start.cmd` — it builds the project and starts the server.

After the first run the console prints:

- the panel address: `http://localhost:3000/panel/`
- the link for OBS;
- the `admin` login and a random administrator password.

The password is also saved to `data/ADMIN_PASSWORD.txt`. Change it after the first login —
the "Profile" button in the panel.

## Source code on GitHub

The repository is ready to upload: server, panel, overlay, Electron wrapper, tests, files for
Docker/nginx/systemd and CI for GitHub Actions.

> **Important:** GitHub Pages serves static files only. This site needs Node.js
> (login, WebSocket, uploads, TTS), so GitHub hosts the code while the site itself runs
> on a VPS or another hosting with Node.js and a persistent disk — see [`deploy/`](deploy/README.md).

Uploading the sources:

```bash
git init
git add .
git commit -m "Mod Overlay"
git branch -M main
git remote add origin https://github.com/USER/mod-overlay.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `dist/`, `release/`, `data/` and `.env`.
The `data` folder and `.env` files must never be published: they contain passwords, the overlay key and secrets.

After every push GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
builds the project, checks types, runs all tests and verifies the Docker image build.

Deploying the site from the repository onto a server:

```bash
git clone https://github.com/USER/mod-overlay.git /opt/mod-overlay-src
cd /opt/mod-overlay-src/deploy
cp .env.example .env
nano .env                 # domain, PUBLIC_URL, ADMIN_LOGIN, ADMIN_PASSWORD
docker compose up -d --build
```

If the repository is private, `git clone` and `git pull` will require an SSH key or a GitHub
access token.

## Hosted site (without the streamer running the program)

The server can be deployed once on a VPS or a home server and left running.
Moderators sign in to the site with their own logins, and the streamer doesn't need to run
the Windows app: in OBS it is enough to paste the overlay link of that server.

Ready-made hosting files are in the [`deploy/`](deploy/README.md) folder:

- `deploy/Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile` — site + HTTPS in one command;
- `deploy/nginx.conf` — an nginx variant;
- `deploy/mod-overlay.service` — running via systemd;
- `deploy/.env.example` — domain, administrator password and token secret.

In short (Docker + Caddy):

```bash
cd deploy
cp .env.example .env      # DOMAIN, PUBLIC_URL, ADMIN_LOGIN, ADMIN_PASSWORD
docker compose up -d --build
```

After startup: `https://your-domain/panel/`. The **Admin → Moderators** tab allows
adding moderators (login + password), changing passwords and deleting accounts.

### OBS

1. Add a **Browser** source.
2. Paste the link for OBS (the "OBS link" button in the panel, "Admin" tab).
3. Width `1920`, height `1080`.
4. Enable "Refresh browser when scene becomes active".
5. Voice-over and sounds come from the source — enable it in the OBS mixer if needed.

If OBS is on another computer, open the server port on the local network and use that computer's
IP address instead of `localhost` (the server prints such addresses at startup).

## Windows app

The app combines a local server and the moderator panel in one window.

- Running from sources: `npm install` (once) and `npm run desktop`.
- Building the installer: `npm run dist` → the finished file is in the `release` folder.
- Building without the installer: `npm run dist:dir` → `release\win-unpacked`.

On first launch the app offers a mode choice:

- **On this computer** — a local server on port `3111`, data in `%APPDATA%\Mod Overlay`.
  The app must be running during the stream.
- **On my own server** — the app opens the panel of an already deployed server at an address like
  `https://overlay.example.com`.

Settings are available in the "File → Settings…" menu; there you can also change the port, copy the link for
OBS and open the data folder. If the port is busy, the app picks the next free one.

Important: the Windows app's data folder and the server version's `data` folder are different. To transfer
the database, copy the contents of the data folder.

## Hosting the server on the internet

The server is a regular Node.js application. It is enough to run it behind an HTTPS reverse proxy
(nginx, Caddy, Traefik) with WebSocket support. Ready-made configurations and step-by-step instructions are in
[`deploy/README.md`](deploy/README.md).

Environment variables (can be placed in `.env`, example — `.env.example`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Server port | `3000` |
| `HOST` | Listening interface | `0.0.0.0` |
| `PUBLIC_URL` | External server address, used in the OBS link | address from the request |
| `TRUST_PROXY` | How many proxies to trust (`loopback`, `1`) | `loopback` |
| `DATA_DIR` | Folder with the database, uploads and voice-over | `./data` |
| `PUBLIC_DIR` | Static files folder | `./public` |
| `JWT_SECRET` | Token signing secret | generated in `data/secret.key` |
| `ADMIN_LOGIN` | First administrator login | `admin` |
| `ADMIN_PASSWORD` | First administrator password | generated |
| `YANDEX_TTS_KEY` | Yandex SpeechKit API key for the Alena, Filipp, Zakhar… voices | disabled |
| `YANDEX_TTS_FOLDER` | Yandex Cloud `folder_id` | — |
| `STEOSVOICE_TOKEN` | SteosVoice token for character voices | disabled |
| `STEOSVOICE_API_URL` | SteosVoice API base URL | `https://api.voice.steos.io/v1` |

### DonationAlerts voices

Besides Edge TTS, the panel can enable the voices used by DonationAlerts:

- **Yandex SpeechKit** — Alena, Filipp, Ermil, Jane, Omazh, Zakhar, Madirus, Marina.
  Requires `YANDEX_TTS_KEY` and `YANDEX_TTS_FOLDER` from the Yandex Cloud console.
- **SteosVoice** — character and streamer voices. Requires `STEOSVOICE_TOKEN` from
  the [dashboard](https://console.cybervoice.io/user).

Without the keys these voices are not shown, and voice-over keeps working via Edge TTS.
The keys are stored only in `.env` on the server and are never sent to the browser.

nginx example:

```nginx
server {
    listen 443 ssl http2;
    server_name overlay.example.com;
    client_max_body_size 30m;          # file uploads up to 25 MB

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Be sure to set `PUBLIC_URL=https://overlay.example.com` so the OBS link is correct.
WebSocket connections go through the same domain automatically (`wss://`).

What is stored in `data`:

- `db.json` — users, the room and the overlay key;
- `rooms.json` — current scene state;
- `uploads/` — uploaded images, videos and sounds;
- `tts/` — generated voice-over (cleaned up automatically);
- `secret.key` — the JWT secret;
- `ADMIN_PASSWORD.txt` — the first-login password.

## Panel hotkeys

| Keys | Action |
| --- | --- |
| `V` / `P` / `M` / `E` | select, pen, marker, eraser |
| `Ctrl+Z` | undo the last stroke |
| `Delete` / `Backspace` | delete the selected object |
| `Esc` | deselect / close a dialog |
| `Ctrl+Enter` | send text or voice-over |
| `A`–`Z`, `0`–`9`, `F1`–`F12` | play the sound assigned to that key (soundboard) |

## Security

- The overlay key is contained in the link and is checked on connection. The key can be changed in the panel —
  the old link stops working.
- Login by username and password, the token is valid for 24 hours.
- No more than 15 login attempts per 10 minutes from a single IP.
- Uploads: images, video and audio only, no SVG, up to 25 MB.
- WebSocket message rate and room state size are limited.
- Host the server over HTTPS only: passwords and tokens are transmitted through it.

## Project structure

```
src/            TypeScript server (Express, ws, JWT, Edge TTS)
public/panel/   moderator panel site (separate HTML/CSS/JS)
public/overlay/ the OBS overlay
public/shared/  shared scene renderer
desktop/        Electron app (main, preload, settings, icons)
deploy/         Docker, Caddy, nginx, systemd and hosting guide
.github/        GitHub Actions CI (types, tests, Docker image)
test/           automated tests for the server, WebSocket, state and panel
data/           database, uploads, voice-over (created at startup, not committed)
```

## Tests

```bat
npm test
```

The tests run on the built-in `node:test` and require no internet: TTS is checked via
a stubbed engine, the server starts on a free port with a temporary data folder.
On GitHub the same checks are performed by the [`.github/workflows/ci.yml`](.github/workflows/ci.yml) workflow.
Covered:

- login, roles, attempt limiting, password change and revocation;
- moderator creation/deletion, the overlay key, file uploads;
- flexible permissions: normalization, per-event enforcement over WebSocket and HTTP;
- widgets: normalization and live control of every type (counter, timer, progress, goal, random,
  leaderboard), persistence and limits;
- soundboard: idempotent import, hotkey conflicts, favorites, reordering and persistence;
- animated notifications: validation, templates, positions and clamping;
- live event feed: recording, ordering, the ring buffer and admin-only clearing;
- WebSocket: authorization, scene synchronization, drawing, media and text events,
  session closure after password changes and key rotation;
- room state validation and limits, auto-hide;
- frontend module syntax and panel tab/ID consistency.

## Troubleshooting

- **Blank in OBS.** Check that the server is running, the link was copied in full and the key is still valid.
  The browser source in OBS must have sound enabled.
- **"No connection" in the panel.** The server is stopped, the port is busy, or the address in the app settings
  does not match the server address.
- **Voice-over doesn't work.** Edge TTS is sometimes unavailable — the panel automatically switches to
  the system voice. Check the internet connection on the server computer.
- **Moderators on the local network can't log in.** Allow inbound connections to the port in
  Windows Firewall and use the IP address of the computer running the server.
- **Forgot the administrator password.** If there are no other administrators, stop the server, delete
  `data/db.json` and start it again — a new administrator will be created. Note that the overlay key
  will change as well: the link in OBS must be replaced. Upload and voice-over files stay in place.

---

<a id="russian"></a>

[English](#mod-overlay) | **Русский**

Оверлей для OBS, которым управляют модераторы: рисунок поверх стрима, картинки и GIF, текст,
озвучка (TTS), звуки и эффекты. Оверлей подключается в OBS как «Браузерный источник», а модераторы
работают в панели — в Windows-приложении или в браузере.

## Возможности

- Рисование от руки: ручка, маркер, ластик, отмена, очистка. Штрихи сглаживаются и синхронизируются
  в реальном времени.
- Картинки, GIF и видео: загрузка файлом (до 25 МБ) или по ссылке, перетаскивание, изменение размера,
  прозрачность, полноэкранный режим, автоскрытие.
- Текстовые плашки: размер, цвет, подложка, обводка, жирный шрифт, автоскрытие.
- Озвучка Edge TTS: русские и другие голоса, скорость, тон, громкость. При недоступности сервиса
  используется системный голос браузера.
- Прослушивание голоса до эфира, готовые стили («Диктор», «Радио», «Бурундук», «Демон»)
  и кнопка «Стоп», мгновенно останавливающая озвучку в оверлее.
- Soundboard: собственная библиотека звуков с категориями, избранным, горячими клавишами для каждого
  звука и очередью воспроизведения, плюс готовые пресеты (бип, баззер, вжух, дробь, гудок, поп).
  Загружайте аудиофайлы или добавляйте по ссылке; перетаскивайте плашки для порядка.
- Виджеты на оверлее: часы, таймер/секундомер, счётчик событий, полоса прогресса, цель сбора средств,
  случайный выбор и таблица лидеров — у каждого живой редактор в панели.
- Анимированные уведомления: готовые шаблоны (донат, подписчик, подписка, успех, предупреждение,
  ошибка, информация), шесть позиций на экране, четыре анимации появления, свой цвет/иконка и предпросмотр.
- Живая лента событий: каждое действие модераторов (текст, звук, рисунок, эффекты, виджеты, уведомления)
  в реальном времени, с фильтрами по типу действия и поиском.
- Гибкая система прав: выдавайте каждому модератору только нужные права — рисование, медиа, текст, TTS,
  звуки, эффекты, виджеты, уведомления и очистка экрана. Вкладки и инструменты скрываются автоматически.
- Эффекты: вспышка, тряска, конфетти.
- Несколько модераторов одновременно; изменения видят все подключённые оверлеи.
- Администратор добавляет модераторов (логин и пароль) прямо в панели; у каждого свой профиль
  и смена пароля.
- Оверлей полностью прозрачный и не показывает ошибки в эфире.
- Сервер можно держать на хосте 24/7 — стримеру не нужно запускать программу.

## Быстрый старт (сервер)

Нужен Node.js 20 или новее.

```bat
npm install
npm run build
npm start
```

Или просто запустите `start.cmd` — он соберёт проект и запустит сервер.

После первого запуска в консоли появятся:

- адрес панели: `http://localhost:3000/panel/`
- ссылка для OBS;
- логин `admin` и случайный пароль администратора.

Пароль также сохраняется в `data/ADMIN_PASSWORD.txt`. Смените его после первого входа —
кнопка «Профиль» в панели.

## Исходники на GitHub

Репозиторий готов к загрузке: сервер, панель, оверлей, Electron-обёртка, тесты, файлы для
Docker/nginx/systemd и CI для GitHub Actions.

> **Важно:** GitHub Pages отдаёт только статические файлы. Этому сайту нужен Node.js
> (вход, WebSocket, загрузки, TTS), поэтому на GitHub хранится код, а сам сайт запускается
> на VPS или другом хостинге с Node.js и постоянным диском — см. [`deploy/`](deploy/README.md).

Загрузка исходников:

```bash
git init
git add .
git commit -m "Mod Overlay"
git branch -M main
git remote add origin https://github.com/ПОЛЬЗОВАТЕЛЬ/mod-overlay.git
git push -u origin main
```

`.gitignore` уже исключает `node_modules/`, `dist/`, `release/`, `data/` и `.env`.
Папку `data` и файлы `.env` публиковать нельзя: в них пароли, ключ оверлея и секреты.

После каждого push GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
собирает проект, проверяет типы, запускает все тесты и проверяет сборку Docker-образа.

Развернуть сайт из репозитория на сервере:

```bash
git clone https://github.com/ПОЛЬЗОВАТЕЛЬ/mod-overlay.git /opt/mod-overlay-src
cd /opt/mod-overlay-src/deploy
cp .env.example .env
nano .env                 # домен, PUBLIC_URL, ADMIN_LOGIN, ADMIN_PASSWORD
docker compose up -d --build
```

Если репозиторий приватный, при `git clone` и `git pull` понадобится SSH-ключ или токен
доступа GitHub.

## Сайт на хосте (без запуска программы стримером)

Сервер можно один раз развернуть на VPS или домашнем сервере и держать включённым.
Модераторы заходят на сайт со своими логинами, а стримеру не нужно запускать
Windows-приложение: в OBS достаточно вставить ссылку на оверлей этого сервера.

Готовые файлы для размещения — в папке [`deploy/`](deploy/README.md):

- `deploy/Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile` — сайт + HTTPS одной командой;
- `deploy/nginx.conf` — вариант с nginx;
- `deploy/mod-overlay.service` — запуск через systemd;
- `deploy/.env.example` — домен, пароль администратора и секрет токенов.

Коротко (Docker + Caddy):

```bash
cd deploy
cp .env.example .env      # DOMAIN, PUBLIC_URL, ADMIN_LOGIN, ADMIN_PASSWORD
docker compose up -d --build
```

После запуска: `https://ваш-домен/panel/`. Вкладка **Админ → Модераторы** позволяет
добавлять модераторов (логин + пароль), менять пароли и удалять аккаунты.

### OBS

1. Добавьте источник **Браузер**.
2. Вставьте ссылку для OBS (кнопка «Ссылка для OBS» в панели, вкладка «Админ»).
3. Ширина `1920`, высота `1080`.
4. Включите «Обновлять браузер, когда сцена становится активной».
5. Звук озвучки и звуков идёт из источника — при необходимости включите его в микшере OBS.

Если OBS на другом компьютере, откройте порт сервера в локальной сети и используйте IP-адрес этого
компьютера вместо `localhost` (сервер печатает такие адреса при запуске).

## Windows-приложение

Приложение объединяет локальный сервер и панель модератора в одном окне.

- Запуск из исходников: `npm install` (один раз) и `npm run desktop`.
- Сборка установщика: `npm run dist` → готовый файл в папке `release`.
- Сборка без установщика: `npm run dist:dir` → `release\win-unpacked`.

При первом запуске приложение предложит выбрать режим:

- **На этом компьютере** — локальный сервер на порту `3111`, данные в `%APPDATA%\Mod Overlay`.
  Приложение должно быть запущено во время стрима.
- **На своём сервере** — приложение открывает панель уже размещённого сервера по адресу вида
  `https://overlay.example.com`.

Настройки доступны в меню «Файл → Настройки…», там же можно сменить порт, скопировать ссылку для
OBS и открыть папку с данными. Если порт занят, приложение подберёт следующий свободный.

Важно: папка данных Windows-приложения и папка `data` серверной версии — разные. Чтобы перенести
базу, скопируйте содержимое папки данных.

## Размещение сервера в интернете

Сервер — обычное Node.js-приложение. Достаточно запустить его за HTTPS reverse-proxy (nginx, Caddy,
Traefik) с поддержкой WebSocket. Готовые конфигурации и пошаговая инструкция — в
[`deploy/README.md`](deploy/README.md).

Переменные окружения (можно положить в `.env`, пример — `.env.example`):

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `PORT` | Порт сервера | `3000` |
| `HOST` | Интерфейс прослушивания | `0.0.0.0` |
| `PUBLIC_URL` | Внешний адрес сервера, попадает в ссылку для OBS | адрес из запроса |
| `TRUST_PROXY` | Сколько прокси доверять (`loopback`, `1`) | `loopback` |
| `DATA_DIR` | Папка с базой, загрузками и озвучкой | `./data` |
| `PUBLIC_DIR` | Папка со статикой | `./public` |
| `JWT_SECRET` | Секрет подписи токенов | генерируется в `data/secret.key` |
| `ADMIN_LOGIN` | Логин первого администратора | `admin` |
| `ADMIN_PASSWORD` | Пароль первого администратора | генерируется |
| `YANDEX_TTS_KEY` | API-ключ Yandex SpeechKit для голосов Алёна, Филипп, Захар… | выключено |
| `YANDEX_TTS_FOLDER` | `folder_id` каталога Yandex Cloud | — |
| `STEOSVOICE_TOKEN` | Токен SteosVoice для голосов персонажей | выключено |
| `STEOSVOICE_API_URL` | Базовый адрес API SteosVoice | `https://api.voice.steos.io/v1` |

### Голоса DonationAlerts

Помимо Edge TTS в панели можно включить голоса, которые использует DonationAlerts:

- **Яндекс SpeechKit** — Алёна, Филипп, Ермил, Джейн, Омаж, Захар, Мадирус, Марина.
  Нужны `YANDEX_TTS_KEY` и `YANDEX_TTS_FOLDER` из консоли Yandex Cloud.
- **SteosVoice** — голоса персонажей и стримеров. Нужен `STEOSVOICE_TOKEN` из
  [личного кабинета](https://console.cybervoice.io/user).

Без ключей эти голоса не показываются, а озвучка продолжает работать через Edge TTS.
Ключи хранятся только в `.env` на сервере и не передаются в браузер.

Пример nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name overlay.example.com;
    client_max_body_size 30m;          # загрузка файлов до 25 МБ

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Обязательно задайте `PUBLIC_URL=https://overlay.example.com`, чтобы ссылка для OBS была правильной.
WebSocket-соединения пойдут через тот же домен автоматически (`wss://`).

Что хранится в `data`:

- `db.json` — пользователи, комната и ключ оверлея;
- `rooms.json` — текущее состояние сцены;
- `uploads/` — загруженные картинки, видео и звуки;
- `tts/` — сгенерированная озвучка (очищается автоматически);
- `secret.key` — секрет JWT;
- `ADMIN_PASSWORD.txt` — пароль первого входа.

## Горячие клавиши панели

| Клавиши | Действие |
| --- | --- |
| `V` / `P` / `M` / `E` | выбор, ручка, маркер, ластик |
| `Ctrl+Z` | отменить последний штрих |
| `Delete` / `Backspace` | удалить выбранный объект |
| `Esc` | снять выделение / закрыть окно |
| `Ctrl+Enter` | отправить текст или озвучку |
| `A`–`Z`, `0`–`9`, `F1`–`F12` | звук, назначенный на эту клавишу (soundboard) |

## Безопасность

- Ключ оверлея находится в ссылке и проверяется при подключении. Сменить ключ можно в панели —
  старая ссылка перестанет работать.
- Вход по логину и паролю, токен действует 24 часа.
- Не более 15 попыток входа за 10 минут с одного IP.
- Загрузки: только изображения, видео и аудио без SVG, до 25 МБ.
- Ограничение частоты WebSocket-сообщений и размера состояния комнаты.
- Размещайте сервер только по HTTPS: через него передаются пароли и токены.

## Структура проекта

```
src/            сервер на TypeScript (Express, ws, JWT, Edge TTS)
public/panel/   сайт-панель модератора (отдельные HTML/CSS/JS)
public/overlay/ оверлей для OBS
public/shared/  общий рендер сцены
desktop/        Electron-приложение (main, preload, настройка, иконки)
deploy/         Docker, Caddy, nginx, systemd и инструкция по хостингу
.github/        CI для GitHub Actions (типы, тесты, Docker-образ)
test/           автотесты сервера, WebSocket, состояния и панели
data/           база, загрузки, озвучка (создаётся при запуске, не коммитится)
```

## Тесты

```bat
npm test
```

Тесты работают на встроенном `node:test` и не требуют интернета: TTS проверяется через
подменённый движок, сервер поднимается на свободном порту с временной папкой данных.
На GitHub те же проверки выполняет workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
Покрыто:

- вход, роли, ограничение попыток, смена и отзыв паролей;
- создание/удаление модераторов, ключ оверлея, загрузки файлов;
- гибкие права: нормализация и проверка прав для каждого события по WebSocket и HTTP;
- виджеты: нормализация и живое управление всеми типами (счётчик, таймер, прогресс, цель, случайный
  выбор, лидеры), сохранение и лимиты;
- soundboard: идемпотентный импорт, конфликты горячих клавиш, избранное, порядок и сохранение;
- анимированные уведомления: валидация, шаблоны, позиции и ограничения;
- живая лента событий: запись, порядок, кольцевой буфер и очистка только админом;
- WebSocket: авторизация, синхронизация сцены, события рисования, медиа и текста,
  закрытие сессий после смены пароля и перевыпуска ключа;
- валидация и лимиты состояния комнаты, автоскрытие;
- синтаксис фронтенд-модулей и согласованность вкладок/ID в панели.

## Частые проблемы

- **В OBS пусто.** Проверьте, что сервер запущен, ссылка скопирована целиком и ключ ещё актуален.
  В OBS у браузерного источника должен быть включён звук.
- **«Нет связи» в панели.** Сервер остановлен, порт занят или адрес в настройках приложения
  не совпадает с адресом сервера.
- **Озвучка не работает.** Edge TTS иногда недоступен — панель автоматически переключится на
  системный голос. Проверьте интернет на компьютере с сервером.
- **Модераторы в локальной сети не могут войти.** Разрешите входящие подключения к порту в
  брандмауэре Windows и используйте IP-адрес компьютера с сервером.
- **Забыли пароль администратора.** Если других администраторов нет, остановите сервер, удалите
  `data/db.json` и запустите снова — будет создан новый администратор. Учтите, что при этом
  изменится ключ оверлея: ссылку в OBS нужно будет заменить. Файлы загрузок и озвучки останутся
  на месте.
