/**
 * Settings (ui-ux-redesign): Account first (quota meter + logout), then
 * updates/version and playback notes. Dark-only — no theme cycler.
 */

import { useMemo } from "react";
import { Badge, Button, ProgressBar } from "../design/primitives";
import { Screen } from "../design/slots";
import { useAuth } from "../features/auth";
import { useLibrary } from "../features/library";
import { UpdateSettingsSection } from "../features/updater";
import { formatBytes } from "../lib/format";
import { ROUTES } from "../lib/routeResolver";

function usedBytesFrom(
  usedBytes: number | undefined,
  libraryTotal: number,
): number {
  if (typeof usedBytes === "number" && Number.isFinite(usedBytes) && usedBytes >= 0) {
    return usedBytes;
  }
  return libraryTotal;
}

export function SettingsScreen() {
  const { user, logout } = useAuth();
  const { items } = useLibrary();

  const libraryTotal = useMemo(
    () => items.reduce((sum, item) => sum + (item.total_size || 0), 0),
    [items],
  );

  const used = usedBytesFrom(user?.used_bytes, libraryTotal);
  const quota = user?.quota_bytes ?? 0;
  const quotaPct =
    quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;

  return (
    <Screen title="Настройки">
      <section className="panel account-panel" aria-label="Аккаунт">
        <Badge tone="accent">Аккаунт</Badge>
        {user ? (
          <>
            <strong>{user.display_name || user.email}</strong>
            <p className="hint">{user.email}</p>
            <div className="account-quota">
              <div className="account-quota-label">
                <span>Место</span>
                <span className="hint">
                  {formatBytes(used)} из {quota > 0 ? formatBytes(quota) : "—"}
                </span>
              </div>
              <ProgressBar
                value={quotaPct}
                label={quota > 0 ? `${quotaPct}%` : "Квота не указана"}
              />
            </div>
            <div className="state-actions">
              <Button variant="secondary" onClick={() => void logout()}>
                Выйти
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="lede">Сессия не найдена.</p>
            <a className="btn btn-primary" href={ROUTES.login}>
              Войти
            </a>
          </>
        )}
      </section>

      <div className="panel">
        <strong>Оформление</strong>
        <p className="hint">Тёмная тема (home theater). Светлая тема отключена.</p>
      </div>

      <UpdateSettingsSection />

      <div className="panel">
        <strong>Воспроизведение</strong>
        <p className="hint">
          Аппаратное декодирование: авто (d3d11 / dxva2), программный резервный
          режим включается автоматически при сбое.
        </p>
      </div>

      <div className="panel">
        <strong>О приложении</strong>
        <p className="hint">Seans Client · версия обновления показана выше.</p>
      </div>
    </Screen>
  );
}
