# Seans API: контракт бекенда vs клиент (seans-client)

Дата аудита: 2026-09-20  
Источники: `D:\projects\tedeshi\seans` (FastAPI) · `D:\projects\tedeshi\seans-client` (Tauri 2 + React)

Ниже — (1) контракт бекенда, (2) контракт клиента, (3) **список несоответствий** с рекомендуемой стороной фикса. Фиксы в клиенте **не применялись** — ждём решение.

---

## 1. Контракт бекенда (wire)

**Base:** `https://api.seans.tedeshi.ru` · Auth: `Authorization: Bearer <JWT>` · WS: `/ws/rooms/{code}?token=<JWT>`  
**Ошибки:** всегда `{"detail": "<string>"}` или 422 `{"detail": [{type, loc, msg, input}]}`.  
**ID:** UUID-строки. Списки — голые JSON-массивы. Пагинации нет, только `limit`.

### Auth
| Method | Path | Request | Response |
|--------|------|---------|----------|
| POST | `/api/auth/register` | `{email, password, display_name, invite_key}` | 201 `TokenResponse` |
| POST | `/api/auth/login` | `{email, password}` | `TokenResponse` |
| GET | `/api/auth/me` | — | `UserResponse` (с живым `used_bytes`) |
| POST | `/api/auth/invite-keys` | — | 201 `{key, created_at}` (нужен `can_invite`) |

`UserResponse`: `{id, email, display_name, is_admin, can_invite, plan, plan_expires_at, quota_bytes, used_bytes, created_at}`  
`TokenResponse`: `{access_token, token_type="bearer", user}`

### Catalog / media
| Method | Path | Response |
|--------|------|----------|
| GET | `/api/search?q=` | `MediaSearchResult[]` (rate limit 2 req/s) |
| GET | `/api/catalog/chart?type=&limit=` | `MediaSearchResult[]` |
| GET | `/api/media/{id}` | `MediaDetail` |
| GET | `/api/media/{id}/releases?refresh=&…jacred filters` | `TorrentReleaseResponse[]` |
| GET | `/api/media/{id}/episodes?season=` | `{media_id, title, kind, episodes[]}` |
| GET | `/api/media/{id}/playback?season=&episode=` | playback descriptor + `stream` |
| PUT | `/api/media/{id}/review` | `{score:1..10, review?}` → `ReviewResponse` |
| GET | `/api/media/{id}/reviews` | `ReviewResponse[]` (**без auth**) |

`MediaSearchResult`: `{id, kp_id, tmdb_id, title, year, poster_url, kp_type, rating_kp}`  
⚠ `rating_kp` — **Decimal → JSON string** (`"8.7"`) или `null`. `kp_id`/`year` — `int|null`.  
`MediaDetail` = search + `{original_title, overview, genres[], updated_at}`. **`user_review` не возвращается** (хотя T5.3 в спеке обещал).  
`TorrentReleaseResponse`: `{id, tracker, title, size_bytes, seeders, leechers, quality, voiceover, magnet}` — **без `file_paths`**.  
`quality`/`voiceover`/`magnet` — nullable.

**Playback** (hand-built dict):
```
{media_id, episode_id, title, kind, season, episode, episode_end, duration_ms: null,
 video: {task_file_id, file_path, size_bytes, container, s3_key, url|null},
 audio_tracks[]: {id, language, flags, label, s3_key, embedded, task_file_id, url|null},
 subtitle_tracks[]: аналогично,
 stream: null | {ready, complete, size_bytes, max_seekable_bytes, percent_*,
                 segment_size, segments_uploaded, segments_available,
                 segments[]: {index, start, end, available, url|null}, index_url}}
```
Нет: `file_id` (только `video.task_file_id`), `catalog`, `video.primary`, `track_index`, `title` у треков.

