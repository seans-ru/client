---
feature: clean-screen
status: in-progress
updated: 2026-11-05
branch: feat/clean-screen
commits:
---

# Clean Screen — автоскрытие контролов и курсора

## Report

## [S1] Problem

Во время воспроизведения полоса управления и курсор остаются на экране
постоянно и мешают чистому экрану (issue #22, п. а). VLC/mpv/стриминговые
плееры прячут контролы и курсор после короткого простоя — по умолчанию, а не
опцией. Нужно: бездействие N сек (настройка 2–10 с, дефолт 3) прячет контролы
и курсор над видео; движение/клик/клавиша возвращают; на паузе контролы видны
всегда; опция «Не скрывать» для спецслучаев. Кинорежим (п. б #22) в эту
поставку не входит.

## [S2] Design

Решения (зафиксированы с заказчиком):
- В поставке — только автоскрытие; кинорежим остаётся в #22.
- Точка входа — расширение в `extensions/` (рецепт §S2.10
  `docs/compose/spec/player-extensibility.md`): таймер, правила и настройки
  живут в расширении; в ядре только актуатор видимости хрома
  (`ctx.ui.setChromeHidden`) и CSS-класс.
- Замороженные контракты портинга не трогаем: `session.rs`, `ffi.rs`,
  `frames.rs`, команды `player_*` / `player://state`, `usePlayer.ts`,
  `mpvBridge.ts`, wire-формат кадров — изменений нет.

### [S2.1] Актуатор видимости хрома

`ctx.ui` расширяется одним методом:

```ts
readonly ui: {
  add(slot: PlayerUiSlot, render: () => ReactNode): Unsubscribe;
  /** Прячет/показывает хром плеера (транспорт + курсор над видео).
      По умолчанию виден; расширение возвращает видимость в dispose. */
  setChromeHidden(hidden: boolean): void;
};
```

Реализация (единственное ядро, минимальное):
- `extensions/chromeControl.ts` — маленький стор по паттерну `frameHub`:
  `createChromeControl()` (тестируемая фабрика) + синглтон `chromeControl` с
  `setHidden(hidden)` / `isHidden()` / `subscribe(cb)` / `reset()`
  (reset = вернуть видимость).
- `registry.ts`: `ExtensionRuntimeDeps` получает `setChromeHidden` и
  прокидывает его в `ctx.ui.setChromeHidden`; тесты реестра добавляют поле
  в свои deps.
- `usePlayerExtensions` подключает deps к `chromeControl.setHidden`, в
  cleanup после `dispose()` вызывает `chromeControl.reset()`.
- `PlayerSurface` подписывается на стор (`useSyncExternalStore`) и добавляет
  класс `player-chrome-hidden` к корню `.player-surface`.
- `player.css`:

```css
.player-chrome-hidden .player-transport { visibility: hidden; }
.player-chrome-hidden .player-video-area { cursor: none; }
```

`visibility: hidden` (не opacity) — полоса исчезает и из tab-порядка. Анимаций
переходов нет (вне scope #22).

Скрываются только `.player-transport` (вся полоса управления с seek-rail) и
курсор над видео. Skip-кнопки TheIntroDB, `ProgressiveStatus` и попапы не
скрываем: skip-кнопка — единственное, что нужно во время интро без движения
мыши; попапы (меню настроек, титры) живут в overlay-слое рядом с транспортом и
остаются видимыми.

### [S2.2] Политика автоскрытия (чистая функция)

`extensions/autoHidePolicy.ts`:

```ts
export type ChromeVisibilityInput = {
  neverHide: boolean;
  fileLoaded: boolean;
  pause: boolean;
  eof: boolean;
};
export function shouldHideChrome(input: ChromeVisibilityInput): boolean;
export const MIN_DELAY_SEC = 2;
export const MAX_DELAY_SEC = 10;
export const DEFAULT_DELAY_SEC = 3;
export function clampDelaySec(value: number | null | undefined): number;
```

Правило: прятать только в активном воспроизведении
(`fileLoaded && !pause && !eof`) и при выключенном «Не скрывать». Пауза, eof,
нет файла или «Не скрывать» → хром виден. `clampDelaySec` приводит любое
прочитанное значение к целому в [2, 10], дефолт 3.

### [S2.3] Расширение `extensions/autoHide.tsx`

`PlayerExtension` с `id: "autohide"`, name «Автоскрытие контролов»; строка в
`PLAYER_EXTENSIONS` (`extensions/examples/index.ts`).

- Активность: `startActivityListener(target: EventTarget, onActivity: () => void)`
  слушает `pointermove`, `pointerdown`, `keydown`, `wheel` (passive) и
  возвращает Unsubscribe. Выносится именованным экспортом — тестируема на
  голом `EventTarget`. Любое событие: показать хром (если скрыт) и
  перезапустить таймер.
- Таймер: `setTimeout` на `delaySec` из storage; срабатывание при
  `shouldHideChrome(...)` из актуального снапшота → `ctx.ui.setChromeHidden(true)`.
- Снапшот: `ctx.onSnapshot` пересчитывает политику; переход в паузе/eof/без
  файла → сразу показать и снять таймер; возобновление → запустить таймер
  заново.
- Настройки в `settings.menu` + `ctx.storage` (`seans.player.ext.autohide.*`):
  - «Задержка» — чипы 2 с … 10 с (`player-chip` как у «Скорость»), дефолт 3 с;
  - «Не скрывать» — тумблер (menuitemradio, паттерн `ambientLightStub`),
    дефолт выкл.
  Общее состояние строк и таймера — маленький store + `useSyncExternalStore`
  (документированный паттерн из `ambientLightStub`).
- `dispose`: снять слушатели, очистить таймер, `setChromeHidden(false)`
  (восстановление контролов и курсора).

Поведение через реестр проверяется юнит-тестами: реальный
`createExtensionRuntime` + фейковые таймеры + spy `setChromeHidden`
(сценарии: скрытие по бездействию при play; возврат по активности; пауза не
прячет; «Не скрывать» не прячет; dispose восстанавливает).

### [S2.4] Дефолты и продукт

- Автоскрытие включено по умолчанию: «Не скрывать» = выкл, задержка 3 с.
- Хранилище — `ctx.storage` (localStorage `seans.player.ext.autohide.delaySec`
  / `.neverHide`), формат как у прочих расширений.
- Удаляется мёртвая константа `OVERLAY_IDLE_MS` (`playerHelpers.ts` + экспорт
  `index.ts`): её заменяет настройка, потребителей нет.

### [S2.5] Порог тестирования

- Юниты: `tests/autoHide.test.ts` (политика, clamp, `startActivityListener`,
  сценарии расширения через реестр) и `tests/chromeControl.test.ts` (стор:
  set / subscribe / reset).
- Обязательный порог: `npm run typecheck && npm test && npm run build`.
- Ручной смоук в Tauri (чеклист, выносится в Report): 3 с бездействия →
  контролы и курсор исчезли; движение/клик/клавиша → вернулись; пауза →
  всегда видны; «Не скрывать» → не скрывает; задержка из настроек меняет
  тайминг. В среде сборки без запущенного приложения смоук не выполняется.

## [S3] Out of Scope

- Кинорежим (п. б #22: blur-фон из кадра, затемнение) — остаётся в #22.
  Зафиксировано на будущее: тумблер один, выбор липкий (глобальное значение;
  дефолт — fullscreen вкл / окно выкл до первого ручного переключения).
  Визуал (blur-фон по ТЗ #22 против Ambilight-свечения #7) уточняется при
  реализации.
- Ambilight-подсветка оболочки и звук-реактивное свечение (#7).
- Анимации переходов (fade) — вне scope по ТЗ.
- Скрытие skip-кнопок, тостов и попапов.
- Пауза таймера при наведении на контролы (как в YouTube) — по ТЗ любое
  бездействие скрывает.
- Компонентные/E2E-тесты UI (в проекте нет такого слоя).
- Особенности автоскрытия для ТВ/мобилок (#44, #47, #48); при правках общей
  зоны (`PlayerSurface`) сверяться с портинговыми ветками.

## Tasks

- [ ] T1: актуатор: `chromeControl` (стор + фабрика), `ctx.ui.setChromeHidden`
  (types.ts + registry deps + тесты реестра), подписка PlayerSurface, класс
  `player-chrome-hidden` и CSS — acceptance: юнит-тесты стора
  (set/subscribe/reset) и проводки `setChromeHidden` через реестр (spy в
  deps), CSS-правила класса на месте (`.player-transport` скрыт,
  `cursor: none` на видео-зоне), `npm run typecheck` зелёный (covers: S2.1)
- [ ] T2: расширение `autoHide`: `autoHidePolicy`, `startActivityListener`,
  таймер и правила (play / pause / eof / «Не скрывать»), настройки (чипы
  2–10 с + тумблер) в `settings.menu` + `ctx.storage`, строка в
  `PLAYER_EXTENSIONS`, dispose восстанавливает видимость; удалить
  `OVERLAY_IDLE_MS` — acceptance: юнит-тесты сценариев через реальный registry
  со fake timers (скрытие по бездействию, возврат по активности, пауза,
  «Не скрывать», dispose), `npm run typecheck && npm test` зелёные
  (covers: S2.2, S2.3, S2.4; depends: T1)
- [ ] T3: полный порог и смоук-чеклист — acceptance:
  `npm run typecheck && npm test && npm run build` зелёные; смоук-чеклист
  вынесен в Report (covers: S2.5; depends: T2)
