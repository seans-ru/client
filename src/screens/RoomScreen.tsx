/**
 * Watch-party room screen (M10). Full-bleed: player column + side panel.
 *
 * Join path (deep link / `#/room/{code}`): GET /api/rooms/{code} → file id +
 * members → WS connect → host broadcasts `state`, guests apply remote frames.
 * Create path is unchanged (Library «Создать комнату» lands on this route).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { ROOM_CODE_PATTERN } from "../lib/deepLink";
import { ROUTES } from "../lib/routeResolver";
import { ErrorSlot, LoadingSlot } from "../design/slots";
import { Button } from "../design/primitives";
import { useAuth } from "../features/auth";
import { PlayerScreen } from "./PlayerScreen";
import type { RoomTransport, RoomTransportAction } from "./PlayerScreen";
import { RoomPanel, roomCloseMessage, useRoomDetail, useRoomSocket } from "../features/rooms";
import "../features/rooms/room.css";

function navigate(hash: string): void {
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

function BackHomeButton() {
  return (
    <div style={{ padding: "var(--space-4)" }}>
      <Button variant="ghost" size="sm" onClick={() => navigate(ROUTES.home)}>
        На главную
      </Button>
    </div>
  );
}

export function RoomScreen({ code }: { code: string }) {
  const valid = ROOM_CODE_PATTERN.test(code);
  const { user } = useAuth();
  const selfUserId = user?.id ?? null;

  const [reloadToken, setReloadToken] = useState(0);
  const [reconnectToken, setReconnectToken] = useState(0);

  const { detail, status: detailStatus, error: detailError, notFound } =
    useRoomDetail(code, valid, reloadToken);

  const transportRef = useRef<RoomTransport | null>(null);

  const getPosition = useCallback(() => {
    return transportRef.current?.getPosition() ?? 0;
  }, []);

  const applyRemote = useCallback(
    async (
      action: RoomTransportAction,
      position: number,
      isPlaying?: boolean,
    ) => {
      await transportRef.current?.apply(action, position, isPlaying);
    },
    [],
  );

  const initialMembers = useMemo(
    () =>
      detail?.members.map((m) => ({
        user_id: String(m.user_id),
        name: m.name ?? null,
      })),
    [detail],
  );
  const initialHostId = detail?.room.host_id ?? null;
  const wsUrl = detail?.room.ws_url ?? null;

  const room = useRoomSocket({
    code,
    wsUrl,
    selfUserId,
    enabled: valid && detailStatus === "ready" && detail != null,
    getPosition,
    applyRemote,
    initialMembers,
    initialHostId,
    reconnectToken,
  });

  // `sendState` is stable; keep a ref so `onTransport` identity stays constant.
  const sendStateRef = useRef(room.sendState);
  sendStateRef.current = room.sendState;
  const isHostRef = useRef(room.isHost);
  isHostRef.current = room.isHost;

  // Protocol: only the host broadcasts `state`. Guests apply remote frames
  // and send heartbeats; their local controls must not emit `state`.
  const handleTransport = useCallback(
    (action: RoomTransportAction, position: number) => {
      if (!isHostRef.current) return;
      sendStateRef.current(action, position);
    },
    [],
  );

  const leaveRef = useRef(room.leave);
  leaveRef.current = room.leave;

  const handleLeave = useCallback(() => {
    leaveRef.current();
    navigate(ROUTES.home);
  }, []);

  const handleRetry = useCallback(() => {
    setReloadToken((v) => v + 1);
    setReconnectToken((v) => v + 1);
  }, []);

  const fileId = useMemo(() => {
    const fromApi = detail?.room.task_file_id;
    if (fromApi != null && String(fromApi) !== "") return String(fromApi);
    // Host fallback: file id stashed at room creation (see LibraryList).
    try {
      const stash = sessionStorage.getItem(`seans.room.file.${code}`);
      if (stash) return stash;
    } catch {
      // ignore
    }
    return null;
  }, [detail, code]);

  if (!valid) {
    return (
      <div className="room-screen">
        <div className="room-player-slot">
          <ErrorSlot
            title="Неверный код комнаты"
            description="Код должен состоять из 8 символов (A–Z, 2–9)."
          />
          <BackHomeButton />
        </div>
      </div>
    );
  }

  if (detailStatus === "loading") {
    return (
      <div className="room-screen">
        <div className="room-player-slot">
          <LoadingSlot label="Подключение к комнате…" />
        </div>
      </div>
    );
  }

  if (detailStatus === "error" || detail == null) {
    return (
      <div className="room-screen">
        <div className="room-player-slot">
          <ErrorSlot
            title={
              notFound ? "Комната не найдена" : "Не удалось подключиться к комнате"
            }
            description={
              detailError ??
              "Комната недоступна. Проверьте код и попробуйте снова."
            }
            onRetry={handleRetry}
          />
          <BackHomeButton />
        </div>
      </div>
    );
  }

  if (fileId == null || fileId === "") {
    return (
      <div className="room-screen">
        <div className="room-player-slot">
          <ErrorSlot
            title="Не удалось открыть файл комнаты"
            description="Сервер не вернул файл для воспроизведения."
            onRetry={handleRetry}
          />
          <BackHomeButton />
        </div>
      </div>
    );
  }

  const closedMessage =
    room.state.status === "closed" ? roomCloseMessage(room.state.closeCode) : null;

  return (
    <div className="room-screen">
      <div className="room-player-slot">
        <PlayerScreen
          fileId={fileId}
          roomMode
          onTransport={handleTransport}
          transportRef={transportRef}
        />
        {closedMessage ? (
          <div className="room-status-overlay" role="alert">
            <p className="lede">{closedMessage}</p>
            <Button variant="primary" size="sm" onClick={handleRetry}>
              Переподключиться
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLeave}>
              На главную
            </Button>
          </div>
        ) : null}
      </div>
      <RoomPanel
        code={code}
        state={room.state}
        isHost={room.isHost}
        onLeave={handleLeave}
        onRetry={handleRetry}
      />
    </div>
  );
}
