# Surviver — кооперативный TABS-style horde survival (лабы «Сетевые технологии»)

Мультиплеерная survival-игра в реальном времени (2+ игроков). Игроки добывают ограниченные ресурсы,
строят периметр вокруг Ядра (Core), затем отбиваются от волн процедурных «пьяных» TABS-существ.

- **Лаба №1 (Server)** — авторитарный сервер: фиксированный тик 20 Гц, WebSocket (`ws`), валидация
  пакетов, серверная физика/коллизии, ИИ орды, `AntiCheatEngine`.
- **Лаба №2 (Client)** — тонкий 3D веб-клиент (Three.js): Client-Side Prediction + Server Reconciliation
  для своего игрока, Entity Interpolation для остальных, сборка в Electron (Windows portable).

## Архитектура

```
┌──────────── client (Vite + Three.js, 60–120 FPS) ────────────┐        ┌──────── server (Node.js + ws, 20 TPS) ────────┐
│ InputSampler 20 Гц ─► PLAYER_INPUT{seq, mx, mz, yaw, px, pz} │──WS──► │ Connection: rate-limit ► JSON.parse ► validate │
│ Predictor: stepPlayer() локально, буфер неподтверждённых     │        │ Room.queueInput()                              │
│ Reconcile: state(ack) + replay pending inputs                │        │ Room.tick(): inputs ► AntiCheat ► physics ►    │
│ Interpolator: renderTime = serverTime − 100 мс, lerp         │ ◄──WS──│   mobs AI ► turrets ► phases ► snapshot        │
│ Renderer: TabsCharacterMesh, процедурная wobble-анимация      │        │ AccountStore (JSON + scrypt), Admin REST API   │
└──────────────────────────────────────────────────────────────┘        └────────────────────────────────────────────────┘
                          shared/: протокол, валидаторы, константы, stepPlayer(), CollisionWorld
```

- **Authoritative Server 20 Hz**: всё состояние (позиции, HP, инвентарь, постройки, мобы) живёт на сервере.
  Клиент шлёт только интенты. Тик = 50 мс (`setInterval` + компенсация дрейфа, см. `server/src/game/GameLoop.ts`).
- **Dumb/Interpolating Client 60+ FPS**: рисует интерполированное прошлое для чужих сущностей и
  предсказанное настоящее для себя. Физика движения игрока — одна функция `stepPlayer()` в `shared/`,
  выполняется одинаково на клиенте и сервере (детерминированное предсказание).
- Коллизии: круг/AABB в `CollisionWorld` (spatial hash). Постройки — на сетке 2×2 м.

### Монорепозиторий

| Путь       | Что внутри |
|------------|-----------|
| `shared/`  | `protocol.ts` (типы пакетов), `validation.ts` (рукописные схемы), `constants.ts`, `physics.ts` (`stepPlayer`, `CollisionWorld`), `rng.ts` (сидированный mulberry32) |
| `server/`  | `net/` (WS-сервер, `Connection`, rate limiter) — **сетевой слой**; `game/` (Room, World, системы, ИИ) — **бизнес-логика**; `anticheat/`; `accounts/`; `http/` (статика + REST + админка) |
| `client/`  | `net/` (NetClient, Predictor, Interpolator, LagSimulator); `render/` (сцена, TabsCharacterMesh, меши); `ui/` (HUD, сетевой монитор, тест античита); страницы `index.html` (сайт), `play.html` (игра), `admin.html` (админка) |
| `desktop/` | Electron-обёртка + `electron-builder` (не workspace, ставится отдельно при `build:win`/`build:mac`) |
| `deploy/`  | `nginx.conf` для `surviver.yunix.software` |

## Сетевой протокол (v1)

Транспорт: WebSocket, путь `/ws`, текстовые JSON-фреймы, формат — плоский объект `{ "type": "...", ...payload }`.
Лимит фрейма 4 КБ (`maxPayload`). Каждый входящий фрейм: rate-limit → `JSON.parse` → `validateClientMessage()`
(проверка типа, обязательных полей, диапазонов, конечности чисел, длины строк). Невалидный фрейм отбрасывается
и логируется как нарушение `MALFORMED_PACKET`.

### Client → Server

