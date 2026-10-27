# Seans Player Contract

Контракт плеера Windows-клиента (`seans-client`): что плеер потребляет от API,
как выбирает источник, как режет seek, как работает с дорожками, сериями,
историей и комнатами.

Статус: актуален после фиксов бекенда 2026-10-27 (см. `api-contract-audit.md`).
Код: `src/features/player/*`, `src/screens/PlayerScreen.tsx`, `src/api/playback.ts`,
`src-tauri/src/player/*`, `src-tauri/src/progressive/*`.

---

## 1. Роль плеера

Плеер — **libmpv in-process** внутри Tauri 2 (не WebView `<video>`).

| Слой | Ответственность |
|------|-----------------|
| JS (`PlayerScreen`, `usePlayback`, `usePlayer`) | маршрут, API playback, UI, history, комнаты, выбор серий |
| Tauri commands (`player_*`) | открыть URL, play/pause/seek, tracks, fullscreen, snapshot |
| Progressive (`progressive_*`) | локальный HTTP range-server поверх сегментов S3 |
| libmpv (`libmpv-2.dll` sidecar) | демукс/декод/рендер в child HWND (`wid`) |

Rust **не ходит** в Seans API — все URL приходят из JS.

---

## 2. Маршрут и вход

```
#/player/{taskFileId}
```

| Параметр | Источник | Смысл |
|----------|----------|-------|
| `taskFileId` | route / `openPlayer(fileId, {startAt})` | id `task_files` (library file) |
| `startAt` | sessionStorage `seans.player.startAt` | resume, сек; съедается один раз на mount |
| `season` / `episode` | из library file row | query к playback API |
| `mediaId` | resolve через `GET /api/library` | нужен для playback / history / TheIntroDB |

Навигация:
- Из библиотеки: `openPlayer(file.id, { startAt })`.
- Из истории: `openPlayer(task_file_id, { startAt: position_sec })`.
- Из пикера серий: library-файл с нужными `season`/`episode` (не `episode_id`).
- Комната (гость): `room.task_file_id` из `GET /api/rooms/{code}`.

---

## 3. API, который плеер обязан уметь

### 3.1 `GET /api/media/{media_id}/playback?season=&episode=`

**Основной источник истины** для того, что и как играть.

```jsonc
{
  "media_id": "uuid",
  "episode_id": "uuid",
  "title": "Show",
  "kind": "series" | "movie",
  "season": 1,
  "episode": 2,
  "episode_end": 3,          // multi-episode pack | null
  "duration_ms": null,       // сейчас всегда null → demuxer probe
  "video": {
    "task_file_id": "uuid",
    "file_path": "Show/S01E02.mkv",
    "size_bytes": 2500000000,
    "container": "mkv",      // расширение без точки
    "s3_key": "users/{task_id}/…",
    "url": "https://s3…/" | null   // null = ещё не complete
  },
  "audio_tracks": [{
    "id": "uuid", "language": "ru", "flags": ["dub"],
    "label": "Русский дубляж", "s3_key": "…",
    "embedded": true|false, "task_file_id": "uuid"|null,
    "url": "https://…presigned" | null   // только external
  }],
  "subtitle_tracks": [ /* аналогично */ ],
  "stream": { /* §3.2 */ } | null
}
```

Правила:
- `video.url == null` → **не** открывать как VOD; ждать `stream` / segments.
- `stream == null` → «ждём heartbeat воркера»; polling продолжается.
- `stream.complete == true` → VOD: `video.url` или `GET /api/files/{id}/url`.
- Ошибка `404 No playable files` → UI «файл ещё готовится», retry.

**Query:**
| Параметр | Когда |
|----------|-------|
| `season`, `episode` | сериалы; из library file |
| без query | фильм (`season=0,episode=0`) или первый эпизод |

### 3.2 `stream` — progressive state

```jsonc
{
  "ready": true,
  "complete": false,
  "size_bytes": 2500000000,
  "max_seekable_bytes": 83886080,   // ЕДИНСТВЕННЫЙ источник лимита seek
  "percent_downloaded": 4.8,
  "percent_seekable": 3.2,
  "segment_size": 8388608,          // default 8 MiB
  "segments_uploaded": 8,
  "segments_available": 10,
  "segments": [
    { "index": 0, "start": 0, "end": 8388608, "available": true,
      "url": "https://…presigned segment" },
    { "index": 1, "start": 8388608, "end": 16777216, "available": false,
      "url": null }
  ],
  "index_url": "https://…/index.json"
}
```

