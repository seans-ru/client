/**
 * Extension settings editors embedded in the settings section (issue #25:
 * «Дублируем» — full controls live both in the player menu and here). Stores
 * are shared with a running player session (memoized per storage facade), so
 * changes apply to the sound immediately.
 */

import { useMemo } from "react";
import type { ReactElement } from "react";
import { createExtensionStorage } from "../player/extensions/storage";
import {
  EqSection,
  createEqSettings,
} from "../player/extensions/eq";
import {
  VolumeProcessorRow,
  createVolumeSettings,
} from "../player/extensions/volumeProcessor";
import {
  AutoHideRow,
  createAutoHideSettings,
} from "../player/extensions/autoHide";

export function EqEditor(): ReactElement {
  const settings = useMemo(() => createEqSettings(createExtensionStorage("eq")), []);
  return (
    <div className="ps-embed">
      <EqSection settings={settings} />
    </div>
  );
}

export function VolumeProcessorEditor(): ReactElement {
  const settings = useMemo(
    () => createVolumeSettings(createExtensionStorage("volume-processor")),
    [],
  );
  return (
    <div className="ps-embed">
      <VolumeProcessorRow settings={settings} />
    </div>
  );
}

export function AutoHideEditor(): ReactElement {
  const settings = useMemo(
    () => createAutoHideSettings(createExtensionStorage("autohide")),
    [],
  );
  return (
    <div className="ps-embed">
      <AutoHideRow settings={settings} />
    </div>
  );
}

export function FunctionEditor({ editorKey }: { editorKey?: string }): ReactElement | null {
  switch (editorKey) {
    case "eq":
      return <EqEditor />;
    case "volume-processor":
      return <VolumeProcessorEditor />;
    case "autohide":
      return <AutoHideEditor />;
    default:
      return null;
  }
}
