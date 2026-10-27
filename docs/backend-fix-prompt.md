# Seans backend — API contract fixes (implementation prompt)

You are implementing backend fixes in **`D:\projects\tedeshi\seans`** (FastAPI). This document is self-contained: it is derived from `D:\projects\tedeshi\seans-client\docs\api-contract-audit.md` and from a line-level read of the current backend sources. Do **not** implement anything outside the items below.

---

## Goal

Fix backend API contract mismatches with:

- **seans-client** — Tauri 2 + React desktop client at `D:\projects\tedeshi\seans-client`
- **web frontend** — plain JS app at `D:\projects\tedeshi\seans\frontend`

Only **backend-side** items that the client cannot fix on its own are in scope. Each change below states the exact wire JSON before/after and the file:line of current behavior.

---

## Context

### Repositories & stack

| Path | What |
|------|------|
| `D:\projects\tedeshi\seans` | Backend (this work) |
| `D:\projects\tedeshi\seans\app\` | FastAPI app: `routers/`, `schemas/`, `models/`, `services/` |
| `D:\projects\tedeshi\seans\alembic\versions\` | Migrations (`001` … `007` at time of writing) |
| `D:\projects\tedeshi\seans\tests\` | pytest suite |
| `D:\projects\tedeshi\seans\frontend\` | Web frontend (consumer; do not break silently) |
| `D:\projects\tedeshi\seans-client\` | Desktop client (consumer; contract reference) |
| `D:\projects\tedeshi\seans-worker\` | Downloader worker (consumer of `/api/worker/*`; **do not redesign**) |

Stack: Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2 async (asyncpg), PostgreSQL, Alembic, uv. Auth is `Authorization: Bearer <JWT>`.

### How to run tests

From `D:\projects\tedeshi\seans`:

```bash
# Preferred (matches Makefile):
make test          # = docker compose exec backend uv run pytest -v

# Or locally with uv:
uv run pytest -v
uv run pytest tests/test_rooms_ws.py -v     # focused
make lint          # ruff check + format --check
```

`pyproject.toml` sets `asyncio_mode = "auto"` and `testpaths = ["tests"]`. `tests/conftest.py` disposes the async engine per test and provides an `invite_key` fixture. Most API tests use `httpx.ASGITransport` against `app.main.app` and hit live Kinopoisk/JacRed with `pytest.skip` on network failure — follow that style.

### Wire contract conventions (do not break these)

- JSON field names are **snake_case**.
- IDs are **UUID strings** on the wire (`"550e8400-e29b-41d4-a716-446655440000"`), typed `uuid.UUID` in Pydantic models.
- Errors are always FastAPI shape: `{"detail": "<string>"}`; 422 validation: `{"detail": [{"type","loc","msg","input"}]}`. **Do not** switch to `message`/`error`.
- Collections are **bare JSON arrays** (no envelope, no pagination object). Query params: `limit` only.
- `Decimal` fields serialize as JSON **strings** (`"8.7"`, `"120.50"`) — keep this (client `toNumber` accepts it).
- Datetimes are ISO-8601; both `Z` and `+00:00` appear and clients accept both (`N6` — do not "fix").
- `rating_kp`, `position_sec`, `duration_sec` are Decimal-as-string. Nullable strings may be `null` (do not coerce to `""`).

### Related docs

- Full mismatch list: `seans-client/docs/api-contract-audit.md` (items **H3, H4, M1, M2, M4, M5**, optional history).
- Spec note T5.3 promised `user_review` on media detail (see audit `M1`/`S6`).

---

## Out of scope

- Worker protocol redesign (`seans-worker` internals). Changing the **content** of the existing `POST /api/worker/claim` payload is in scope; changing its shape/protocol is not.
- `/api/admin/*`, `/api/arr/*`, auth/invite changes.
- Client-side fixes (H1 history parser, H2 `detail` error parsing, M3 playback catalog, N1–N5 nullability) — those belong to seans-client, not this task.
- Playback descriptor extras (`file_id`, `catalog`, `video.primary`) — M3, client-side.

---

## Required changes

Implement **all** of the following. Severity labels match the audit (H = P0 broken, M = P1 feature gap).

---

### 1. H3 — `GET /api/rooms/{code}`: expose `task_file_id`, `ws_url`, `host_id`, member names

**Severity:** H (P0) — guest deep-link `seans://room/{CODE}` cannot open a player because the room never tells the guest which file to play.

**Current behavior**

- `app/schemas/room.py:17-25` — `RoomDetailResponse` has only `id, code, host_user_id, is_playing, current_position, created_at`.
- `app/routers/rooms.py:64-85` — `get_room_endpoint` returns `{"room": RoomDetailResponse.model_validate(room).model_dump(), "members": [{"user_id": str(m.user_id)}]}`.
- `Room.task_file_id` **already exists** on the model (`app/models/room.py:21-23`) and is set at create (`app/routers/rooms.py:45-49`) but is never serialized in the detail response.
- Members are `[{user_id}]` only — no `name` (audit **M4**, fixed in the same change, see item 5).
- `host_id` is not present; clients fall back to aliasing `host_user_id` → `host_id` (works, but we make it explicit).

**Before (current wire)**

```json
{
  "room": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "code": "AB12CD34",
    "host_user_id": "11111111-2222-3333-4444-555555555555",
    "is_playing": false,
    "current_position": 0.0,
    "created_at": "2026-09-20T12:00:00+00:00"
  },
  "members": [
    { "user_id": "11111111-2222-3333-4444-555555555555" }
  ]
}
```

**After (desired wire)**

```json
{
  "room": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "code": "AB12CD34",
    "host_user_id": "11111111-2222-3333-4444-555555555555",
    "host_id": "11111111-2222-3333-4444-555555555555",
    "task_file_id": "99999999-8888-7777-6666-555555555555",
    "ws_url": "wss://api.seans.tedeshi.ru/ws/rooms/AB12CD34",
    "is_playing": false,
    "current_position": 0.0,
    "created_at": "2026-09-20T12:00:00+00:00"
  },
  "members": [
    {
      "user_id": "11111111-2222-3333-4444-555555555555",
      "name": "alice"
    }
  ]
}
```

**Field rules**

| Field | Type | Rule |
|-------|------|------|
| `room.task_file_id` | UUID string | Always present (column is NOT NULL). This is the file the room plays — guests open the player from it. |
| `room.ws_url` | string | **Absolute** WebSocket URL: `wss://<public-host>/ws/rooms/{code}` (or `ws://` behind plain HTTP). Same builder as item 6 (M5). |
| `room.host_id` | UUID string | **Alias**, same value as `host_user_id`. Keep `host_user_id` (web + existing clients read it). |
| `members[].name` | string | `users.display_name` of the member. Never null (column is NOT NULL). |

**Implementation guidance**

1. `app/schemas/room.py` — extend `RoomDetailResponse`:

```python
class RoomDetailResponse(BaseModel):
    id: uuid.UUID
    code: str
    host_user_id: uuid.UUID
    host_id: uuid.UUID                      # alias, same value
    task_file_id: uuid.UUID
    ws_url: str
    is_playing: bool
    current_position: float
    created_at: datetime

    model_config = {"from_attributes": True}
```

   `host_id` and `ws_url` are not ORM attributes — build them in the router (do not rely on `model_validate` alone). Cleanest: a small helper `_room_detail_payload(room, ws_url: str) -> dict` that calls `model_validate`/`model_dump` and then sets `host_id = host_user_id` and `ws_url`.

2. `app/routers/rooms.py:64-85` — in `get_room_endpoint`:
   - Join `User` for members (or a second `select(User).where(User.id.in_(...))`), produce `{"user_id": str(m.user_id), "name": user.display_name}`.
   - Include `task_file_id` and absolute `ws_url` in `room`.
   - Keep the top-level shape `{"room": …, "members": [...]}` — do not flatten.

3. Absolute URL helper (shared with item 6 / M5): add to `app/config.py` a setting, e.g.

```python
PUBLIC_API_BASE_URL: str = "https://api.seans.tedeshi.ru"  # no trailing slash
```

   Document it in `.env.example`. Helper (e.g. `app/services/rooms.py` or a tiny `app/services/public_url.py`):

```python
def ws_url_for_room(code: str) -> str:
    base = settings.PUBLIC_API_BASE_URL.rstrip("/")
    scheme = "wss" if base.startswith("https") else "ws"
    # strip http(s):// to rebuild with ws(s)://
    rest = base.split("://", 1)[-1]
    return f"{scheme}://{rest}/ws/rooms/{code}"
```

   Optional refinement: if `PUBLIC_API_BASE_URL` is empty, derive from `Request.base_url` (then swap `http`→`ws`, `https`→`wss`). Prefer the setting in production (`Caddyfile` fronts the API at `api.seans.tedeshi.ru`).

**Tests to add** (extend `tests/test_rooms_ws.py` or new `tests/test_rooms_detail.py`):

- Create user + task + task file (see `tests/test_streaming_playback.py` for how task files get created via worker manifest), create room via `POST /api/rooms`, then `GET /api/rooms/{code}` and assert:
  - `room.task_file_id == ` the posted `task_file_id`
  - `room.ws_url.startswith("wss://")` and ends with `/ws/rooms/{code}` (or `ws://` in test config)
  - `room.host_id == room.host_user_id`
  - `members[0].name ==` the registered `display_name`
- 404 still `{"detail": "Room not found"}` for unknown code.

---

### 2. H4 — `POST /api/tasks`: persist `file_paths`, pass to workers, stop ignoring them

**Severity:** H (P0) — the client file-picker is a fiction; the server accepts `file_paths` (required!) and drops it.

**Current behavior**

- `app/schemas/task.py:7-9` — `CreateTaskRequest.file_paths: list[str]` is **required** but never read.
- `app/routers/tasks.py:36-85` — `create_task` builds `Task(...)` at `tasks.py:59-65` with no `file_paths`; the field is discarded.
- `app/models/task.py` — **no** `file_paths` column exists.
- `app/routers/worker.py:67-97` — `worker_claim` hardcodes `"file_paths": []  # Worker discovers files from torrent metadata` at `worker.py:94`.
- `app/schemas/releases.py` — `TorrentReleaseResponse` has **no** file list (indexer does not fetch torrent metadata). Clients therefore cannot learn file paths before create.

**Decision (required product call — implement exactly this)**

1. **Store** `file_paths` on the `tasks` table (JSONB, not-null, default `[]`).
2. **Return** the stored list in `POST /api/worker/claim` as `file_paths`.
3. **Semantics:** `file_paths == []` (or omitted) means **full torrent** (download every file). Non-empty means **select only these files** (exact path match against the torrent file list the worker discovers, plus a tolerant match: equal path, or suffix match on `/`-separated path).
4. **Defense-in-depth filter** in `apply_manifest` (`app/services/media_catalog.py:222`): when `task.file_paths` is non-empty, drop manifest entries whose `path` does not match any selected path, before creating `TaskFile` rows. Even a worker that ignores the claim filter will not store unselected files.
5. **Pre-create file listing:** there is **no** release file-list endpoint in this change (would require indexer/metadata fetch = out of scope). Therefore:
   - Make `file_paths` **optional** in `CreateTaskRequest` (`file_paths: list[str] = []`).
   - Document in code + API notes: **full-torrent is the only mode a UI can offer without known paths**; `file_paths` is a filter for clients that already know paths (e.g. re-download, or a future metadata source).
   - Do **not** add `file_paths` to `TorrentReleaseResponse` in this change. Optionally leave a short comment at `app/schemas/releases.py` that a future `GET .../releases/{id}/files` would be needed for a real picker.
6. Instruct the worker (comment in claim payload / README note): **non-empty `file_paths` MUST limit which torrent files are downloaded and uploaded**. Do not redesign the claim/manifest protocol.

**Before (current wire)**

Request (client sends this; server ignores `file_paths`):

```json
{
  "torrent_release_id": "aaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "file_paths": ["Season 01/ep01.mkv", "Season 01/ep02.mkv"]
}
```

Worker claim (`POST /api/worker/claim`) today:

```json
{
  "task_id": "…",
  "media": { "title": "…", "kp_id": null },
  "magnet": "magnet:?xt=…",
  "file_paths": [],
  "lease_minutes": 10,
  "upload_slots": []
}
```

**After (desired wire)**

Create request — `file_paths` optional, default full torrent:

```json
{
  "torrent_release_id": "aaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "file_paths": ["Season 01/ep01.mkv", "Season 01/ep02.mkv"]
}
```

or `{ "torrent_release_id": "…" }` / `{ "torrent_release_id": "…", "file_paths": [] }` for the full torrent.

Worker claim (same shape, real values):

```json
{
  "task_id": "…",
  "media": { "title": "…", "kp_id": null },
  "magnet": "magnet:?xt=…",
  "file_paths": ["Season 01/ep01.mkv", "Season 01/ep02.mkv"],
  "lease_minutes": 10,
  "upload_slots": []
}
```

**Implementation guidance**

1. **Migration** `alembic/versions/008_task_file_paths.py` (naming follows `001_initial_schema.py` … `007_streaming_catalog.py`):

```python
# upgrade
op.add_column(
    "tasks",
    sa.Column("file_paths", sa.JSON(), nullable=False, server_default="[]"),
)
# downgrade
op.drop_column("tasks", "file_paths")
```

   Use `postgresql.JSONB` if you prefer; `sa.JSON` is fine and dialect-neutral in tests.

2. `app/models/task.py` — add:

```python
file_paths: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
```

3. `app/schemas/task.py:7-9` — make the field optional:

```python
class CreateTaskRequest(BaseModel):
    torrent_release_id: uuid.UUID
    file_paths: list[str] = []   # [] = full torrent
```

4. `app/routers/tasks.py:59-65` — set `file_paths=list(body.file_paths or [])` on `Task(...)`. Optionally echo `file_paths` in `TaskDetailResponse` (nice-to-have; if added, add `file_paths: list[str] = []` to `TaskDetailResponse` and populate in `_task_detail`).

5. `app/routers/worker.py:94` — replace the hardcoded `[]` with the task's stored list:

```python
"file_paths": list(task.file_paths or []),
```

   Keep the key name `file_paths` and the surrounding claim object unchanged.

6. `app/services/media_catalog.py:222` (`apply_manifest`) — after loading `task`, before the `for i, f in enumerate(files)` loop:

```python
selected = [p for p in (task.file_paths or []) if p]
if selected:
    def _matches(path: str) -> bool:
        p = path.replace("\\", "/")
        for s in selected:
            s = s.replace("\\", "/")
            if p == s or p.endswith("/" + s) or s.endswith("/" + p):
                return True
        return False
    files = [f for f in files if _matches(f.get("path", ""))]
```

   If the filter removes everything, do **not** fail the manifest hard if you can avoid it — but prefer storing nothing over storing unselected files; if empty after filter, raise `HTTPException(400, detail="No files matched task.file_paths")` so the worker reports a real error.

**Tests to add** (`tests/test_tasks_flow.py`):

- `test_create_task_persists_file_paths` — POST with `file_paths: ["a.mkv","b.mkv"]`, then worker claim and assert `claimed["file_paths"] == ["a.mkv","b.mkv"]`.
- `test_create_task_default_file_paths_empty` — POST without `file_paths`, claim returns `[]`.
- `test_apply_manifest_filters_unselected` — claim, POST manifest with `files: [{"path":"a.mkv"},{"path":"other.mkv"}]` while task has `file_paths: ["a.mkv"]`, assert only `a.mkv` appears in `GET /api/library` files / task files.
- Keep `test_full_task_flow` green (it posts `file_paths: ["movie.mkv"]` and a manifest with `movie.mkv`).

---

### 3. M1 — `GET /api/media/{id}`: include caller's `user_review`

**Severity:** M (P1). Spec T5.3 promised "full record + user review"; the client works around it with an extra `GET /api/media/{id}/reviews` round-trip (`resolveOwnReview` in seans-client).

**Current behavior**

- `app/schemas/media.py:21-35` — `MediaDetail` has no `user_review`.
- `app/routers/media.py:54-66` — `get_media` returns `MediaDetail.model_validate(item)` only (caller identity is already available via `_user: User = Depends(get_current_user)`).
- Review shape is `app/schemas/review.py:15-24` `ReviewResponse`.

**Before**

```json
{
  "id": "…",
  "kp_id": 301,
  "tmdb_id": null,
  "kp_type": "movie",
  "title": "…",
  "original_title": "…",
  "year": 2010,
  "poster_url": "…",
  "overview": "…",
  "rating_kp": "8.7",
  "genres": ["fantasy"],
  "updated_at": "2026-09-20T12:00:00+00:00"
}
```

**After**

```json
{
  "id": "…",
  "kp_id": 301,
  "tmdb_id": null,
  "kp_type": "movie",
  "title": "…",
  "original_title": "…",
  "year": 2010,
  "poster_url": "…",
  "overview": "…",
  "rating_kp": "8.7",
  "genres": ["fantasy"],
  "updated_at": "2026-09-20T12:00:00+00:00",
  "user_review": {
    "id": "…",
    "user_id": "…",
    "media_item_id": "…",
    "score": 9,
    "review": "Loved it",
    "created_at": "2026-09-20T12:00:00+00:00",
    "updated_at": "2026-09-20T12:00:00+00:00"
  }
}
```

When the caller has no review: `"user_review": null` (or omit the key via `response_model_exclude_none` — **prefer explicit `null`**, which is what the client's `normalizeMediaDetail` already accepts).

**Implementation guidance**

1. `app/schemas/media.py` — add to `MediaDetail`:

```python
user_review: ReviewResponse | None = None
```

   Import `ReviewResponse` from `app.schemas.review`. `ReviewResponse` has `from_attributes`; nesting is fine.

2. `app/routers/media.py:54-66` — in `get_media`, after loading `item`:

```python
from app.models.review import Review  # existing model
result = await db.execute(
    select(Review).where(Review.user_id == _user.id, Review.media_item_id == item.id)
)
review = result.scalar_one_or_none()
detail = MediaDetail.model_validate(item)
detail.user_review = ReviewResponse.model_validate(review) if review else None
return detail
```

   (Rename `_user` → `user` if you need it in the body; keeping `_user` and using it is also fine.)

**Tests** (`tests/test_rooms_ws.py` already has review CRUD, or extend `test_catalog_library_api.py`):

- `test_media_detail_includes_user_review_after_put` — PUT review, then GET media detail, assert `user_review.score == 9` and `user_review.review == "…"`.
- `test_media_detail_user_review_null_without_review` — GET detail as a user with no review → `user_review is None`.
- Existing `GET /api/media/{id}/reviews` remains unchanged (public list, no auth) — do not break it.

---

### 4. M2 — `POST /api/tasks`: return `TaskDetailResponse`

**Severity:** M (P1). Client `normalizeTask` always reads `updated_at` and currently materializes `""` after create.

**Current behavior**

- `app/routers/tasks.py:36` — `@router.post("", response_model=TaskResponse, …)`.
- `app/routers/tasks.py:85` — `return TaskResponse.model_validate(task)`.
- `TaskResponse` (`app/schemas/task.py:12-21`) lacks `media_id`, `task_file_id`, `error`, `updated_at`.
- `TaskDetailResponse` (`app/schemas/task.py:24-37`) and helper `_task_detail` (`app/routers/tasks.py:20-33`) already have everything — reuse them.

**Before (201)**

```json
{
  "id": "…",
  "status": "queued",
  "reserved_bytes": 123456,
  "progress_pct": 0,
  "speed_bps": 0,
  "stage": null,
  "created_at": "2026-09-20T12:00:00+00:00"
}
```

**After (201)**

```json
{
  "id": "…",
  "media_id": "…",
  "task_file_id": null,
  "status": "queued",
  "reserved_bytes": 123456,
  "progress_pct": 0,
  "speed_bps": 0,
  "stage": null,
  "error": null,
  "created_at": "2026-09-20T12:00:00+00:00",
  "updated_at": "2026-09-20T12:00:00+00:00"
}
```

Notes: `task_file_id` is `null` at create (no files yet) — same as `GET /api/tasks` for a fresh task. `media_id` is `task.media_item_id`. Extra fields are additive; existing clients that ignore them keep working.

**Implementation guidance**

1. `app/routers/tasks.py:36` — change `response_model=TaskDetailResponse`.
2. `app/routers/tasks.py:85` — `return _task_detail(task, primary_file_id=None)`.
3. Keep `TaskResponse` in `app/schemas/task.py` only if something else uses it; otherwise leave it (harmless) or delete if unused (check first).
4. `GET`/`cancel` already return `TaskDetailResponse` — no change.

**Tests** (`tests/test_tasks_flow.py`):

- Extend `test_full_task_flow` (or add `test_create_task_returns_detail_shape`): after POST assert `task["updated_at"]`, `task["error"] is None`, `task["media_id"] == media_id`, `"task_file_id" in task`.
- Assert `updated_at` is a non-empty ISO datetime string (not `""`).

---

### 5. M4 — room `members[].name` from `users.display_name`

**Severity:** M (P1). REST members are `[{user_id}]`; names only appear later in WS `member_joined`/`member_left` frames.

Covered by the implementation in **item 1 (H3)** — same endpoint, same change. Do not split it.

**Before:** `"members": [{"user_id": "…"}]`  
**After:** `"members": [{"user_id": "…", "name": "alice"}]`

**Implementation guidance** (if not already done in item 1):

- `app/routers/rooms.py:76-84` — load `User` rows for member ids (`app/models/user.py:19` — `display_name: Mapped[str]`).
- Preserve order (join order is fine); include members with empty name never (`display_name` is NOT NULL).

**Tests:** same as item 1's member assertion. Add one case with **two** members if the room WS join path writes `RoomMember` rows in tests; otherwise asserting the host row (rooms create does not auto-insert host as member today — if host is absent from `members`, still return the host's name whenever they appear; do **not** invent membership). Optional enhancement: always include the host as a member entry with `name` — only if you also insert/update `RoomMember` consistently; otherwise leave membership as-is and just attach names.

---

### 6. M5 — `POST /api/rooms`: absolute `ws_url`

**Severity:** M (P1). Relative `"/ws/rooms/{code}"` breaks anyone who feeds it straight into `new WebSocket(...)` (they hit the app origin, not the API).

**Current behavior**

- `app/routers/rooms.py:57-61` — `RoomResponse(..., ws_url=f"/ws/rooms/{code}")`.
- `app/schemas/room.py:11-14` — `RoomResponse.ws_url: str`.
- Detail endpoint currently has **no** `ws_url` (fixed in item 1).

**Before (201)**

```json
{
  "id": "…",
  "code": "AB12CD34",
  "ws_url": "/ws/rooms/AB12CD34"
}
```

**After (201)**

```json
{
  "id": "…",
  "code": "AB12CD34",
  "ws_url": "wss://api.seans.tedeshi.ru/ws/rooms/AB12CD34"
}
```

**Implementation guidance**

- Reuse `ws_url_for_room(code)` from item 1 (`app/routers/rooms.py:60`).
- Same absolute URL string must appear in `GET /api/rooms/{code}` `room.ws_url`.
- Setting `PUBLIC_API_BASE_URL` in `app/config.py` + `.env.example`; production value `https://api.seans.tedeshi.ru` (see `Caddyfile`).
- Document: if a client cannot trust the absolute host (proxied setups), it may still re-derive the WS URL from its own `API_BASE_URL`; both paths must yield the same endpoint.

**Tests:** in room-create test assert `data["ws_url"] == f"{expected_ws_base}/ws/rooms/{code}"` and `data["ws_url"].startswith(("wss://", "ws://"))`.

---

### 7. (Optional / nice) `GET /api/history` — officialize the nested continue-watching shape

**Severity:** optional. Audit **H1** is primarily a client-side parse mismatch (`C2`); both consumers currently expect a flat array and **both are already broken** against the nested response.

**Decision (pick exactly this — do not invent a third shape):**

> **Keep the nested item shape and document it as THE official contract for `GET /api/history`.** Do not flatten. Do not return a hybrid.

Rationale: `media`/`file`/`progress_pct` are exactly what a continue-watching UI needs (title, poster, path) and would otherwise require N+1 client calls. Flattening would "fix" the two clients' parsers at the cost of that enrichment. The web frontend and seans-client must map `item.history.*` (coordinated consumer change — see Constraints).

**Current behavior**

- `app/routers/history.py:59-99` — `GET /api/history` returns `list[dict]`, filters `WatchHistory.completed == False`, builds `{"history", "media", "file", "progress_pct"}`.
- `app/schemas/history.py:14-22` — `HistoryResponse` (used for `PUT` and nested `history`) — keep.
- `PUT /api/history` (`app/routers/history.py:17-56`) returns flat `HistoryResponse` — **unchanged**.

**Official `GET /api/history?limit=` response (document as THE contract)**

```json
[
  {
    "history": {
      "id": "…",
      "task_file_id": "…",
      "position_sec": "120.50",
      "duration_sec": "5400.00",
      "completed": false,
      "updated_at": "2026-09-20T12:00:00+00:00"
    },
    "media": {
      "id": "…",
      "title": "Interstellar",
      "poster_url": "https://…"
    },
    "file": {
      "id": "…",
      "path": "Interstellar.2014.2160p/Interstellar.mkv"
    },
    "progress_pct": 3
  }
]
```

Rules to document and enforce with types:

- Response is a **bare JSON array** of items; empty history → `[]`.
- Only **incomplete** entries (`completed == false`) are returned, ordered by `updated_at` desc, capped by `limit` (default 50, ge=1, le=200).
- `history.position_sec` / `history.duration_sec` are Decimal strings.
- `progress_pct` is an int 0–100 (`position/duration*100`, 0 if duration==0).

**Implementation guidance (minimal)**

1. Add a typed schema so the contract is machine-visible, e.g. in `app/schemas/history.py`:

```python
class HistoryMedia(BaseModel):
    id: uuid.UUID
    title: str
    poster_url: str | None

class HistoryFile(BaseModel):
    id: uuid.UUID
    path: str

class HistoryContinueItem(BaseModel):
    history: HistoryResponse
    media: HistoryMedia
    file: HistoryFile
    progress_pct: int
```

2. Change `app/routers/history.py:59` to `response_model=list[HistoryContinueItem]` and return those models (or keep dicts and let FastAPI validate). Behavior of the query stays the same.

3. Do **not** change `PUT /api/history`.

**Tests** (new `tests/test_history_api.py` or extend existing):

- `test_get_history_nested_shape` — upsert a position via PUT (need a `task_file_id`, create via worker manifest like other tests), GET history, assert keys `history`, `media`, `file`, `progress_pct` and that `history.task_file_id` matches.
- `test_get_history_excludes_completed` — upsert `position_sec = duration_sec` (completed becomes true at ≥95%), assert item not listed.
- `test_get_history_empty` — `[]`.

---

## Acceptance

Run `make test` (or `uv run pytest -v`) from `D:\projects\tedeshi\seans`. All existing tests must stay green. Minimum new/updated cases:

| # | Change | pytest cases |
|---|--------|----------------|
| 1 | H3 room detail | `test_room_detail_includes_task_file_id_and_ws_url`; `test_room_detail_host_id_alias`; `test_room_detail_member_names`; `test_room_detail_unknown_code_404` |
| 2 | H4 file_paths | `test_create_task_persists_file_paths` (claim echoes list); `test_create_task_default_file_paths_empty`; `test_apply_manifest_filters_unselected`; keep `test_full_task_flow` green |
| 3 | M1 user_review | `test_media_detail_includes_user_review_after_put`; `test_media_detail_user_review_null_without_review` |
| 4 | M2 create task shape | `test_create_task_returns_detail_shape` (`updated_at`, `error`, `media_id`, `task_file_id` key present) |
| 5 | M4 members name | covered by `test_room_detail_member_names` |
| 6 | M5 absolute ws_url | `test_create_room_ws_url_absolute` (and same value on detail) |
| 7 | History (opt) | `test_get_history_nested_shape`; `test_get_history_excludes_completed`; `test_get_history_empty` |

Also verify manually (curl or httpx):

1. `POST /api/rooms` → `ws_url` is absolute `wss://…`.
2. `GET /api/rooms/{code}` → `room.task_file_id` present, `members[].name` present.
3. `POST /api/tasks` with `file_paths: ["a.mkv"]` → worker claim returns `["a.mkv"]`.
4. `GET /api/media/{id}` → `user_review` key present (null or object).
5. `POST /api/tasks` → response includes `updated_at` (ISO datetime).

---

## Constraints

- **No silent breaking changes for `seans/frontend`.** What it reads today:
  - History: `seans/frontend/js/app.js:1410` `String(item.task_file_id)` — expects a **flat** history item. Nested shape (item 7) keeps this broken until the web app maps `item.history.task_file_id` / `item.history.position_sec`. **Note this as a required coordinated one-line frontend follow-up** (either in the PR description or a TODO). Do not change the nested shape to silently suit the web app without documenting.
  - Rooms: `seans/frontend/js/app.js:1581` already reads `data.room?.task_file_id` — adding `task_file_id` (H3) **fixes** the web UI. `ws_url` from create is currently unused by web (it derives nothing; low risk).
  - Errors: web already parses FastAPI `detail` (`app.js:78-81`) — do not change error shape.
- **seans-client** is tolerant of additive fields and of `host_user_id`→`host_id` aliases (`src/api/parsing.ts`). Additive keys are safe. Making `CreateTaskRequest.file_paths` optional is safe (client still sends it).
- **Do not** change error envelope, UUID strings, snake_case, or Decimal-as-string.
- **Do not** redesign `/api/worker/claim` / `/api/worker/manifest` keys — only populate `file_paths` and filter on apply.
- Keep `GET /api/rooms/{code}` **without auth** (current behavior; audit S4 — out of scope to change).
- New columns need an Alembic migration; never edit old migration files.
- Run `make lint` before finishing (`uv run ruff check` / `format --check`).

---

## Suggested implementation order

1. Config helper `PUBLIC_API_BASE_URL` + `ws_url_for_room` (unblocks H3/M5).
2. Room detail + members name (H3 + M4) + tests.
3. `POST /api/rooms` absolute `ws_url` (M5) + tests.
4. Task `file_paths` migration + model + create/claim/apply_manifest (H4) + tests.
5. Create-task response = `TaskDetailResponse` (M2) + tests.
6. `MediaDetail.user_review` (M1) + tests.
7. (Optional) typed history nested contract (item 7) + tests + note for frontend/client parsers.
8. `make test` && `make lint`; write a short summary of wire changes for the seans-client team (which items the client no longer needs to work around).
