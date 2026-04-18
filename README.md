# CakeWorld Bot Manager

Менеджер ботов для CakeWorld с веб-дашбордом, автоматизацией и инструментами мониторинга.

## Быстрый старт

```
setup.bat
```

Скрипт автоматически: проверяет Node.js, Python, g++, собирает C++ инструменты, запускает всё.

Дашборд: **http://localhost:3000** | Настройки: **http://localhost:3000/settings.html**

---

## Возможности

### Автоматизация ботов
- Массовый запуск волнами (размер волны и задержки настраиваются)
- Авто-авторизация `/register` / `/login`
- Авто-навигация по грифам (`/warp grief1..4`)
- Авто-AFK (`/warp afk` + ходьба)
- Авто-сбор реликвий

### Команды
| Кнопка | Описание |
|---|---|
| 🎁 `/free` | Сбор ежедневных наград (берёт только первую за визит) |
| 🐣 Пасха | `/pasxa` — пасхальная награда после 1 ч. на сервере |
| 📦 Кейс | `/warp case` → маршрут → шалкер → открытие кейса |
| 🐣📦 Пасха+Кейс | `/pasxa` получить кейс → сразу открыть его |
| 🛒 Магазин | Парсинг `/shop` с покупкой по количеству (qty 1–99) |
| 📡 Все боты | Broadcast-команда с корректным стаггером |

#### Маршрут открытия кейса
`/warp case` → **4 вперёд → 1 вправо → 8 вперёд → 1 влево** → ПКМ шалкер → клик по кейсу

### Защита от Grim античита
- `physicsEnabled = false` — нет лишних position-пакетов
- Анти-таймаут: рандомный look-пакет каждые 32–55 сек (без дрейфа угла)
- View distance = 2 — минимум трафика чанков
- `disableChatSigning` — без подписей чата
- Стаггер 450 мс между ботами при старте

### Чат / Broadcast (исправления)
- Очередь `chatSafe` привязана к сессии бота — старые очереди не протекают
- Очереди чистятся при дисконнекте
- Broadcast: стаггер `chatGapMs / 4` между ботами (100–400 мс), ответ клиенту сразу
- `/api/bots/:id/chat` теперь тоже через очередь (не прямой `mc.chat`)
- `settings`-пакет с fallback для разных версий протокола

---

## Инструменты

### `tools/1.exe` — MC Server Monitor (C++)
```
1.exe play.example.com 25565 http://localhost:3000 10
```
SLP-пинг сервера каждые N сек → постит `{online, rtt, players, max, motd, downStreak}` в `/api/mc-status`.
На дашборде: живая плашка **MC** (зелёная/красная с пингом и игроками).

### `tools/agent.py` — Bot Optimizer (Python)
```
python tools/agent.py --host http://localhost:3000 --interval 30 --stale-min 10
```
- Перезапускает зависших ботов (онлайн > N мин, реликвий = 0)
- Триггерит reconnect-all для офлайн-ботов
- Постит статус в `/api/agent-status` → плашка **Агент** на дашборде

### `tools/fast_checker.exe` — Проверка аккаунтов (C++)
Многопоточная проверка через raw TCP, 5–10× быстрее Python.

### `tools/stats_monitor.py` — Монитор в терминале
Живой дашборд в консоли, автореконнект при массовом офлайне.

---

## Настройки (`/settings.html`)

| Параметр | По умолчанию | Описание |
|---|---|---|
| `chatGapMs` | 600 мс | Пауза между командами одного бота |
| `startStaggerMs` | 450 мс | Пауза между ботами внутри волны |
| `waveSize` | 10 | Размер волны |
| `waveDelayMs` | 4000 мс | Пауза между волнами |
| `warpTimeoutMs` | 8000 мс | Таймаут телепорта |
| `afkWalkMs` | 3200 мс | Длительность ходьбы в AFK |
| `shopOpenTimeoutMs` | 4000 мс | Таймаут открытия /shop |
| `shopClickTimeoutMs` | 1200 мс | Таймаут клика в магазине |
| `freeSlotDelayMs` | 250 мс | Задержка клика /free |
| `antiTimeoutMinSec` | 32 с | Мин. интервал поворота |
| `antiTimeoutMaxSec` | 55 с | Макс. интервал поворота |
| `chunkGcMs` | 30000 мс | Интервал чистки чанков |

Сохраняются в `settings.json`, применяются без перезапуска.

---

## Темы

| Тема | Цвет |
|---|---|
| Classic | 🔵 Синий |
| ExosWare | 🟢 Неон |
| Fallen | ⚫ Графит |
| Svintus | 🟠 Жар |

Синхронизируется между всеми страницами. Переключатель — цветные точки в навбаре.

---

## Импорт ботов

Формат `bots.txt`:
```
# комментарий
username1:password1
username2:password2
```
Кнопка **📥 Импорт** на дашборде.

---

## API

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/bots/broadcast` | Команда всем ботам |
| POST | `/api/bots/:id/pasxa` | /pasxa для бота |
| POST | `/api/bots/:id/case` | Открыть кейс |
| POST | `/api/bots/:id/pasxa-case` | Пасха + кейс |
| POST | `/api/bots/pasxa-case/all` | Пасха+кейс всем |
| POST | `/api/bots/:id/shop/click` | Купить `{slot, qty}` |
| GET | `/api/mc-status` | Статус MC сервера |
| GET | `/api/agent-status` | Статус агента |
| GET | `/api/settings` | Настройки |
| POST | `/api/settings` | Сохранить |
| POST | `/api/settings/reset` | Сброс |
| GET | `/api/bots/export` | Экспорт bots.txt |

---

## Сборка C++ (Windows MinGW)

```bash
g++ -O2 -std=c++17 tools/1.cpp           -o tools/1.exe           -lws2_32
g++ -O2 -std=c++17 tools/mc_monitor.cpp  -o tools/mc_monitor.exe  -lws2_32
g++ -O2 -std=c++17 tools/fast_checker.cpp -o tools/fast_checker.exe -lws2_32
```
