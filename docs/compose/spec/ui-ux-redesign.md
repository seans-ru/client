---
feature: ui-ux-redesign
status: delivered
updated: 2026-10-16
branch: feat/ui-ux-redesign
commits: f20e21b..f20e21b # working tree ready; fill after feature commit
---

# UI/UX Redesign — Home, Library, Settings

## Report

**What was built** — Three-destination IA (Главная / Библиотека / Настройки) for Seans Client. Nav drops Задачи, История, and standalone Аккаунт; legacy hashes redirect (`#/tasks` `#/history` → `#/library`, `#/account` → `#/settings`). Home is a cinematic chart hero (`GET /api/catalog/chart`) with clickable poster backdrop and centered catalog search that works even when the chart is empty or failing. Library is the media hub: derived watch states (Планирую / Смотрю / Смотрел) from history progress, filters, continue-watching, next episode, create-room, re-download via releases, delete with card-level confirm/errors, and an active-downloads strip. Settings leads with Account (quota meter, logout), then theme note, updates, playback, about. Visual system is dark-only violet (`#0B0C10` / `#8B7CF6`); light palette and theme cycler are gone. Client contracts added for `GET /api/catalog/chart` and `DELETE /api/library/{id}` (backend work remains).

**Verification** — `npm run typecheck` PASS · `npm test` PASS (380 tests / 26 files) · `npm run build` PASS. Reviewer confirmed T1–T7; four criticals (hero links, delete error channel, task join, episode sort) fixed and re-reviewed PASS. Manual still required: live login, chart against real Seans `/api/catalog/chart`, delete against live API, visual pass in `tauri dev`.

**Journey log** — (1) PowerShell cannot use `python <<'PY'` heredocs; write a temp `.py` or use the edit tool. (2) `Get-Content | Set-Content` re-encodes UTF-8 Russian test fixtures into mojibake — patch with Python UTF-8 or the edit tool. (3) `TaskResponse` has no media/file join fields; per-card task chips need optional `media_id`/`task_file_id` (or a global downloads strip). (4) Hero backdrop `pointer-events: none` blocks child links — re-enable on posters only. (5) Linked worktree add works in this environment (`.worktrees/ui-ux-redesign`).

## [S1] Problem

Seans Client is a lightweight «open → pick a film for the evening → watch» desktop app whose rooms easily become watch-together sessions. The current chrome works against that goal: six top-level nav items (Главная, Библиотека, Задачи, История, Настройки, Аккаунт) bury the happy path; Home is only a search form with no invitation; Library is a flat file dump without continue / next-episode / re-download actions; Account is a separate stub from Settings; the teal light/dark system reads as an admin tool, not a home-theater client.

## [S2] Design

### Product shape

Three top-level destinations only:

| Route | Label | Role |
|-------|-------|------|
| `#/` | Главная | Cinematic chart backdrop + centered search |
| `#/library` | Библиотека | Media hub: watch states, continue, next episode, downloads, rooms |
| `#/settings` | Настройки | Account first, then app preferences / version / updates |

Nav no longer lists Задачи, История, or Аккаунт. Their **functions** fold into Library and Settings:

- Download / preparation tasks → status chips and progress on Library cards (existing `GET /api/tasks` polling) plus a library-level «Активные загрузки» strip when the API cannot join tasks to media.
- History / continue-watching → Library rows and «Продолжить просмотр» / «К следующей серии» (existing `GET /api/history` + player `PUT /api/history`).
- Account → first block inside Настройки.

`#/tasks`, `#/history`, and `#/account` stop being nav targets. Old hashes redirect to `#/library` (tasks/history) and `#/settings` (account) so bookmarks and muscle memory do not dead-end.

Player and room routes stay full-bleed (no left nav), unchanged.

### Visual system — dark home theater

Replace the teal light/dark palette with a **dark-only** violet system. Keep the existing token **names** (`--bg`, `--bg-elevated`, `--bg-sunken`, `--ink`, `--ink-muted`, `--accent`, `--accent-ink`, `--accent-soft`, `--border`, …) so primitives and screens restyle without a second design system.

| Token | Value | Role |
|-------|-------|------|
| `--bg` | `#0B0C10` | app canvas |
| `--bg-elevated` | `#14161D` | panels, nav, cards |
| `--bg-sunken` | `#08090C` | hero well, code, inputs wells |
| `--ink` | `#F2F1F7` | primary text |
| `--ink-muted` | `#9A96A8` | secondary text |
| `--accent` | `#8B7CF6` | violet primary |
| `--accent-ink` | `#0B0C10` | text on accent |
| `--accent-soft` | `rgba(139, 124, 246, 0.18)` | selected / soft fills |
| `--danger` | `#F07178` | destructive |
| `--border` | `#2A2C36` | hairlines |
| `--overlay` | `rgba(8, 9, 12, 0.72)` | modal / hero scrim |

Rules:

- `color-scheme: dark` on `:root` only. Light palette blocks and `prefers-color-scheme` light branch removed.
- Theme preference collapses to dark-only: nav theme cycle control removed; `data-theme` forced `dark` for player-chrome compatibility. `theme.ts` keeps pure helpers; UI stops exposing light/system.
- Type scale and space scale stay (Inter/Segoe UI, 12–36px, 4–32).
- Focus ring stays `--focus-color: var(--accent)`.
- Signature moment: Home hero (chart posters + scrim + centered search). Second: Library cards with watch-state chips in accent.

