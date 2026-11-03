---
feature: player-extensibility
status: delivered
updated: 2026-11-03
branch: feat/player-extensibility
commits: b1c740f..88d3904
---

# Player Extensibility

## Report

**What was built** — Плеер получил расширяемую архитектуру: типизированный
реестр `PlayerExtension` (lifecycle setup/dispose, события onOpen/onClose/
onSnapshot, UI-слоты, именованное хранилище) с изоляцией ошибок; универсальный
mpv-мост (`player_get_property` / `player_set_property` / `player_command`) с
deny-list для свойств рендера (`wid`, `vo`, `gpu-context`, `init-options`) и
закрытым обходом через argv-команды; frame tap (`frameHub`) с stride-сэмплом
кадров ≤32×32 и троттлингом для видео-эффектов; 5 UI-слотов в хроме плеера
(controls.primary/secondary, settings.menu, overlay, sidecar).

`PlayerScreen` декомпозирован (≈600 → 244 строки композиции) в хуки
`useMediaLookup` / `usePlayerOpener` / `useProgressiveGuard` /
`useGuardedTransport` с сохранением поведения 1-в-1 (копии, пороги, порядок
открытия, API для комнат). Runtime расширений подключён через
`usePlayerExtensions` (StrictMode-совместимый lifecycle) + `PlayerSlotsProvider`.
Два инертных примера в `extensions/examples/` («Постоянная громкость»,
«Ambient-освещение») документируют API: настройки + storage, чтение mpv-свойства
через мост, бейдж по среднему цвету кадра — без изменения звука и транспорта.
Рецепт добавления новой функции — §S2.10 (новый модуль + строка в реестре).

**Verification** — `npm run typecheck` PASS; `npm test` PASS (446 tests /
31 files; baseline до изменений — 414 / 28); `npm run build` PASS;
`cargo test` PASS (14 tests, включая guard свойств и guard argv-команд).
Ревью полного изменения (subagent) → request-changes (1 critical, 2 major,
2 minor) → фиксы → повторное ревью: 4/5 RESOLVED, guard PARTIAL →
дополнение guard (флаги команд + `_`-алиасы) → точечная проверка: полный
набор `cmd_flags[]` mpv (12 флагов) закрыт. Поведенческая сохранность
декомпозиции подтверждена скриптом сверки русских строк (0 missing) и
дифф-ревью.

**Journey log** —
(1) React StrictMode (включён в `main.tsx`) убивает паттерн «ресурс в
useState-инициализаторе + dispose в cleanup» — инициализатор не перезапускается,
dispose срабатывает навсегда. Ресурс создавать/уничтожать внутри эффекта
(как `useRoomSocket`).
(2) Фильтр argv-команд mpv обязан пропускать префиксы-флаги (полный
`cmd_flags[]`: 12 штук, включая `osd-auto`/`nonrepeatable`/`nonscalable`) и
нормализовать `_`→`-` в именах команд (`find_cmd`); свойства матчатся
case-sensitive.
(3) `ctx.ui.add` возвращает React-узлы в независимые поддеревья — общее
состояние между слотами (переключатель настройки + бейдж) делается через
маленький внешний store + `useSyncExternalStore`.
(4) Сверка русских литералов через PowerShell даёт ложные расхождения
(кодировки); проверять через Python UTF-8. Якоря для edit-инструмента в
файлах с кириллицей — только ASCII-участки (консоль показывает mojibake).
(5) Отменённые фоновые субагенты оставляют частичные файлы — сверять
`git status` worktree перед повторным запуском (frameHub/registry уцелели).

## [S1] Problem

Плеер (libmpv + React) работает, но его код не рассчитан на доработку: транспорт,
открытие источника (VOD/progressive), history, rooms и UI смешаны в `PlayerScreen`
(~600 строк) и фиксированном наборе Tauri-команд. Любая новая функция звука,
видео или интерфейса плеера потребовала бы правок ядра в нескольких местах.
Нужна архитектура, в которой новая функция = один новый модуль-расширение,
без изменений ядра (постоянная громкость, ambient-освещение и т.п. — лишь
примеры будущих функций, сами функции не реализуются).