### Tasks / library / files
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/tasks` | `{torrent_release_id, file_paths[]}` → 201 `TaskResponse`. **`file_paths` обязателен, но игнорируется** |
| GET | `/api/tasks?active=` | `TaskDetailResponse[]` |
| POST | `/api/tasks/{id}/cancel` | → `TaskDetailResponse` (только queued/assigned) |
| GET | `/api/library` | `[{library_item, media_item, files[], total_size, ready}]` |
| DELETE | `/api/library/{id}?delete_files=` | 204 |
| GET | `/api/files/{task_file_id}/url` | `{url, expires_in}` — **только `status=="uploaded"`** |

`TaskResponse` (create): `{id, status, reserved_bytes, progress_pct, speed_bps, stage, created_at}` — **без `updated_at`/`error`**.  
`TaskDetailResponse` (list/cancel): + `{media_id, task_file_id, error, updated_at}`.  
`stage: str|null`. Статусы task: `queued|assigned|downloading|uploading|completed|failed|canceled`.  
Library `files[]`: `{id, path, size_bytes, status: pending|uploaded, season, episode, episode_end, kind, primary}`.  
Library `media_item` включает `tmdb_id`. Datetime здесь в формате `+00:00` (не `Z`).

### History
| Method | Path | Request | Response |
|--------|------|---------|----------|
| PUT | `/api/history` | `{task_file_id, position_sec, duration_sec}` | `HistoryResponse` (Decimal **string**) |
| GET | `/api/history?limit=` | — | **вложенный** continue-watching |

`HistoryResponse`: `{id, task_file_id, position_sec, duration_sec, completed, updated_at}`  
`completed` = `position >= duration * 0.95` (сервер).

**GET /api/history отдаёт ТОЛЬКО `completed==false`** и **другой shape**:
```json
[{
  "history": { "id", "task_file_id", "position_sec", "duration_sec", "completed", "updated_at" },
  "media":   { "id", "title", "poster_url" },
  "file":    { "id", "path" },
  "progress_pct": 3
}]
```

### Rooms
| Method | Path | Response |
|--------|------|----------|
| POST | `/api/rooms` | 201 `{id, code, ws_url}` — `ws_url` **относительный** `/ws/rooms/{code}` |
| GET | `/api/rooms/{code}` | `{room, members}` (**без auth**) |

```json
"room":   { "id", "code", "host_user_id", "is_playing", "current_position", "created_at" }
"members": [ { "user_id" } ]
```
**Нет** `ws_url`, **нет** `task_file_id`, **нет** `name` у members.

WS `/ws/rooms/{code}?token=`:
- C→S: `join` / `heartbeat{position}` / `state{action,position}` / `sync_request` / `leave`
- S→C: `room_state{host_id,position,is_playing,ts}` / `state{action,position,by}` / `member_joined|left{user:{user_id,name}}` / `error{detail}`
- Close: 4001 unauthorized, 4004 room not found. Host-only `state`.

### Прочее (клиентом не используется)
`/api/admin/*`, `/api/arr/*`, `/api/worker/*`, `/api/dev/s3-check`, `GET /healthz`.

---

## 2. Контракт клиента (как клиент видит API)

**Base:** `https://api.seans.tedeshi.ru` (`VITE_API_BASE_URL`) · `Authorization: Bearer <JWT>`  
**Ошибки:** клиент парсит `message` → `error` (**не `detail`**).  
**Числа:** `toNumber()` принимает number | numeric string.  
**Login:** web OAuth `https://seans.tedeshi.ru/auth?redirect_uri&state` → `seans://auth/callback?access_token&state`. Пароли в клиент не вводятся.

Клиентские обёртки: `src/api/endpoints.ts` (20 REST + WS).  
Типы: `src/api/types.ts`, `src/api/playback.ts`, нормализация `src/api/parsing.ts`.

Ключевые ожидания клиента (отличные от бекенда):

| Где | Клиент ждёт | Бекенд отдаёт |
|-----|-------------|----------------|
| `GET /api/history` | плоский `HistoryResponse[]` | `[{history, media, file, progress_pct}]`, только incomplete |
| ошибки | `{message}` / `{error}` | `{detail}` |
| `room` | `{id, code, ws_url, task_file_id?, host_id?}` | `{id, code, host_user_id, is_playing, current_position, created_at}` |
| `members[]` | `{user_id, name?}` | `{user_id}` |
| releases | опц. `file_paths` | нет |
| `MediaDetail` | опц. `user_review` | нет |
| `TaskResponse` | `updated_at`, `error?` | у create — нет |
| playback | `file_id`, `catalog`, `video.primary` | только `video.task_file_id` |
| create task | `file_paths[]` влияет на загрузку | сервер игнорирует |

WS-протокол клиента **совпадает** с сервером (snake_case на проводе → camelCase внутри).

---

## 3. Несоответствия (на решение)

Приоритет: **P0** — сломано сейчас · **P1** — дыра в фиче · **P2** — косметика/типы · **P3** — на будущее.

### P0 — сломанная функциональность

#### H1. `GET /api/history` — несовместимая форма ответа
- **Бекенд:** `[{history:{…}, media:{…}, file:{…}, progress_pct}]`, фильтр `completed==false`.
- **Клиент:** `normalizeHistoryList` ждёт плоские `HistoryResponse[]` (`id`, `task_file_id`, `position_sec`, …).
- **Эффект:** `HistoryScreen` / `historyResume` / continue-watching получают мусор (`id=0`, `task_file_id=0`, `position=0`). Resume позиции и список «Продолжить просмотр» не работают.
- **Также:** веб-фронт (`seans/frontend/js/app.js`) тоже читает плоский `item.task_file_id` — т.е. и он мимо.
- **Фикс (выбрать сторону):**
  - **A (рекомендую, клиент):** парсить вложенную форму, map `history`→flat + опционально `media`/`file`/`progress_pct` в типы (удобно для UI — title/poster уже приходят).
  - **B (бекенд):** вернуть плоский массив `HistoryResponse[]` (или отдельный endpoint).
  - **C:** поддержать оба shape в клиенте (толерантный парсер).

#### H2. Ошибки API: `detail` vs `message`/`error`
- **Бекенд:** FastAPI `{"detail":"…"}` / 422 `{"detail":[…]}`.
- **Клиент** (`src/api/client.ts` `readErrorMessage`): ищет только `message` и `error`.
- **Эффект:** UI показывает сырой JSON вместо «Invalid credentials» и т.п. (веб-фронт парсит `detail` правильно — есть образец).
- **Фикс:** клиент — добавить `detail` (string) + `detail[0].msg` для 422. Чистый баг, чинить однозначно.

#### H3. `GET /api/rooms/{code}` — нет `task_file_id` (и `ws_url`)
- **Бекенд room:** `{id, code, host_user_id, is_playing, current_position, created_at}`.
- **Клиент** ждёт `task_file_id` чтобы открыть плеер гостю; `host_id` подхватывается alias'ом `host_user_id` (ок).
- **Эффект:**
  - **Хост:** обходится — `LibraryList` кладёт fileId в `sessionStorage` (`seans.room.file.{code}`).
  - **Гость по deep link `seans://room/{CODE}`:** файла нет → плеер не из чего открыть. Комната как watch-party для гостей не работает.
- **`ws_url`:** в detail его нет → `""` → клиент сам собирает `wss://api…/ws/rooms/{code}` (ок). Но `POST /api/rooms` возвращает относительный `ws_url: "/ws/rooms/CODE"`; если кто-то использует его как WebSocket URL напрямую — уедет на origin приложения, не на API.
- **Фикс (выбрать):**
  - **A (рекомендую, бекенд):** добавить в `room`: `task_file_id`, `ws_url` (желательно absolute `wss://…`), `host_id` (или оставить alias), members `name`.
  - **B (клиент):** гость не сможет играть без файла — лечится только бекендом/другим каналом (например WS `room_state` с `task_file_id`). Минимум в клиенте: не использовать относительный `ws_url` как есть.

#### H4. `POST /api/tasks` — `file_paths` игнорируется
- **Клиент** шлёт `{torrent_release_id, file_paths[]}`; UI умеет выбирать файлы (`buildTaskCreateBody`).
- **Бекенд** принимает `file_paths` (обязательное поле!) и **не использует**: worker claim всегда `"file_paths": []`, «Worker discovers files from torrent metadata».
- **Релизы** не отдают список файлов (`TorrentReleaseResponse` без `file_paths`; indexer не тянет file list).
- **Эффект:** file-picker — фикция; качается весь торрент. Пустой `file_paths: []` у клиента = «весь торрент» — случайно совпадает с поведением сервера.
- **Фикс:**
  - **A (продукт, бекенд+worker):** хранить `file_paths` на task, отдавать в `claim`, фильтровать manifest. Плюс endpoint/file-list у релиза (или magnet metadata).
  - **B (клиент):** убрать file-picker, всегда слать `[]`, честно писать «весь торрент».

---

### P1 — дыры в фичах / неточности контракта

#### M1. `MediaDetail.user_review` не возвращается
- Спека T5.3 обещала «full record + user review»; схема `MediaDetail` поля не содержит.
- **Клиент** уже готов: `resolveOwnReview(detail, reviews, userId)` — fallback на `GET …/reviews` + `current_id`. Работает, но extra round-trip.
- **Фикс:** бекенд — добавить `user_review` (или оставить как есть; клиент ок).

#### M2. `TaskResponse` (create) без `updated_at` / `error`
- `POST /api/tasks` → `TaskResponse` (без `updated_at`, `error`). `GET`/`cancel` → `TaskDetailResponse` (с ними).
- **Клиент** `normalizeTask` всегда пишет `updated_at: str(r.updated_at)` → `""`.
- **Эффект:** после create в списке задач пустая дата; `error` отсутствует (ок, optional).
- **Фикс:** бекенд — вернуть `TaskDetailResponse` из create (или клиент не требовать `updated_at`).

#### M3. Playback: нет `catalog` / `has_primary_video` / `file_id`
- **Клиент** строит `EpisodePicker` / next-episode из `playback.catalog.groups|files`. **Бекенд catalog не отдаёт.**
- `fetchMediaEpisodes` (`GET /api/media/{id}/episodes`) есть в клиенте, но **нигде не вызывается**.
- `has_primary_video` в списках эпизодов отсутствует — picker считает все playable.
- `file_id` на корне playback нет — клиент берёт `video.task_file_id` (ок).
- **Эффект:** нет UI выбора серий / next episode из playback; серии приходится как-то выбирать через library files (season/episode).
- **Фикс:**
  - **A (клиент):** вызывать `fetchMediaEpisodes` и строить picker из него (сервер уже умеет).
  - **B (бекенд):** отдавать `catalog` в playback (как ждёт клиент).

#### M4. `Room members[].name` — только в WS, не в REST
- REST `members: [{user_id}]`; имя приходит в `member_joined/left` или `room_state` не приходит.
- **Эффект:** список участников без имён до WS-событий (у хоста name есть в WS frames).
- **Фикс:** бекенд join `users.display_name` в REST members.

#### M5. `ws_url` относительный в `POST /api/rooms`
- `"/ws/rooms/CODE"`. Клиент сейчас использует `ws_url` из **detail** (пусто → derive). Риск, если начнут брать create-response.
- **Фикс:** бекенд — absolute `wss://…` (или клиент всегда derive / normalize relative → absolute).

#### M6. File URL только для `uploaded`
- `GET /api/files/{id}/url` → 404 «File not yet uploaded» для `pending`.
- **Клиент** на incomplete идёт через playback segments (ок). Fallback `fetchFileUrl` на pending упрётся в 404 с copy «подождите» — приемлемо.
- **Фикс:** не требуется, если progressive playback — основной путь.

---

### P2 — nullability / типы / косметика

| # | Тема | Бекенд | Клиент | Эффект | Фикс |
|---|------|--------|--------|--------|------|
| N1 | `kp_id`, `year` | `int\|null` | required `number` (`num()`→0) | год «0», kp_id 0 | клиент: `number\|null` |
| N2 | `original_title`, `overview` | `str\|null` | `string` (`""`) | пустая строка вместо null | клиент |
| N3 | `quality`/`voiceover`/`magnet` | `str\|null` | `string` | `""` в фильтрах/сортировке | клиент |
| N4 | `review` (ReviewResponse) | `str\|null` | `string` | `""` | клиент |
| N5 | `stage` (task) | `str\|null` | `string` | `""` | клиент |
| N6 | datetime `Z` vs `+00:00` | mixed | `new Date()` | ок | не трогать |
| N7 | `rating_kp` string | Decimal→`"8.7"` | `toNumber` | ок | не трогать |
| N8 | history PUT Decimal string | `"120.50"` | `toNumber` | ок | не трогать |
| N9 | `UserResponse` extras | `is_admin`, `plan`, `plan_expires_at` | не читает | можно показать тариф в Account | клиент (опц.) |
| N10 | library `files` extras | `kind`, `primary`, `episode_end` | не читает | нельзя фильтровать «только video» | клиент (опц.) |
| N11 | task list extras | `media_id`, `task_file_id` | defensive aliases | ок | — |
| N12 | search rate limit 2/s | 429 | debounce 250ms | редкие 429 | клиент: backoff |

---

### P3 — несоответствия спекам / прочее (вне wire-контракта)

| # | Тема | Комментарий |
|---|------|-------------|
| S1 | Account screen — placeholder | Нет invite-keys (`POST /api/auth/invite-keys`), плана, quota (quota есть в Settings). Спека v1-client обещала invite в Account. |
| S2 | `GET /healthz` | В спеке клиента есть, в коде не вызывается. |
| S3 | Admin / arr API | Бекенд есть, клиент не использует — норм для v1. |
| S4 | GET /reviews и GET /rooms/{code} без auth | Несоответствие «всё под JWT»; клиент всегда шлёт токен — ок. |
| S5 | Web frontend (`seans/frontend`) | Тоже мимо по history shape; `readErrorMessage` парсит `detail` (лучше клиента). |
| S6 | Спека T5.3 «+ user review» | Не реализовано на бекенде (см. M1). |
| S7 | `POST /api/worker/claim` при пустой очереди | `200` + `null`, а не 204 — воркеры; клиенту не важно. |

---

## 4. Что клиент уже покрывает толерантно (не баг)

- `toNumber` для rating/position/size/etc (string|number).
- Aliases: `host_user_id`→`host_id`, `file_list`/`files`→`file_paths`, `task_file_id`/`file_id`/…, `hostId`, camelCase playback.
- `stream: null` → waiting; `video.url: null` → не play.
- Пустые/не-array списки → `[]`.
- WS close 4001/4004, host-only state — совпадает.
- Относительный `ws_url` в detail отсутствует → derive из `API_BASE_URL`.
- File id для хоста комнаты — sessionStorage fallback.

---

## 5. Сводная таблица «что чинить в клиенте»

Если договорились «чиним только клиент» — реалистично:

| Фикс | Что в клиенте | Лечит |
|------|---------------|-------|
| **C1** | `readErrorMessage`: `detail` + `detail[0].msg` | H2 |
| **C2** | `normalizeHistoryList` под nested `{history,media,file,progress_pct}` + типы | H1 |
| **C3** | Room: не использовать относительный `ws_url`; для гостя — error copy «нужна ссылка с файлом» или ждать backend | H3 (частично) |
| **C4** | Убрать file-picker / всегда `file_paths: []`, copy «весь торрент» | H4 (честность) |
| **C5** | `updated_at` optional в `TaskResponse`; `normalizeTask` не материализовать `""` | M2 |
| **C6** | Вызывать `fetchMediaEpisodes` в EpisodePicker (fallback вместо catalog) | M3 |
| **C7** | Nullable-типы: `kp_id`, `year`, `original_title`, `overview`, `quality`, `voiceover`, `magnet`, `review`, `stage` | N1–N5 |
| **C8** | Account: invite-keys + plan/quota (опц.) | S1 |

Без правки бекенда **не лечатся**: H3 полностью (task_file_id для гостя), H4 полностью (реальный выбор файлов), M1 (user_review), M4 (имена в REST).

---

## 6. Решение (заполнить)

**Статус клиента (2026-09-20):** C1–C8 применены в `seans-client`.  
Промт для агента по бекенду: `docs/backend-fix-prompt.md`.

**Статус бекенда (проверено 2026-10-27 по коду + тестам `seans/tests`):**

| ID | Бекенд | Evidence |
|----|--------|----------|
| H3 | **done** | `RoomDetailResponse`: `task_file_id`, `ws_url`, `host_id`; members `name` (`rooms.py`, `schemas/room.py`, `test_rooms_detail.py`) |
| H4 | **done** | `tasks.file_paths` JSON + migration `008`; claim `file_paths`; `apply_manifest` filter (`test_create_task_persists_file_paths`) |
| M1 | **done** | `MediaDetail.user_review` (`media.py` + `test_rooms_ws.py`) |
| M2 | **done** | `POST /api/tasks` → `TaskDetailResponse` (`updated_at`, `media_id`) |
| M4 | **done** | `RoomMemberInfo.user_id` + `name` |
| M5 | **done** | `ws_url_for_room` absolute `ws(s)://` (`public_url.py`, `PUBLIC_API_BASE_URL`) |
| H1 | **done** | `HistoryContinueItem` official nested contract (`test_history_api.py`) |

**Остаток:**
- Web frontend `seans/frontend/js/app.js:1410` всё ещё читает плоский `item.task_file_id` — нужен апдейт парсера истории.
- Releases по-прежнему без `file_paths` (file picker до create невозможен — задокументировано в `schemas/releases.py`).
- `playback.catalog` по-прежнему не отдаётся (клиентский fallback через `/episodes` — ок).

| ID | Фиксить? | Сторона | Комментарий |
|----|----------|---------|-------------|
| H1 | done | клиент + бекенд | nested официально |
| H2 | done (client) | клиент | `detail` парсинг |
| H3 | done (backend) | бекенд | `task_file_id` + `ws_url` |
| H4 | done (backend) | бекенд | file_paths persist/filter |
| M1 | done (backend) | бекенд | `user_review` |
| M2 | done (backend) | бекенд | create → TaskDetailResponse |
| M3 | done (client) | клиент | catalog fallback `/episodes` |
| M4 | done (backend) | бекенд | members name |
| M5 | done (backend) | бекенд | absolute ws_url |
| N1–N5 | done (client) | клиент | nullable-типы |
| S1 | done (client) | клиент | Account invite/plan |

Контракт плеера: `docs/player-contract.md`.
