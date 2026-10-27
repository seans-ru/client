/**
 * Account screen: identity, subscription plan, quota summary, invite keys.
 * Invite creation uses `POST /api/auth/invite-keys` (requires `can_invite`).
 */

import { useCallback, useState } from "react";
import { Badge, Button } from "../design/primitives";
import { Screen } from "../design/slots";
import { createInviteKey } from "../api/endpoints";
import { useAuth } from "../features/auth";
import { formatBytes } from "../lib/format";
import { ROUTES } from "../lib/routeResolver";

function planLabel(plan: string | undefined): string {
  switch (String(plan ?? "").toLowerCase()) {
    case "free":
      return "Free";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    default:
      return plan || "—";
  }
}

export function AccountScreen() {
  const { user, logout } = useAuth();
  const [inviteKey, setInviteKey] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCreateInvite = useCallback(() => {
    setInviteError(null);
    setCopied(false);
    setCreatingInvite(true);
    void (async () => {
      try {
        const res = await createInviteKey();
        setInviteKey(res.key || null);
        if (!res.key) setInviteError("Сервер не вернул ключ.");
      } catch (cause) {
        setInviteError(
          cause instanceof Error ? cause.message : "Не удалось создать ключ",
        );
      } finally {
        setCreatingInvite(false);
      }
    })();
  }, []);

  const handleCopyInvite = useCallback(() => {
    if (!inviteKey) return;
    void (async () => {
      try {
        await navigator.clipboard.writeText(inviteKey);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    })();
  }, [inviteKey]);

  return (
    <Screen title="Аккаунт">
      {user ? (
        <div className="panel">
          <Badge tone="accent">Вход выполнен</Badge>
          <strong>{user.display_name || user.email}</strong>
          <p className="hint">{user.email}</p>

          <dl className="account-facts">
            <div>
              <dt>Тариф</dt>
              <dd>
                {planLabel(user.plan)}
                {user.plan_expires_at
                  ? ` · до ${String(user.plan_expires_at).slice(0, 10)}`
                  : user.plan
                    ? " · бессрочно"
                    : ""}
              </dd>
            </div>
            <div>
              <dt>Квота</dt>
              <dd>
                {formatBytes(user.used_bytes ?? 0)} из{" "}
                {user.quota_bytes > 0 ? formatBytes(user.quota_bytes) : "—"}
              </dd>
            </div>
            {user.is_admin != null ? (
              <div>
                <dt>Роль</dt>
                <dd>{user.is_admin ? "Администратор" : "Пользователь"}</dd>
              </div>
            ) : null}
          </dl>

          {user.can_invite ? (
            <section className="account-invite" aria-label="Приглашения">
              <h3>Приглашения</h3>
              <p className="hint">
                Ключ одноразовый — передайте его тому, кого хотите позвать.
              </p>
              <div className="state-actions">
                <Button
                  variant="secondary"
                  onClick={handleCreateInvite}
                  disabled={creatingInvite}
                >
                  {creatingInvite ? "Создание…" : "Создать ключ"}
                </Button>
                {inviteKey ? (
                  <Button variant="ghost" onClick={handleCopyInvite}>
                    {copied ? "Скопировано" : "Скопировать"}
                  </Button>
                ) : null}
              </div>
              {inviteKey ? (
                <p className="account-invite-key" data-testid="invite-key">
                  {inviteKey}
                </p>
              ) : null}
              {inviteError ? (
                <p className="release-feedback release-feedback-error" role="alert">
                  {inviteError}
                </p>
              ) : null}
            </section>
          ) : null}

          <div className="state-actions">
            <Button variant="secondary" onClick={() => void logout()}>
              Выйти
            </Button>
          </div>
        </div>
      ) : (
        <div className="panel">
          <Badge tone="neutral">Не выполнен</Badge>
          <p className="lede">Сессия не найдена.</p>
          <a className="btn btn-primary" href={ROUTES.login}>
            Войти
          </a>
        </div>
      )}
    </Screen>
  );
}