## [S2] Design

Решения (зафиксированы с заказчиком): реестр типизированных расширений;
универсальный mpv-мост (property get/set/command) вместо точечных команд под
каждую фичу; полная декомпозиция `PlayerScreen` на orchestration-хуки; границы
работ — JS-декомпозиция + заглушки-примеры, в Rust только мост (session.rs
не перестраивается).

### [S2.1] Слои архитектуры

```
features/player/
  playerTypes.ts, playerApi.ts, usePlayer.ts, frameSink.ts   — ядро (без изменений сути)
  bridge/mpvBridge.ts            — универсальный доступ к mpv (новое)
  extensions/
    types.ts                     — PlayerExtension, PlayerExtensionContext, слоты
    registry.ts                  — createExtensionRuntime: lifecycle + error isolation
    slots.tsx                    — реестр UI-слотов + компонент <PlayerSlot>
    frameHub.ts                  — публикация кадров + сэмплирование для подписчиков
    storage.ts                   — именованное персистентное хранилище расширений
    examples/constantVolumeStub.ts, ambientLightStub.ts   — инертные заглушки
  useMediaLookup.ts, usePlayerOpener.ts,
  useProgressiveGuard.ts, useGuardedTransport.ts,
  usePlayerExtensions.ts         — orchestration-хуки (новые, из PlayerScreen)
  PlayerSurface.tsx, PlayerControls.tsx   — рендерят слоты; публикуют кадры в frameHub
src/screens/PlayerScreen.tsx     — тонкая композиция хуков + Discord/TheIntroDB
src-tauri/src/player/commands.rs — + player_get_property / player_set_property / player_command
```

Поток данных: `usePlayer` (снапшот/транспорт) → `useGuardedTransport` (history +
room + seek-лимит) → транспорт получают UI и расширения; `usePlayerOpener`
эмитит события открытия/закрытия в runtime расширений; `PlayerSurface`
публикует кадры в `frameHub`; слоты рендерятся в фиксированных точках хрома.

### [S2.2] Контракт расширения

```ts
export type Unsubscribe = () => void;

export type PlayerUiSlot =
  | "controls.primary"    // кластер кнопок слева от seek-бара
  | "controls.secondary"  // кластер справа (у громкости/шестерёнки)
  | "settings.menu"       // строки в меню настроек плеера
  | "overlay"             // слой поверх видео (эффекты, бейджи)
  | "sidecar";            // секции в боковой панели

export type OpenInfo = {
  url: string;
  startAt: number | null;
  source: "vod" | "progressive" | "unknown";
};

export type FrameSample = {
  width: number;
  height: number;
  pts: number;
  /** RGB-тройки после stride-сэмплирования; длина = width*height*3. */
  rgb: Uint8Array;
};

export type MpvBridge = {
  getProperty(name: string): Promise<string>;
  setProperty(name: string, value: string | number | boolean): Promise<void>;
  command(args: string[]): Promise<string | null>;
};

export type ExtensionStorage = {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
};

export type ExtensionTransport = {
  play(): Promise<void>;
  pause(): Promise<void>;
  togglePause(): Promise<void>;
  seek(seconds: number, opts?: { personal?: boolean }): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setMute(mute: boolean): Promise<void>;
  setFullscreen(enabled: boolean): Promise<void>;
};

export type PlayerExtensionContext = {
  readonly id: string;
  readonly transport: ExtensionTransport;   // тот же guarded-транспорт, что у UI
  getSnapshot(): PlayerSnapshot;
  onSnapshot(cb: (s: PlayerSnapshot) => void): Unsubscribe;
  onOpen(cb: (info: OpenInfo) => void): Unsubscribe;
  onClose(cb: () => void): Unsubscribe;
  readonly mpv: MpvBridge;
  readonly frames: {
    subscribe(cb: (s: FrameSample) => void, opts?: { maxFps?: number }): Unsubscribe;
  };
  readonly ui: {
    add(slot: PlayerUiSlot, render: () => React.ReactNode): Unsubscribe;
  };
  readonly storage: ExtensionStorage;
};

export type PlayerExtension = {
  id: string;
  name: string;
  /** Возвращает dispose; вызывается при размонтировании плеера. */
  setup(ctx: PlayerExtensionContext): void | Unsubscribe;
};
```

