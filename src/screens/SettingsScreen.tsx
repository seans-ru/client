/**
 * Settings (ui-ux-redesign): Account first (quota meter + logout), then
 * updates/version and playback notes. Dark-only — no theme cycler.
 */

import { useMemo } from "react";
import { Button, ProgressBar } from "../design/primitives";
import { Screen } from "../design/slots";
import { useAuth } from "../features/auth";
import { useLibrary } from "../features/library";
import { UpdateSettingsSection } from "../features/updater";
import { openNetworkPanel } from "../features/debug/NetworkPanel";
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
      <div className="settings-grid">
        <div className="settings-column">
          <section className="panel account-panel" aria-label="Аккаунт">
            <div className="settings-panel-heading">
              <strong>Аккаунт</strong>
              {user ? (
                <div className="account-identity">
                  {user.display_name ? <span className="hint">{user.email}</span> : null}
                  <strong>{user.display_name || user.email}</strong>
                </div>
              ) : (
                <p className="lede">Сессия не найдена.</p>
              )}
            </div>
            {user ? (
              <>
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
                  <Button
                    variant="secondary"
                    className="account-logout"
                    onClick={() => void logout()}
                  >
                    Выйти
                  </Button>
                </div>
              </>
            ) : (
              <a className="btn btn-primary" href={ROUTES.login}>
                Войти
              </a>
            )}
          </section>

          <UpdateSettingsSection />

          <div className="panel">
            <div className="settings-panel-heading">
              <strong>О приложении</strong>
              <p className="hint">Seans Client · версия обновления показана выше.</p>
            </div>
          </div>
        </div>

        <div className="settings-column">
          <div className="panel">
            <div className="settings-panel-heading">
              <strong>Оформление</strong>
              <p className="hint">Тёмная тема (home theater). Светлая тема отключена.</p>
            </div>
          </div>

          <div className="panel">
            <div className="settings-panel-heading">
              <strong>Воспроизведение</strong>
              <p className="hint">
                Аппаратное декодирование: авто (d3d11 / dxva2), программный резервный
                режим включается автоматически при сбое.
              </p>
            </div>
          </div>

          <div className="panel">
            <div className="settings-panel-heading">
              <strong>Диагностика</strong>
              <p className="hint">
                Сетевые запросы приложения: метод, URL, статус, заголовки и тела
                request/response. Открывается и хоткеем Ctrl+Shift+H.
              </p>
            </div>
            <div className="state-actions">
              <Button variant="secondary" onClick={openNetworkPanel}>
                Сетевые запросы
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Screen>
  );
}