Инварианты (сервер + клиент):
1. Seek ceiling = `max_seekable_bytes` (`contiguous_bytes`). Никогда не больше `size_bytes`.
2. Сегмент доступен (`url != null`) **только** если весь его диапазон `end <= max_seekable_bytes` **или** `complete`.
3. `video.url != null` только при `complete` (или legacy `uploaded` без StreamState → synthetic complete VOD, `segments: []`).
4. Клиент **не** ходит за байтами в API host — только по presigned URL сегментов/файла.

### 3.3 `GET /api/files/{task_file_id}/url`

```jsonc
{ "url": "https://s3…presigned GET (24h)", "expires_in": 86400 }
```

- Только `task_files.status == "uploaded"`; иначе `404 File not yet uploaded`.
- Fallback VOD-источник, когда playback дал `complete`/`video.url`, но нужен отдельный URL.

### 3.4 `GET /api/media/{id}/episodes?season=`

Пикер серий, если playback не отдаёт `catalog` (сейчас backend catalog не шлёт).

```jsonc
{
  "media_id": "uuid", "title": "…", "kind": "series"|"movie",
  "episodes": [{
    "episode_id": "uuid",          // MediaEpisode id, НЕ task_file_id
    "season": 1, "episode": 2, "episode_end": null,
    "title": "…", "year": 2020,
    "audio_tracks": [{ "id", "language", "flags", "label", "embedded" }],
    "subtitle_tracks": [{ "id", "language", "label" }]
  }]
}
```

Клиент строит `PlaybackCatalog` (`mediaEpisodesToCatalog`) и при выборе серии
резолвит **library file** по `season`/`episode` → `#/player/{taskFileId}`.

### 3.5 History (resume / progress)

| Call | Body / query | Response |
|------|--------------|----------|
| `PUT /api/history` | `{task_file_id, position_sec, duration_sec}` | `HistoryResponse` (flat) |
| `GET /api/history?limit=` | — | nested continue-watching (только `completed==false`) |

- `completed` считает сервер: `position >= duration * 0.95`.
- Клиент пишет каждые **15 s** + на pause / seek / unmount (`historyThrottle`).
- Resume: `GET /api/history` → `findHistoryForFile` → `position_sec`.
- В комнате history **выключен** (хост владеет позицией).

---

## 4. Режимы воспроизведения

```
                    ┌─ stream.complete / video.url ──► VOD (presigned file URL)
GET playback ───────┼─ stream.ready && !complete ───► Progressive (loopback range)
                    └─ stream == null || !ready ────► Waiting (не открывать)
```

| Mode | Transport | Seek |
|------|-----------|------|
| **VOD** | `player_open(url)` — полный файл | по duration mpv |
| **Progressive** | `progressive_start` → `http://127.0.0.1:<port>/…` → mpv | clip к `max_seekable_bytes` |
| **Waiting** | не открывать; UI «Готовим первые сегменты…» | — |

### Progressive pipeline (JS → Rust → S3)

1. `usePlayback` поллит playback каждые **7 s**, пока `!stream.complete`.
2. `progressive_update({ size, maxSeekable, segments })` — сегменты с URL.
3. Rust range-server: HTTP Range → GET `segments[i].url`, clip к `max_seekable_bytes`.
4. `player_set_max_seekable(bytes)` — второй guard в `player_seek`.
5. `stream.complete` mid-watch → seamless switch на полный file URL **на той же позиции**.

UI seek rail:
- mid teal = `percent_downloaded`
- light teal = `percent_seekable`
- grey = future → toast «Этот момент ещё скачивается», запрос не шлётся
- край префикса → pause «Загрузка продолжается…», auto-resume при росте префикса

---

## 5. Дорожки (audio / subtitle)

### Audio

| Поле | Использование |
|------|----------------|
| `id` | выбор / preference key |
| `language` | `ru`/`en`/… (lowercase) |
| `flags` | `dub`, `voice`, `one_voice`, `original`, `dual_audio`, `studio_dub` |
| `label` | готовый текст от бекенда (приоритет) |
| `embedded` | `true` → mpv `aid`; `false` → external `audio-files` |
| `url` | presigned для external; `null` для embedded |