Инварианты:
- `setup` вызывается один раз на сессию плеера (монтирование `PlayerScreen`),
  `dispose` — при размонтировании; `onOpen` — на каждое успешное открытие
  источника (новый файл или смена/переоткрытие источника; `OpenInfo.source`
  сообщает режим); `onClose` — при смене файла и завершении сессии (может
  прийти без парного `onOpen`, если файл не открывался).
- UI-вклад расширения — React-компонент (`() => <MyControl/>`), его внутреннее
  состояние перерисовывает только свою поддерево.
- `storage` пишет в `localStorage` под ключами
  `seans.player.ext.<id>.<key>` (конвенция как у `seans.audio.episode.*`).

### [S2.3] Реестр и жизненный цикл

`createExtensionRuntime(extensions: PlayerExtension[], deps) → ExtensionRuntime`:
- регистрирует расширения в порядке объявления (порядок слотов стабилен);
- `dispose()` вызывает dispose-колбэки в обратном порядке;
- возвращает `notifyOpen(info)` / `notifyClose()` для опенера и
  `subscribeSlots(cb)` для React-слоя.

Error isolation (поведение при ошибках): исключение в `setup`, dispose,
колбэке подписки или render одного расширения не должно ломать другие
расширения и плеер — перехват, `console.warn("[player.ext]", id, …)`,
остальные продолжают работать. Колбэки `ctx.frames.subscribe` изолируются
на уровне `frameHub` (хаб не знает id расширений — метка
`"[player.ext] frame callback"`), чтобы брошенное исключение не рвало цикл
чтения `FrameStream`.

Список расширений — статический экспорт в `extensions/examples/index.ts`
(компилируется, дерево-шейкируется, типизируется; динамическая загрузка
не нужна). Реестр живёт в `usePlayerExtensions` и передаётся через React
контекст (`slots.tsx`).

### [S2.4] UI-слоты

- `slots.tsx`: `addSlot(extId, slot, render)` → `Unsubscribe`; снимок слота —
  упорядоченный список `render`-функций; уведомление подписчиков при изменении.
- `<PlayerSlot name="…" />` рендерит список узлов слота; точки вставки:
  - `controls.primary` / `controls.secondary` — `PlayerControls` (кластеры кнопок);
  - `settings.menu` — конец `SettingsMenu` (перед закрытием);
  - `overlay` — `player-overlay-layer` поверх видео (в `PlayerSurface`);
  - `sidecar` — конец `player-sidecar`.
- Пустой слот не рендерит ничего и не влияет на раскладку (без placeholder).

### [S2.5] Универсальный mpv-мост

Rust (`src-tauri/src/player/commands.rs`, регистрация в `lib.rs`):

| Команда | Реализация | Результат |
|---|---|---|
| `player_get_property(name)` | `mpv_get_property_string` через `with_session` | `String` |
| `player_set_property(name, value)` | `value: string \| f64 \| bool` (serde) → `set_property_string` / `set_property_f64` / `set_property_flag` | `()` |
| `player_command(args: Vec<String>)` | `mpv_command_ret` (NULL-terminated argv) | `Option<String>` |

- TS-обёртка: `bridge/mpvBridge.ts` → `getProperty` / `setProperty` / `command`.
- Запретные свойства (системная граница — ломают вкладку рендера):
  `wid`, `vo`, `gpu-context`, `init-options` → ошибка `"property is reserved"`.
  Остальные свойства mpv (включая `af`, `volume`, `lavfi`…) разрешены.
