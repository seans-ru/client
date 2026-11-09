/**
 * Room side panel (M10): members list with host badge, share link, leave.
 * Russian UI strings; token-only styling via `room.css`.
 */

import { useState } from "react";
import { Badge, Button } from "../../design/primitives";
import { isHost, memberLabel, roomShareUrl } from "./roomHelpers";
import type { RoomMember, RoomPresence, RoomState } from "./roomReducer";

export type RoomPanelProps = {
  code: string;
  state: RoomState;
  isHost: boolean;
  onLeave: () => void;
  onRetry?: () => void;
  /** Rendered inside the player sidecar (no own aside chrome). */
  embedded?: boolean;
};

function readinessBadge(presence: RoomPresence | undefined) {
  if (!presence || presence.ready == null) {
    return <Badge tone="neutral">Подключается</Badge>;
  }
  return presence.ready ? (
    <Badge tone="accent">Готов</Badge>
  ) : (
    <Badge tone="neutral">Не готов</Badge>
  );
}

function MemberRow({
  member,
  hostId,
  presence,
}: {
  member: RoomMember;
  hostId: string | null;
  presence: RoomPresence | undefined;
}) {
  const host = isHost(hostId, member.userId);
  return (
    <li className="room-member">
      <span className="room-member-name" title={member.userId}>
        {memberLabel(member)}
      </span>
      <span className="room-member-flags">
        {readinessBadge(presence)}
        {host ? <Badge tone="accent">Ведущий</Badge> : null}
      </span>
    </li>
  );
}

export function RoomPanel({
  code,
  state,
  isHost: localIsHost,
  onLeave,
  onRetry,
  embedded = false,
}: RoomPanelProps) {
  const [copied, setCopied] = useState(false);
  const shareUrl = roomShareUrl(code);

  const handleShare = () => {
    const finish = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(shareUrl).then(finish).catch(() => {
        window.prompt("Скопируйте ссылку на комнату:", shareUrl);
      });
    } else {
      window.prompt("Скопируйте ссылку на комнату:", shareUrl);
    }
  };

  const rootClass = embedded ? "room-panel room-panel-embedded" : "room-panel";
  const Root = embedded ? "div" : "aside";

  return (
    <Root className={rootClass} aria-label="Комната">
      <header className="room-panel-header">
        <h1 className="room-panel-title">Комната</h1>
        <p className="room-panel-code" title="Код комнаты">
          {code}
        </p>
        {localIsHost ? <Badge tone="accent">Вы ведущий</Badge> : null}
      </header>

      {state.error ? (
        <p className="room-panel-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <section className="room-members">
        <h2 className="room-panel-section-title">Участники</h2>
        {state.members.length === 0 ? (
          <p className="hint">В комнате пока никого нет.</p>
        ) : (
          <ul className="room-member-list">
            {state.members.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                hostId={state.hostId}
                presence={state.presence[member.userId]}
              />
            ))}
          </ul>
        )}
      </section>

      <footer className="room-panel-actions">
        <Button variant="secondary" size="sm" onClick={handleShare}>
          {copied ? "Скопировано" : "Скопировать ссылку"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onLeave}>
          Выйти из комнаты
        </Button>
        {state.status === "closed" && onRetry ? (
          <Button variant="primary" size="sm" onClick={onRetry}>
            Переподключиться
          </Button>
        ) : null}
      </footer>
    </Root>
  );
}
