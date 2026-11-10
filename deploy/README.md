# Размещение Mod Overlay на хосте

Сервер — обычное Node.js-приложение. Его можно держать на VPS или домашнем сервере
круглосуточно: стримеру **не нужно запускать Windows-программу**, чтобы модераторы заходили
на сайт. Достаточно, чтобы сервер был запущен на хосте, а в OBS была вставлена ссылка на
оверлей.

```
Модераторы → https://overlay.example.com/panel/   (логин + пароль)
OBS стримера → https://overlay.example.com/overlay/?room=main&key=…
```

> **GitHub Pages не подойдёт:** сайту нужен Node.js (вход, WebSocket, загрузки, TTS).
> В GitHub хранятся исходники, а сам сайт запускается на VPS или другом хостинге с Node.js
> и постоянным диском. Все команды ниже выполняются на сервере.

Что делает хост:

- хранит пользователей, пароли, состояние сцены и загруженные файлы в томе `data`;
- принимает WebSocket-соединения панели и оверлея;
- генерирует TTS (нужен исходящий доступ в интернет к Edge TTS);
- отдаёт сайт по HTTPS.

## Что понадобится

- VPS или домашний сервер с Linux (пример — Ubuntu 22.04/24.04), 1 ГБ RAM достаточно;
- домен, например `overlay.example.com`;
- открытые порты `80` и `443`;
- A-запись домена, указывающая на IP сервера.

## Вариант 1: Docker + Caddy (рекомендуется)

Caddy сам получит HTTPS-сертификат и проксирует WebSocket.

```bash
# 1. DNS: A-запись overlay.example.com → IP сервера

# 2. На сервере (подставьте адрес своего репозитория GitHub)
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
git clone https://github.com/ПОЛЬЗОВАТЕЛЬ/mod-overlay.git /opt/mod-overlay-src
cd /opt/mod-overlay-src/deploy

# 3. Настройки
cp .env.example .env
nano .env
#   DOMAIN=overlay.example.com
#   PUBLIC_URL=https://overlay.example.com
#   ADMIN_LOGIN=admin
#   ADMIN_PASSWORD=длинный-пароль

# 4. Запуск
docker compose up -d --build
docker compose logs -f app
```

Откройте `https://overlay.example.com/panel/` и войдите с логином/паролем из `.env`.
Пароль первого администратора также сохраняется в томе с данными
(`ADMIN_PASSWORD.txt`), его можно посмотреть так:

```bash
docker compose exec app cat /app/data/ADMIN_PASSWORD.txt
```

Если база уже создана, `ADMIN_PASSWORD` из `.env` больше не применяется — пароль меняется
в панели через кнопку «Профиль».

### Добавление модераторов

1. Войдите как администратор.
2. Откройте вкладку **Админ → Модераторы**.
3. Укажите логин (3–32 символа: латиница, цифры, `.`, `_`, `-`) и пароль (минимум 8 символов).
4. Выберите роль «модератор» и нажмите «Добавить».

Модератор заходит на тот же сайт `/panel/` со своими логином и паролем. Вкладку «Админ»
видит только администратор.

### Ссылка для OBS

Войдите администратором → вкладка **Админ → Ссылка для OBS** → «Копировать».
В OBS добавьте источник **Браузер**, вставьте ссылку, укажите `1920 × 1080` и включите
«Обновлять браузер, когда сцена становится активной». Звук источника включите в микшере OBS.

Ссылка содержит ключ комнаты. Кнопка «Сгенерировать новый ключ» отзывает старую ссылку —
после этого замените её в OBS.

### Обновление

```bash
cd /opt/mod-overlay-src
git pull
cd deploy
docker compose up -d --build
```

Том с данными сохраняется между обновлениями.

### Резервная копия

```bash
cd /opt/mod-overlay-src/deploy
docker compose stop app
docker run --rm -v mod-overlay_app-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/mod-overlay-data-$(date +%F).tar.gz -C /data .
docker compose start app
```

Восстановление — распаковать архив обратно в том `mod-overlay_app-data` при остановленном
контейнере. Если вы хотите обычную папку вместо тома, замените в `docker-compose.yml`:

```yaml
volumes:
  - ./data:/app/data
```

и заранее выполните `mkdir -p data && sudo chown -R 10001:10001 data` (UID пользователя
в контейнере — `10001`).