- Обход через `player_command` закрыт: для argv-команд, пишущих свойства
  (`set`, `add`, `cycle`, `cycle-values`, `multiply`, `change-list`), имя
  свойства проверяется тем же deny-list. Guard повторяет разбор argv mpv:
  пропускает префиксы-флаги команд (`no-osd`, `async`, …) и нормализует
  `_` → `-` в именах команд (`cycle_values` == `cycle-values`).
- Чистый помощник сериализации значения (`"string"|"double"|"flag"` +
  проверка имени) выносится в тестируемую функцию.
- Каждая новая mpv-функция доступна без правок Rust — только через мост.

### [S2.6] Frame tap (кадры для видео-эффектов)

- `frameHub.ts`: `publishFrame({width, height, pts, pixels})` — вызывается из
  обработчика `FrameStream` в `PlayerSurface` рядом с `renderer.push`.
- На каждый кадр хаб лениво считает stride-сэмпл ≤ 32×32 RGB
  (`downsampleRgb`, чистая функция, unit-тесты); сэмпл кэшируется как «последний».
- `subscribe(cb, { maxFps = 10 })` — доставка последнего сэмпла с троттлингом;
  без подписчиков сэмпл не считается (кроме первого кадра не требуется).
- `reset()` — при закрытии потока / `player_destroy` (сброс кэша и подписок).
- Эффекты уровня приложения (ambient вокруг окна) строятся подпиской на
  `ctx.frames` и записью CSS-переменных — вне ядра.

### [S2.7] Декомпозиция PlayerScreen

`PlayerScreen` сохраняет внешний API (props для RoomScreen) и становится
композитором. Логика переезжает в хуки:

| Хук | Отвечает | Из текущего кода |
|---|---|---|
| `useMediaLookup(fileId, fallback)` | mediaId + season/episode из библиотеки (fallback — TheIntroDB) | `resolveFileMedia`, `findLibraryFileForEpisode`, effect резолва |
| `usePlayerOpener(...)` | выбор режима и открытие источника (VOD/progressive/waiting), retry, complete→VOD-переключение, `notifyOpen/Close` | большой open-effect + `openedMode` + `openToken` + `openedAsProgressiveRef` |
| `useProgressiveGuard(...)` | синхронизация `maxSeekable`, пауза на крае префикса, auto-resume при росте, `progressiveUpdate` | три progressive-effect'а |
| `useGuardedTransport(player, …)` | единый guarded-транспорт: seek-лимит (blocked toast) + history flush + room-бродкаст + `RoomTransport` для сокета | `playerWithHistory` + transportRef effect + seek guard |
| `usePlayerExtensions(...)` | runtime расширений + слоты | новое |

Поведение 1-в-1: копии сообщений, пороги (`1.5` с для room-seek, 15 s history
throttle, personal-seek без бродкаста), порядок открытия источников —
сохраняются. Discord RPC и TheIntroDB остаются хуками приложения
(`useDiscordRpc`, `useTheIntroDb`) — они не расширения плеера.

Тестовая граница: чистая логика (реестр, слоты, сэмплы, сериализация моста)
— unit-тесты; поведение плеера/UI — typecheck + build + ручной smoke
(компонентных тестов в проекте нет).

### [S2.8] Заглушки-примеры (документация API)

`extensions/examples/` — два инертных расширения, зарегистированные в
реестре по умолчанию (строки в настройках помечены «пример»):

1. `constantVolumeStub` («Постоянная громкость (пример)»): тумблер в
   `settings.menu` (состояние в `ctx.storage`); в коде — закомментированный
   скетч вызовов `ctx.mpv.setProperty("af", …)` на `onOpen` и сброс при
   выключении. При включении демонстрирует чтение свойства `af` через мост
   (показывает текущее значение в строке) — доказательство read-path.
2. `ambientLightStub` («Ambient-освещение (пример)»): тумблер + компонент в
   `overlay` — маленький бейдж, подкрашиваемый усреднённым цветом последнего
   `FrameSample` (доказательство frame tap + слотов). Не влияет на окно
   вокруг приложения.

