/**
 * Settings panel for updates (M11): version row, manual check button,
 * download/install status. Subtitle prefs remain a later stub.
 */

import { useState } from "react";
import { Button, ProgressBar } from "../../design/primitives";
import { formatBytes } from "../../lib/format";
import { downloadPercent, updatePhaseLabel } from "./updatePolicy";
import { useUpdater } from "./UpdaterProvider";

export function UpdateSettingsSection() {
  const {
    phase,
    appVersion,
    availableVersion,
    progress,
    error,
    applyOnExitPending,
    checkNow,
    restartNow,
    applyOnExit,
  } = useUpdater();
  const [checking, setChecking] = useState(false);

  const percent =
    progress != null
      ? downloadPercent(progress.downloadedBytes, progress.totalBytes)
      : null;
  const progressLabel =
    progress != null
      ? progress.totalBytes != null
        ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
        : formatBytes(progress.downloadedBytes)
      : null;

  const onCheck = async () => {
    setChecking(true);
    try {
      await checkNow();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="panel">
      <div className="settings-panel-heading">
        <strong>Обновления</strong>
        <p className="hint">
          Версия приложения: {appVersion ?? "недоступна"}.
          {availableVersion ? ` Доступна версия ${availableVersion}.` : ""}
        </p>
      </div>
      <p className="hint">Статус: {updatePhaseLabel(phase)}.</p>
      {progressLabel && phase === "downloading" ? (
        percent != null ? (
          <ProgressBar
            value={percent}
            max={100}
            label={`Загрузка: ${progressLabel}`}
          />
        ) : (
          <p className="hint">Загрузка: {progressLabel}</p>
        )
      ) : null}
      {error ? <p className="hint update-settings-error">{error}</p> : null}
      {applyOnExitPending ? (
        <p className="hint">Обновление установится при выходе из приложения.</p>
      ) : null}
      <div className="update-settings-actions">
        <Button variant="secondary" onClick={() => void onCheck()} disabled={checking || phase === "downloading" || phase === "applying"}>
          {checking || phase === "checking" ? "Проверка…" : "Проверить обновления"}
        </Button>
        {(phase === "ready" || phase === "applying") && (
          <Button
            variant="primary"
            onClick={() => void restartNow()}
            disabled={phase === "applying"}
          >
            Перезапустить сейчас
          </Button>
        )}
        {phase === "ready" && !applyOnExitPending && (
          <Button variant="ghost" onClick={applyOnExit}>
            Установить при выходе
          </Button>
        )}
      </div>
      <p className="hint">
        Проверка выполняется автоматически при запуске и каждые 6 часов.
      </p>
    </div>
  );
}