### Home (`#/`)

Layout (full content width, no standard `Screen` title chrome):

1. **Hero stage** — min-height ~70vh. Background = top chart posters from `GET /api/catalog/chart` as a soft masonry grid (6–12 posters, slight scale variety, heavy scrim to `--bg` at the bottom). Posters are clickable (`#/media/{id}`).
2. **Centered search** — large input («Найдите фильм или сериал…»), debounced catalog search under it (existing `SearchPanel`). Empty/error chart: hero degrades to gradient; search always works.
3. **Chart strip** — horizontal row «В чарте» when ≥1 chart items; else omitted.

Data: `fetchChart({ type: "popular_series", limit: 20 })` → `MediaSearchResult[]`. On failure treat as empty (search unaffected). Loading: skeleton poster tiles, not a blocking spinner over the hero.

### Library (`#/library`) — media hub

Header: title + compact filters (Все / Смотрю / Смотрел / Планирую) + Refresh.

**Watch state** (derived, no new API field):

| State | Rule |
|-------|------|
| Смотрел | history row `completed === true` (or near-end) for the file |
| Смотрю | history position > 0 and not completed |
| Планирую | no history / zero progress |

Helpers live in `libraryHelpers` (pure, unit-tested). Item state: any watching wins; else planned if any file lacks progress; else watched.

**Card actions:**

- «Продолжить просмотр» / «Смотреть» — open player at `position_sec` via `openPlayer(fileId, { startAt })`.
- «К следующей серии» — next episode after the furthest started/completed (sort by season then episode); hidden for movies.
- «Смотреть» / «Создать комнату» on file rows — unchanged room flow.
- «Скачать другую озвучку» / «Скачать другое качество» — open releases for that `media_item.id` (existing flow).
- «Удалить» — confirm; `DELETE /api/library/{id}` (`delete_files=false`). Card-scoped error on failure; parent refresh on success.
- Active task chip only when task payload exposes `media_id` / `task_file_id`; otherwise the library-level downloads strip.

### Settings (`#/settings`) — includes Account

Order: **Аккаунт** (name, email, logout, quota ProgressBar using `user.used_bytes` or Σ library `total_size` / `quota_bytes`) → Оформление (dark-only note) → Обновления → Воспроизведение → О приложении.

### API contracts (client-side TЗ for backend)

| Method | Path | Response / body | Notes |
|--------|------|-----------------|-------|
| GET | `/api/catalog/chart?type=popular_series&limit=20` | `MediaSearchResult[]` | Chart for Home. Server proxies Kinopoisk collections. Client tolerates empty/404. |
| DELETE | `/api/library/{library_item_id}?delete_files=` | `204` / `{ok:true}` | Remove library entry. UI confirms first. |
| GET | `/api/auth/me` | `UserResponse` + optional `used_bytes` | `quota_bytes` already exists. |

Existing endpoints used unchanged. Optional task join fields (`media_id`, `task_file_id`) unlock per-card download chips.

### Error / edge behavior

- Chart fetch fail → empty chart, search works.
- Delete fail → item stays, card-level error (`role="alert"`).
- Missing history → «Планирую», no «Продолжить».
- Next episode none → button hidden.
- Unauthenticated → existing login gate.
- Player/room full-bleed unchanged.

### Testing boundaries

- Pure: watch state, next episode (season-first sort), filters, resume position.
- Route: `resolveLegacyRoute` redirects.
- No live network in unit tests.

## [S3] Out of Scope

- Backend implementation of `/api/catalog/chart` and `DELETE /api/library`.
- Kinopoisk API keys in the client.
- Light theme restoration.
- Player chrome redesign (controls overlay as-is; tokens follow dark violet).
- Web app parity.
- New watch-state server field or manual status editing.
- Removing orphan screen modules (`TasksScreen`/`HistoryScreen`/`AccountScreen`) still on disk but unrouted.
- macOS/Linux.

## Tasks

- [x] T1: Dark violet token set + dark-only theme surface — acceptance: `tokens.css` matches S2 table; no light palette branch; nav theme cycler gone; typecheck/tests green (covers: S2 Visual)
- [x] T2: Nav to three destinations + route redirects — acceptance: NAV_ITEMS = Главная/Библиотека/Настройки; `#/tasks` `#/history` → `#/library`, `#/account` → `#/settings` (covers: S2 Product shape)
- [x] T3: `fetchChart` + Home hero with chart posters and centered search — acceptance: chart drives backdrop; search works when chart empty/fails; posters open `#/media/{id}` (covers: S2 Home, API chart; depends: T1)
- [x] T4: Library watch-state helpers + filters — acceptance: unit tests for planned/watching/watched from history; filter chips work (covers: S2 Library watch state; depends: T1)
- [x] T5: Library card actions (continue, next episode, delete, re-download voiceover/quality, task status) — acceptance: actions match S2; delete uses `DELETE /api/library/{id}` with confirm; re-download opens releases for media (covers: S2 Library, API delete; depends: T4)
- [x] T6: Settings merges Account (quota meter, logout) + updates/version — acceptance: account first block; meter uses quota/used; theme cycler removed (covers: S2 Settings; depends: T1, T2)
- [x] T7: Unit tests + typecheck + build verification — acceptance: `npm run typecheck`, `npm test`, `npm run build` all green (covers: S2 Testing)
