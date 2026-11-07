/**
 * Feature list (issue #25, «Функции»): master toggles for every player
 * function plus a «глазик» that controls whether its UI shows up inside the
 * player. Disabled functions register no UI and no filters in the player.
 */

import type { ReactElement } from "react";
import { useChromeSchema, chromeStore } from "./chromeStore";
import type { FeatureDef } from "./featureCatalog";
import { PLAYER_FEATURES, isFeatureEnabled } from "./featureCatalog";
import { isEntryHidden } from "./layoutModel";
import { FunctionEditor } from "./extensionEditors";
import { EyeToggle, Toggle } from "./bits";

export function FeatureList(): ReactElement {
  const schema = useChromeSchema();

  return (
    <div className="ps-card">
      <h3>Функции</h3>
      <p className="hint">
        Выключенная функция не работает и не видна в плеере. «Глазик» прячет
        её панель из плеера — настройки останутся здесь.
      </p>
      {PLAYER_FEATURES.map((feature) => (
        <FeatureRow key={feature.id} feature={feature} schema={schema} />
      ))}
    </div>
  );
}

function FeatureRow({
  feature,
  schema,
}: {
  feature: FeatureDef;
  schema: ReturnType<typeof useChromeSchema>;
}): ReactElement {
  const enabled = isFeatureEnabled(schema, feature.id);
  const entryHidden = feature.entryId ? isEntryHidden(schema, feature.entryId) : false;
  const hasEye = Boolean(feature.entryId);

  return (
    <div className="ps-row">
      <div className="ps-row-main">
        <span className="ps-row-title">{feature.label}</span>
        <span className="hint">{feature.description}</span>
        {enabled ? <FunctionEditor editorKey={feature.editorKey} /> : null}
      </div>
      <div className="ps-row-actions">
        {hasEye ? (
          <EyeToggle
            visible={!entryHidden}
            onChange={(visible) => {
              if (!feature.entryId) return;
              if (visible) chromeStore.showEntry(feature.entryId);
              else chromeStore.hideEntry(feature.entryId);
            }}
            label={`Показывать «${feature.label}» в плеере`}
          />
        ) : null}
        <Toggle
          checked={enabled}
          onChange={(next) => chromeStore.setFeature(feature.id, next)}
          label={`Функция «${feature.label}»`}
        />
      </div>
    </div>
  );
}