| type | payload | назначение |
|------|---------|-----------|
| `HELLO` | `v:number` (версия протокола), `name:string(1..16)`, `token?:string` | рукопожатие; токен аккаунта опционален (иначе гость) |
| `JOIN_ROOM` | `roomId?:string` | войти в комнату (без id — quick join / создание) |
| `LEAVE_ROOM` | — | выйти в лобби |
| `PLAYER_INPUT` | `seq:uint`, `ts:number`, `mx,mz:[-1..1]`, `yaw:number`, `px,pz:number` (предсказанная позиция после применения) | интент движения, 20 шт/с |
| `INPUT_HARVEST` | `seq`, `ts`, `targetId:uint` | ударить ресурс |
| `INPUT_ATTACK` | `seq`, `ts`, `targetId:uint` | ударить моба |
| `INPUT_BUILD` | `seq`, `ts`, `kind:'wall'\|'spikes'\|'turret'`, `gx,gz:int` (клетка сетки) | постройка |
| `READY` | `ready:boolean` | голосование «Готов» (все готовы → орда раньше) |
| `DEBUG_COMMAND` | `cmd:'skip_phase'\|'give_resources'\|'spawn_wave'\|'heal_core'` | чит-команды для демонстрации (только если `ALLOW_DEBUG=1`) |
| `CHAT` | `text:string(1..120)` | чат комнаты |
| `PING` | `id:uint`, `ts:number` | замер RTT |

### Server → Client

| type | payload | когда |
|------|---------|-------|
| `WELCOME` | `clientId`, `name`, `account:{username}\|null`, `tickRate`, `serverTime`, `debugAllowed` | ответ на `HELLO` |
| `ROOM_JOINED` | `roomId`, `playerId`, `seed`, `mapHalf`, `config`, `world:{resources[], buildings[], core}` | полный стейт при входе |
| `WORLD_STATE_SNAPSHOT` | `tick`, `time`, `ack` (последний обработанный `seq` получателя), `players[]`, `mobs[]`, `buildings?[]`/`removedBuildings?[]` (дельта), `resources?[]`/`removedResources?[]` (дельта), `core`, `inv`, `ev[]` (события: hit/harvest/shot/death/build…) | каждый тик (20 Гц) |
| `GAME_PHASE_UPDATE` | `phase:'prep'\|'horde'\|'ended'`, `endsAt` (serverTime мс \| null), `wave`, `totalWaves`, `intermission`, `ready`, `players` | при смене + 1 раз/с |
| `SERVER_RECONCILE` | `seq`, `x`, `z`, `reason` | жёсткая коррекция (rubberbanding) после нарушения |
| `ANTICHEAT_VIOLATION` | `kind`, `message`, `severity:'low'\|'medium'\|'high'`, `action:'dropped'\|'clamped'\|'corrected'\|'kicked'`, `tick` | нарушитель получает лог нарушения |
| `GAME_OVER` | `result:'victory'\|'defeat'`, `wave`, `stats[]` | конец матча |
| `CHAT` | `from`, `text`, `system?` | чат/системные сообщения |
| `PONG` | `id`, `ts` (эхо), `serverTime` | ответ на `PING` |
| `ERROR` | `code`, `message` | ошибки протокола/лобби |

Компактные сущности в снапшоте (числа округлены до 0.01):
`player {id,name,x,z,yaw,hp,dead,act,color}`, `mob {id,k(0 runner|1 grunt|2 giant),x,z,yaw,hp,mhp,a}`,
`building {id,k,gx,gz,hp,mhp}`, `resource {id,k(0 tree|1 rock|2 iron),x,z,amt,max}`.

### Синхронизация
- **Prediction**: клиент применяет `stepPlayer()` сразу, хранит неподтверждённые инпуты.
- **Reconciliation**: при снапшоте берёт серверную позицию + `ack`, выкидывает подтверждённые инпуты,
  переигрывает оставшиеся. Визуальная ошибка гасится экспоненциально (error smoothing).
- **Interpolation**: буфер снапшотов; рендер на `estServerTime − 100 мс`, lerp позиций/углов между двумя соседними.
- **LagSimulator** на клиенте: искусственная задержка (0–500 мс) и потеря снапшотов — для демонстрации.

## Античит (чек-лист)

- [x] **Speedhack (вектор)**: `|(mx,mz)| > 1` → clamp + `SPEEDHACK`.
- [x] **Speedhack (частота инпутов / time dilation)**: сервер симулирует 1 инпут/тик, копит кредит до 5 с (`AC.MOVE_BANK_TICKS`) — пачка после лаг-спайка догоняется без наказания (≤ 4 инпута/тик, плавно); очередь > 6 с инпутов → `SPEEDHACK`, лишние отбрасываются.
- [x] **Speed/Teleport (v·Δt)**: шаг заявленной позиции `px,pz` больше `v·Δt·3` и расхождение > 2 м → `SPEEDHACK`/`TELEPORT` + `SERVER_RECONCILE`; после коррекции заявки не судятся, пока клиент не сойдётся (in-flight инпуты несут старое предсказание), коррекция переотправляется раз в 1.5 с без штрафа.
- [x] **Ресурсы**: инвентарь только на сервере; постройка без баланса → `INSUFFICIENT_RESOURCES`.
- [x] **Remote Build**: дистанция игрок↔клетка > `BUILD_RANGE` → `BUILD_OUT_OF_RANGE`; занятая/запрещённая клетка → `BUILD_BLOCKED`.
- [x] **Far Reach / Kill Aura**: евклидово расстояние до цели > `REACH` → `OUT_OF_RANGE`.
- [x] **Rapid Fire**: удар/добыча чаще кулдауна → `COOLDOWN`.
- [x] **Rate limiting**: token bucket на соединение (60 msg/s, burst 300) → `RATE_LIMIT`; злостный флуд → kick.
- [x] **Packet sanitization**: размер ≤ 4 КБ, валидный JSON, схема по типу → `MALFORMED_PACKET`.
- [x] **Replay/порядок**: `seq` должен строго расти → `SEQ_REPLAY`.
- [x] Счёт нарушений (score, затухание 10/с, порог 600) → kick; повторы внутри окна троттлинга отбрасываются, но очков не добавляют. Heartbeat: разрыв только после ~15 с полной тишины. Игроку нарушения не показываются плашками — только в панели F2. Все нарушения пишутся в лог сервера и в админку.
- [x] Debug-панель клиента «Тест античита» отправляет читерские пакеты в обход честной логики.

