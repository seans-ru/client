# Discord Rich Presence + Join

## Цель

Показывать в Discord, что смотришь прямо сейчас (фильм или сериал), в режиме **Listening**,
с прогрессом просмотра в минутах и постером. В комнате совместного просмотра — party
«N из 10» и кнопка **Присоединиться**: друг жмёт её → у него запускается Seans → он попадает
в ту же комнату.

## Зафиксированные решения

| Поле | Значение |
|---|---|
| Application ID | `1565313293747494932` (константа `DISCORD_APP_ID`) |
| Activity type | `Listening` (по запросу; для «Watching …» — одна строка в билдере) |
| `party.id` | код комнаты (`[A-Z2-9]{8}`) — каждая комната своя party |
| `party.size` | `[число участников, max]`, участники — из room state |
| `party.max` | `PARTY_MAX_BY_PLAN = { free: 10, plus: 20, pro: 50 }`, неизвестный план → 10 |
| `join_secret` | `base64url("{inviter_user_id}:{room_code}:{nonce}")` |

**join_secret** — три части через `:` (форма из примера `MTI4NzM0OjFpMmhuZToxMjMxMjM=`
→ `128734:1i2hne:123123`, но с реальными значениями):

- `inviter_user_id` — id пользователя, у которого нажали кнопку (из `useAuth().user.id`);
- `room_code` — реальный код комнаты, по нему идёт роутинг;
- `nonce` — случайная строка на комнату (генерируется один раз на сессию комнаты,
  стабильна между обновлениями активности) — секрет непредсказуем и не равен голому коду.

Кодировка — **base64url без padding** (переживает транзит через URL/argv при холодном
запуске). Декодер щадящий: принимает base64url, обычный base64 (с/без `=`), голый код
комнаты и `seans://room/CODE`. Невалидное — молча игнорировать.

Вне комнаты (соло-просмотр) активность показывается **без** `party`/`join_secret`
(кнопки Join нет — заходить не в комнату). В комнате — с ними, `instance: true`.

## Payload активности

`details` / `state` (Discord показывает их под «Listening to Seans»):

- `details` = название медиа: «Дюна: Часть вторая» / «Офис» (из playback/media detail);
- `state` = фильм: `«42 мин из 145 мин»`; сериал: `«S01E03 · 22 мин из 42 мин»`;
  на паузе: `«Пауза · …»`. Минуты — округлённые (`Math.round(sec/60)`).

Таймстемпы (прогресс-бар у Listening-активностей):

- играет: `start = now_ms - position_ms`, `end = start + duration_ms` — бар тикает сам,
  частые апдейты не нужны;
- пауза: таймстемпы убираем (иначе бар дрейфует), прогресс остаётся текстом в `state`.

Ассеты:

- `large_image` = постер: **прямой URL** (`poster_url`) как есть — Discord-клиент
  сам проксирует картинки из URL, пришедших через локальный RPC (по документации
  presence `external-assets` нужен только для gateway/headless-присутствия).
  Проверено на практике WinYandexMusicRPC (pypresence → IPC, обложка — raw URL).
  Если постера нет — фолбэк на статический ключ `seans` (арт в Developer Portal);
- `large_text` = название, `small_image` = `seans`, `small_text` = «Seans».

Пуш апдейтов: немедленно на значимые изменения (смена файла/эпизода, play/pause, seek,
вход/выход из комнаты, смена состава, загрузка постера) + корректирующий refresh раз в
30 с через `queue_activity` (встроенный рейт-лимит крейта). Discord не запущен / ошибка
IPC — молча логируем, плеер не блокируется.

## Join-flow

Два пути, оба закрываются:

1. **Тёплый** (Seans запущен): друг жмёт «Присоединиться» → его Discord шлёт
   `ACTIVITY_JOIN` (секрет) в его же Seans через IPC → `on_activity_join` в
   `discord.rs` → emit `discord://join` + буфер `pending_join` → `useDiscordJoin`
   декодирует секрет → `#/room/{code}` → существующий флоу комнаты
   (`GET /api/rooms/{code}` → WS join).

2. **Холодный** (Seans закрыт): Discord запускает зарегистрированную команду
   `discord-{APP_ID}://…` → Windows стартует `seans.exe` с этим URL в argv.
   Регистрация протокола — клон `Discord_Register` из discord-rpc:
   `HKCU\Software\Classes\discord-{APP_ID}` (`URL Protocol` = "", `shell\open\command`
   = `"<путь к seans.exe>"`), пишем идемпотентно на старте (после обновления путь
   освежится). Извлечение секрета из argv — щадящее (path/query протокола, голый
   base64, `seans://…`); точный формат URL сверяем на тест-прогоне и дополняем парсер.
   Single-instance (`urls_from_argv`) расширяется на `discord-` аргументы.
   Гонка «секрет пришёл раньше, чем JS подписался»: Rust хранит `pending_join`,
   команда `discord_take_pending_join` забирает его на маунте App (как паттерн
   post-open snapshot у плеера).

