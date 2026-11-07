/**
 * Feature catalog (issue #25, «Функции»): every toggleable player function —
 * extensions registered in `PLAYER_EXTENSIONS` and base chrome features.
 *
 * - `enabled` (мастер-тумблер) — disabled features register no UI and no
 *   filters in the player; they stay configurable here in the settings
 *   section.
 * - entries with `entryId` also carry a «глазик»: their player UI can be
 *   hidden so only the settings section controls the function.
 */

import type { ChromeSchema } from "./chromeSchema";

export type FeatureKind = "extension" | "chrome";

export type FeatureDef = {
  id: string;
  label: string;
  description: string;
  kind: FeatureKind;
  defaultEnabled: boolean;
  /** Extension id in `PLAYER_EXTENSIONS` (kind `extension`). */
  extId?: string;
  /** Chrome entry whose visibility is the «глазик» (player UI). */
  entryId?: string;
  /** React key of the function's settings editor block (settings section). */
  editorKey?: string;
};

export const PLAYER_FEATURES: readonly FeatureDef[] = [
  {
    id: "eq",
    label: "Эквалайзер",
    description:
      "Десятиполосный эквалайзер с пресетами. Фильтр af применяется к звуку во время воспроизведения.",
    kind: "extension",
    defaultEnabled: true,
    extId: "eq",
    entryId: "fn.eq",
    editorKey: "eq",
  },
  {
    id: "volume-processor",
    label: "Обработка звука",
    description:
      "Нормализация громкости (loudnorm) и ночной режим — приглушённые пики без потери разборчивости.",
    kind: "extension",
    defaultEnabled: true,
    extId: "volume-processor",
    entryId: "fn.volume-processor",
    editorKey: "volume-processor",
  },
  {
    id: "autohide",
    label: "Автоскрытие контролов",
    description:
      "Панель управления скрывается во время воспроизведения и появляется при движении мыши.",
    kind: "extension",
    defaultEnabled: true,
    extId: "autohide",
    entryId: "fn.autohide",
    editorKey: "autohide",
  },
  {
    id: "subtitle-style",
    label: "Стиль субтитров",
    description:
      "Шрифт, размер, цвет, обводка и фон субтитров. Применяется к реальным субтитрам в плеере (mpv sub-*).",
    kind: "extension",
    defaultEnabled: true,
    extId: "subtitle-style",
    entryId: "fn.subtitle-style",
  },
  {
    id: "stats",
    label: "Статистика воспроизведения",
    description:
      "Небольшая плашка со скоростью, позицией, дорожками и режимом декодирования.",
    kind: "extension",
    defaultEnabled: false,
    extId: "stats-overlay",
  },
  {
    id: "markers",
    label: "Маркеры сегментов",
    description:
      "Заставки, опенинги и титры на шкале перемотки (TheIntroDB). Выключите, чтобы видеть чистую шкалу.",
    kind: "chrome",
    defaultEnabled: true,
  },
];

const FEATURES_BY_ID = new Map(PLAYER_FEATURES.map((feature) => [feature.id, feature]));

const FEATURE_ID_BY_EXT = new Map(
  PLAYER_FEATURES.filter((f) => f.extId).map((f) => [f.extId as string, f.id]),
);

export function getPlayerFeature(id: string): FeatureDef | undefined {
  return FEATURES_BY_ID.get(id);
}

/** Feature id that gates a given extension registration. */
export function featureIdForExtension(extId: string): string | undefined {
  return FEATURE_ID_BY_EXT.get(extId);
}

/** Master switch for a feature; features missing from the schema use the default. */
export function isFeatureEnabled(schema: ChromeSchema, featureId: string): boolean {
  const flags = schema.features[featureId];
  if (flags) return flags.enabled;
  return getPlayerFeature(featureId)?.defaultEnabled ?? true;
}

export function setFeatureEnabled(
  schema: ChromeSchema,
  featureId: string,
  enabled: boolean,
): ChromeSchema {
  return {
    ...schema,
    features: { ...schema.features, [featureId]: { enabled } },
  };
}

/** Extension ids that must be registered for this schema. */
export function enabledExtensionIds(schema: ChromeSchema): Set<string> {
  const ids = new Set<string>();
  for (const feature of PLAYER_FEATURES) {
    if (feature.kind !== "extension" || !feature.extId) continue;
    if (isFeatureEnabled(schema, feature.id)) ids.add(feature.extId);
  }
  return ids;
}