## Правила кода

- Строгий TypeScript (`strict`, `noUncheckedIndexedAccess`), без `any` (кроме границы `JSON.parse` → `unknown`).
- **Сетевой слой отделён от бизнес-логики**: `server/src/net/*` знает про сокеты/байты, но не про игру;
  `server/src/game/*` не импортирует `ws`. Связь — через интерфейс `PlayerLink` (`send(msg)`).
  На клиенте аналогично: `client/src/net/*` vs `client/src/render/*`, `client/src/ui/*`.
- Все типы сообщений и константы — только в `shared/`. Новое сообщение = тип в `protocol.ts` + валидатор в `validation.ts` + строка в таблице выше.
- Числа из сети никогда не доверенные: проверка `Number.isFinite`, диапазонов, целочисленности.
- Без внешних 3D-ассетов: вся геометрия процедурная.
- Коммиты небольшие, по итерациям.

## Команды

```bash
npm install                 # установить workspaces
npm run dev:server          # сервер :8080 (tsx watch), WS: ws://localhost:8080/ws
npm run dev:client          # Vite :5173, проксирует /ws и /api на :8080
npm run typecheck           # tsc --noEmit по всем пакетам
npm run build               # client/dist + server/dist
npm start                   # прод: node server/dist/index.js (отдаёт и статику клиента)
npm run test:bots           # headless-боты: движение, добыча, постройка, проверка античита
npm run build:win           # Electron portable .exe (desktop/dist), клиент ходит на wss://surviver.yunix.software/ws
npm run build:mac           # Electron .dmg arm64 + x64 (ad-hoc подпись в desktop/adhoc-sign.cjs, без Apple Developer ID)
npm run deploy              # rsync на `ssh ubuntu` + docker compose up -d --build
```

Переменные окружения сервера: `PORT` (8080), `PREP_SECONDS` (600), `TOTAL_WAVES` (5), `ALLOW_DEBUG` (1),
`ADMIN_TOKEN` (если не задан — генерируется и печатается в лог), `DATA_DIR` (./data).

## Деплой

- Хост: `ssh ubuntu` (rootless podman + `docker compose`), каталог `~/surviver`, `.env` с `ADMIN_TOKEN` создаётся там один раз (`chmod 600`, не в git).
- `npm run deploy` (`scripts/deploy.sh`): rsync исходников → `docker compose up -d --build` → health-check → загрузка `desktop/dist/Surviver-portable.exe` в volume (`/data/downloads`, отдаётся по `/downloads/…`).
- Контейнер `surviver` слушает `127.0.0.1:8085` → Nginx `surviver.yunix.software` (`deploy/nginx.conf`):
  `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` для `/ws`.
- Nginx + SSL (нужен sudo с паролем, делается вручную один раз): `ssh -t ubuntu 'bash ~/surviver/deploy/setup-nginx.sh'`.
  На хосте `nginx.conf` **не** подключает `sites-enabled/` (все vhost'ы inline) → скрипт кладёт конфиг в `sites-available/` и добавляет одну строку `include` в `http {}` (бэкап, откат при провале `nginx -t`). Сертификат — `certbot certonly`, SSL прописан в `deploy/nginx.conf` вручную.
- Грабли: в терминале VSCode задан `ELECTRON_RUN_AS_NODE` → локальный запуск собранного .app через `env -u ELECTRON_RUN_AS_NODE`.
- Грабли: на хосте `~/.curlrc` направляет curl через VPN-прокси → для локальных проверок `curl -q --noproxy '*' …`.
- На сервере есть чужие сайты (gigantt.pro, casino.yunix.software и др.) — их конфиги не трогать.
- Проверка прод-сервера ботами: `ssh -N -L 8095:127.0.0.1:8085 ubuntu &` → `npx tsx server/scripts/bots.ts ws://localhost:8095/ws`.
- URL: https://surviver.yunix.software, WS: `wss://surviver.yunix.software/ws`, админка: `/admin.html`.