Кнопка при полной пати превращается в «Ask to Join» → `on_activity_join_request`:
**авто-принимаем** (`send_activity_join_invite(user_id)`) — комната и так открытая
по share-ссылке. Заявитель получает `ACTIVITY_JOIN` со старым секретом.

Если друг не залогинен: `useDiscunJoin` держит код до `status === "authenticated"`
(без правок auth-флоу), потом роутит в комнату.

## Файлы

Rust (`src-tauri/`):

- `Cargo.toml` — `discord-presence = "3.2"`; `windows-sys` + фича `Win32_System_Registry`;
- `src/discord.rs` **новый** — `DISCORD_APP_ID`, поток `Client::new(id).start()`,
  `set_activity`/`clear_activity`/`queue_activity`, `on_activity_join` +
  `on_activity_join_request` (авто-approve) + явный `subscribe(Event::ActivityJoin)`,
  буфер `pending_join`, команды `discord_set_activity` / `discord_clear_activity` /
  `discord_take_pending_join`, `register_discord_launcher()` (реестр, клон
  `Discord_Register`);
- `src/lib.rs` — `mod discord`, init в `.setup()` (старт клиента + регистрация
  протокола + скан `std::env::args()`), команды в `invoke_handler`, `urls_from_argv`
  ловит `discord-` аргументы (single-instance), best-effort `clear_activity` на выходе.

Frontend (`src/`):

- `src/features/discord/joinSecret.ts` **новый** — `encodeJoinSecret`, `decodeJoinSecret`,
  `extractRoomCode` (чистые функции), `getOrCreateJoinNonce(roomCode)`;
- `src/features/discord/discordActivity.ts` **новый** — `buildDiscordActivity()` (чистый
  билдер payload'а), `PARTY_MAX_BY_PLAN`, форматтер минут/`SxxEyy`;
- `src/features/discord/discordApi.ts` **новый** — invoke-обёртки + подписка
  `discord://join`;
- `src/features/discord/useDiscordRpc.ts` **новый** — хук: инпуты (title/episode/position/
  pause/duration/poster/room/user) → payload → Rust; clear на unmount;
- `src/features/discord/useDiscordJoin.ts` **новый** — App-уровень: события + pending →
  `#/room/{code}` (ждёт авторизации);
- `src/features/discord/index.ts` **новый** — реэкспорты;
- `src/screens/PlayerScreen.tsx` — опциональный проп `room?: { code, members }`,
  монтирует `useDiscordRpc`;
- `src/screens/RoomScreen.tsx` — передаёт `room={{ code, members: room.state.members.length }}`;
- `src/App.tsx` — монтирует `useDiscordJoin`.

Докс:

- `README.md` — раздел «Discord RPC» (что показывается, join-flow, Application ID,
  опциональные Art Assets в Developer Portal);
- `docs/av-checklist.md` — пункт про регистрацию протокола `discord-{APP_ID}`
  (стандартная регистрация приложения, как уже сделано для `seans://`).

## Тесты (Vitest, чистые функции)

- `tests/joinSecret.test.ts` — roundtrip encode/decode; щадящий decode (base64url,
  обычный base64 с padding, голый код, `seans://room/CODE`); отклонение невалидных кодов;
- `tests/discordActivity.test.ts` — Listening-тип, математика таймстемпов (start/end от
  position/duration), поведение на паузе, `SxxEyy`, партия/секрет только в комнате,
  `party.max` по планам, кодирование постера в `mp:external/`, формат минут.

## Проверка

1. `npm run typecheck` && `npm test`;
2. `cargo check` в `src-tauri` + `npm run tauri dev` (смоук: RPC поднимается без Discord —
   не падает);
3. Ручной прогон с двух Discord-аккаунтов:
   - A смотрит фильм соло → «Listening to Seans», название, бар прогресса, постер;
   - A открывает комнату → появляется «Присоединиться», «1 из 10» (состав растёт);
   - B жмёт Join при запущенном Seans → попадает в `#/room/{CODE}`;
   - B жмёт Join при закрытом Seans → Seans стартует и попадает в комнату;
   - пауза/play у A → активность обновляется;
   - если постер не отрисовался — фолбэк на статический арт `seans`.

## Вне рамок

- Воспроизведение у гостя комнаты (файл — у хоста) — существующее ограничение продукта,
  join его не ухудшает: гость попадает в комнату;
- Кнопка Join вне комнаты (соло) — не делаем;
- Лимиты комнат на бэкенде — появятся позже, тогда `party.max` начнёт браться оттуда
  (сейчас — константа по планам);
- `spectate_secret` / кнопка «Смотреть» — не нужны.