Русские fallback-лейблы (`audioTrackHelpers`):
`dub` → «Русский дубляж», `voice` → «Многоголосый», `one_voice` → «Одноголосый»,
`original` → «Оригинал», `dual_audio` → «Dual/Multi».

Preference: `localStorage` `seans.audio.episode.{mediaId}.{fileId}` +
`seans.audio.movie.{mediaId}`.

### Subtitle

Аналогично: `embedded` → mpv sub track; `url` → external file.
UI: список субтитров + on/off (не входит в HTTP-контракт).

### Открытие mpv

```
player_open({
  url,                    // VOD file URL или loopback progressive URL
  start_at,               // сек
  audio_files?: [url…],   // external tracks
  hwnd_hint?
})
```

`hwdec=auto-safe` (d3d11va/dxva2/nvdec → soft fallback). Snapshot:
`player://state` → `{position, duration, pause, eof, error, tracks, hwdec, speed, volume, mute, fullscreen, idle, file_loaded, url}`.

---

## 6. Серии и мультиэпизод

| Поле | Смысл |
|------|-------|
| `season` / `episode` | выбор через playback query |
| `episode_end` | pack `S01E03–E05`; `0`/null = single |
| `has_primary_video` | false → Play скрыт/disabled |
| `kind` | `movie` \| `series` |

Пикер: `SxxEyy · Название`. Переключение серии = resolve library file → new route.

Fallback каталога: `GET /api/media/{id}/episodes` (см. §3.4), потому что
`playback.catalog` backend сейчас не отдаёт.

---

## 7. Комната (watch-party)

Плеер = transport хоста; гость применяет remote state.

| Кто | Что |
|-----|-----|
| Host | play/pause/seek → WS `state {action, position}`; history off |
| Guest | WS `state` / `room_state` → `player.apply(...)`; heartbeat `position` |
| File | `room.task_file_id` (REST) или sessionStorage `seans.room.file.{code}` (хост) |

WS: `wss://…/ws/rooms/{code}?token=<JWT>` (или `room.ws_url` — absolute после фикса M5).
Close 4001 = unauthorized, 4004 = room not found.

---

## 8. Ошибки и copy

| Состояние | Поведение |
|-----------|-----------|
| Нет libmpv DLL | «Не найден libmpv-2.dll — пересоберите приложение…» |
| mpv open fail | «Не удалось открыть файл» + Retry |
| playback 404 | «Файл ещё готовится» + Retry |
| files/url 404 (pending) | waiting / progressive, не fatal |
| Seek в grey zone | toast «Этот момент ещё скачивается» |
| Edge префикса | pause «Загрузка продолжается…» |
| WS 4001/4004 | «Нет доступа» / «Комната не найдена» |
| Гость без task_file_id | «Сервер не вернул файл комнаты…» |
| TheIntroDB fail | silent feature-off |

401 на любом API → logout gate.

---

## 9. Чек-лист соответствия API ↔ плеер

| # | Требование | Кто гарантирует |
|---|------------|-----------------|
| 1 | `stream.max_seekable_bytes` — единственный seek ceiling | backend `build_stream_payload` + JS clamp + Rust `player_set_max_seekable` |
| 2 | Нет URL у future segments | backend segment rule |
| 3 | `video.url: null` ≠ playable | `normalizePlayback` |
| 4 | `stream: null` продолжает poll | `usePlayback` 7 s |
| 5 | External audio только с `url` | playback payload + `audio-files` |
| 6 | History PUT 15 s + force | `historyThrottle` |
| 7 | Resume не из completed | GET history filter |
| 8 | Series select = task_file_id route | library resolve |
| 9 | Room guest plays `room.task_file_id` | rooms REST (H3) |
| 10 | No runtime DLL / no API in Rust | `player/ffi.rs` local path only |

---

## 10. Smoke (manual)

1. HEVC+ASS mkv — embedded subs, switch audio.
2. H.264+AAC mp4 — seek, speed 0.25–2×, fullscreen.
3. Progressive ~5% — seek только teal; grey toast; edge pause/resume; после complete — свободный seek.
4. Multi-audio: dub/voice/original; reopen → preference stick.
5. Series: picker SxxEyy, next episode, pack S01E03–E05.
6. Room host+guest sync; deep link `seans://room/CODE`.
7. Resume после паузы/закрытия (~15 s throttle).