## Вариант 2: systemd + nginx

```bash
# 1. Node.js 22 LTS и nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx

# 2. Пользователь и приложение
sudo useradd --system --home /opt/mod-overlay --shell /usr/sbin/nologin modoverlay
sudo mkdir -p /opt/mod-overlay
sudo chown modoverlay:modoverlay /opt/mod-overlay
# файлы проекта из GitHub
sudo -u modoverlay git clone https://github.com/ПОЛЬЗОВАТЕЛЬ/mod-overlay.git /opt/mod-overlay
cd /opt/mod-overlay
sudo -u modoverlay npm ci
sudo -u modoverlay npm run build
sudo mkdir -p /opt/mod-overlay/data
sudo chown modoverlay:modoverlay /opt/mod-overlay/data

# 3. Настройки
sudo -u modoverlay cp .env.example .env
sudo -u modoverlay nano .env
#   PORT=3000
#   HOST=127.0.0.1
#   PUBLIC_URL=https://overlay.example.com
#   TRUST_PROXY=loopback
#   ADMIN_PASSWORD=длинный-пароль

# 4. systemd
sudo cp deploy/mod-overlay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mod-overlay
sudo systemctl status mod-overlay

# 5. nginx (см. deploy/nginx.conf)
sudo cp deploy/nginx.conf /etc/nginx/conf.d/mod-overlay.conf
sudo nginx -t && sudo systemctl reload nginx

# 6. HTTPS-сертификат
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d overlay.example.com
```

Если nginx стоит на другом компьютере, а Node.js слушает `0.0.0.0:3000`, задайте
`TRUST_PROXY=1` и ограничьте порт 3000 файрволом.

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `DOMAIN` | Только для Docker/Caddy: домен сайта |
| `PUBLIC_URL` | Внешний адрес сайта, попадёт в ссылку для OBS |
| `ADMIN_LOGIN` / `ADMIN_PASSWORD` | Первый администратор (создаётся при пустой базе) |
| `JWT_SECRET` | Секрет подписи токенов (иначе создаётся в `data/secret.key`) |
| `HOST` | Интерфейс прослушивания (`0.0.0.0` или `127.0.0.1`) |
| `PORT` | Порт Node.js-сервера |
| `DATA_DIR` | Папка данных (по умолчанию `./data`) |
| `TRUST_PROXY` | Сколько прокси доверять (`loopback`, `1`, …) |
| `YANDEX_TTS_KEY` / `YANDEX_TTS_FOLDER` | Голоса Yandex SpeechKit: Алёна, Филипп, Захар… |
| `STEOSVOICE_TOKEN` | Голоса персонажей SteosVoice |
| `STEOSVOICE_API_URL` | Необязательно: другой адрес API SteosVoice |

## Частые проблемы

- **Сайт не открывается по HTTPS.** Проверьте DNS и что порты 80/443 открыты.
  С `docker compose logs caddy` видно, получил ли Caddy сертификат.
- **«Нет связи» в панели, вкладки не сохраняются.** Прокси не пропускает WebSocket.
  В nginx нужны `Upgrade`/`Connection`, Caddy делает это автоматически.
- **В OBS пусто.** Ссылка должна начинаться с `https://ваш-домен/overlay/?room=…&key=…`.
  Если ключ перевыпускали, старая ссылка больше не работает.
- **TTS не работает.** Хосту нужен исходящий интернет к сервису Edge TTS. Панель
  автоматически переключится на системный голос браузера, если сервис недоступен.
- **Забыли пароль администратора.** Пока не создан второй администратор, остановите сервер,
  удалите `db.json` в папке данных и запустите снова с `ADMIN_PASSWORD` из `.env`.
  Внимание: вместе с базой сменится ключ оверлея — ссылку в OBS нужно обновить.

## Безопасность

- Всегда используйте HTTPS: через сайт передаются пароли и токены.
- Не публикуйте порт Node.js напрямую в интернет — только через Caddy/nginx.
- Пароль администратора — длинный и уникальный; после первого входа смените его.
- Загрузки ограничены 25 МБ и только изображения/видео/аудио.
- Токен действует 24 часа; смена пароля завершает старые сессии.
- Регулярно делайте резервную копию папки данных.