Оба заглушки не меняют транспорт и звук. Эффекты реальных функций — вне
объёма (S3); в заглушках остаются скетчи нужных вызовов.

### [S2.9] Стабильность поведения и отказы

- Рефакторинг behavior-preserving: контракты playback API, progressive-clip,
  history throttle, room WS, Discord, TheIntroDB не меняются.
- Ошибки расширения изолированы (S2.3); ошибка моста = reject с текстом mpv
  (`error_text`), UI расширения решает сам.
- Отсутствие Tauri (plain vite): мост/кадры молча недоступны — расширения
  получают reject/нет кадров, ядро работает.

### [S2.10] Рецепт добавления функции

1. Создать `features/player/extensions/myFeature.ts`, экспортировать
   `PlayerExtension` (id, name, setup).
2. Звук: `ctx.mpv.setProperty("af", …)` / `command(["af-add", …])` на `onOpen`.
   Видео-эффект: подписка `ctx.frames.subscribe`. UI: `ctx.ui.add(slot, …)`.
   Настройки: тумблер в `settings.menu` + `ctx.storage`.
3. Добавить объект в список `extensions/examples/index.ts` (реестр).
4. `npm run typecheck && npm test && npm run build`. Ядро не трогать.

## [S3] Out of Scope

- Реализация постоянной громкости (loudnorm) и ambient-освещения вокруг
  окна — только инертные заглушки со скетчами.
- Перестройка Rust `session.rs` / FFI-слоя; новые точечные Tauri-команды под
  будущие фичи (всё через мост).
- Динамическая/сторонняя загрузка расширений (только статический реестр).
- Стрим наблюдения mpv-свойств (только запросы get по требованию).
- Изменения playback API, progressive, rooms, history, Discord, TheIntroDB.
- Компонентные/E2E-тесты UI (в проекте нет такого слоя).

## Tasks

- [x] T1: mpv-мост: Rust-команды `player_get_property` / `player_set_property` / `player_command` + TS `bridge/mpvBridge.ts` + чистая сериализация значения с deny-list — acceptance: команды в `generate_handler`, unit-тесты сериализации/запретных имён, `npm run typecheck && npm test && npm run build` зелёные (covers: S2.5)
- [x] T2: ядро расширений: `extensions/types.ts`, `registry.ts` (lifecycle, error isolation), `storage.ts` — acceptance: unit-тесты порядка setup/dispose, изоляции ошибок, неймспейса storage (covers: S2.2, S2.3, S2.9)
- [x] T3: UI-слоты: `extensions/slots.tsx`, `<PlayerSlot>`, вставки в `PlayerControls` (primary/secondary/settings.menu) и `PlayerSurface` (overlay/sidecar) — acceptance: unit-тесты реестра слотов (add/unsubscribe/порядок), typecheck/build зелёные, пустой слот не влияет на раскладку (covers: S2.4; depends: T2)
- [x] T4: frame tap: `extensions/frameHub.ts` (publish, `downsampleRgb`, subscribe с maxFps, reset), публикация кадров из `PlayerSurface` — acceptance: unit-тесты downsample/троттлинга/reset; хаб получает кадры из существующего `FrameStream` (covers: S2.6)
- [x] T5: декомпозиция `PlayerScreen` → `useMediaLookup` / `usePlayerOpener` / `useProgressiveGuard` / `useGuardedTransport` — acceptance: внешний API `PlayerScreen` (props для RoomScreen) не изменился, typecheck/tests/build зелёные, поведение копий сообщений/порогов/порядка открытия сохранено (covers: S2.1, S2.7, S2.9)
- [x] T6: runtime `usePlayerExtensions` + заглушки `constantVolumeStub` / `ambientLightStub` (зарегистрированы, инертны) + сверка рецепта S2.10 с фактическим API — acceptance: строки-примеры видны в настройках плеера, dispose при размонтировании, включение заглушек не меняет транспорт/звук (кроме бейджа-примера), рецепт из спеки совпадает с именами API (covers: S2.2, S2.8, S2.10; depends: T1, T2, T3, T4, T5)
