/**
 * App-level Discord join router: decode `discord://join` payloads and land in
 * `#/room/{code}` (the room screen owns the REST/WS join from there).
 *
 * Sources covered: the warm IPC event, cold-launch argv (forwarded by
 * single-instance as the same event), and the Rust pending buffer consumed at
 * mount (the secret can arrive before React listens). The code is held until
 * the user is authenticated so a join survives the login gate.
 */

import { useCallback, useEffect, useRef } from "react";
import { ROUTES } from "../../lib/routeResolver";
import { useAuth } from "../auth";
import { onDiscordJoin, takePendingJoin } from "./discordApi";
import { extractRoomCode } from "./joinSecret";

export function useDiscordJoin(): void {
  const { status } = useAuth();
  const statusRef = useRef(status);
  statusRef.current = status;
  const codeRef = useRef<string | null>(null);

  const flush = useCallback(() => {
    if (statusRef.current !== "authenticated") return;
    const code = codeRef.current;
    if (!code) return;
    codeRef.current = null;
    const route = ROUTES.room(code);
    if (window.location.hash !== route) {
      window.location.hash = route;
    }
  }, []);

  useEffect(() => {
    const accept = (secret: string) => {
      const code = extractRoomCode(secret);
      if (code) {
        codeRef.current = code;
        flush();
      }
    };

    const stop = onDiscordJoin(accept);
    void takePendingJoin().then((secret) => {
      if (secret) accept(secret);
    });
    return stop;
  }, [flush]);

  // Login completed with a join pending → open the room.
  useEffect(() => flush(), [status, flush]);
}
