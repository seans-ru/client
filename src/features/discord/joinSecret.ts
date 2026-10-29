/**
 * Discord join-secret encode/decode (pure — no React/DOM/Tauri, unit-testable).
 *
 * Secret shape (base64url, unpadded — survives URL/argv transit on cold join):
 *   "{inviterUserId}:{roomCode}:{nonce}"
 * where `nonce` is a random per-room-session string so the secret is not a
 * plain room code. Decoding is lenient: standard base64 (with padding), bare
 * room codes, `seans://room/CODE` and raw `discord-{appId}://…` launch args
 * all resolve to the room code.
 */

import { ROOM_CODE_PATTERN } from "../../lib/deepLink";

export type JoinSecretParts = {
  /** Local user id — whose activity was clicked (inviter). */
  inviterUserId: string;
  /** Watch-party room code (`[A-Z2-9]{8}`). */
  roomCode: string;
  /** Random per-room-session string. */
  nonce: string;
};

/** Nonces are stable per room for the life of the process (one per session). */
const nonces = new Map<string, string>();

function randomNonce(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function getOrCreateJoinNonce(roomCode: string): string {
  let nonce = nonces.get(roomCode);
  if (!nonce) {
    nonce = randomNonce(12);
    nonces.set(roomCode, nonce);
  }
  return nonce;
}

function base64UrlEncode(raw: string): string {
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

export function encodeJoinSecret(parts: JoinSecretParts): string {
  return base64UrlEncode(
    `${parts.inviterUserId}:${parts.roomCode}:${parts.nonce}`,
  );
}

/** Decode the base64 secret form; other input shapes go through `extractRoomCode`. */
export function parseJoinSecret(secret: string): JoinSecretParts | null {
  const raw = base64UrlDecode(secret.trim());
  if (!raw) return null;
  const pieces = raw.split(":");
  if (pieces.length !== 3) return null;
  const [inviterUserId, roomCode, nonce] = pieces;
  if (!ROOM_CODE_PATTERN.test(roomCode)) return null;
  return { inviterUserId, roomCode, nonce };
}

function stripProtocolWrapping(input: string): string {
  let value = input.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // not URL-encoded — keep as-is
  }
  const secretParam = /[?&]secret=([^&]+)/.exec(value);
  if (secretParam) return secretParam[1];
  const flagParam = /--secret=(\S+)/.exec(value);
  if (flagParam) return flagParam[1];
  // `discord-{appId}://<payload>` → payload (may itself be a deep link).
  const protocol = /^discord-\d+:\/\/(.+)$/i.exec(value);
  if (protocol) return protocol[1];
  return value;
}

/**
 * Lenient room-code extraction from any join payload form: a bare code,
 * `seans://room/CODE`, a base64 secret, or a raw Discord launch URL wrapping
 * one of those.
 */
export function extractRoomCode(input: string): string | null {
  if (!input) return null;
  let value = stripProtocolWrapping(input);

  if (ROOM_CODE_PATTERN.test(value)) return value;

  const deepLink = /seans:\/\/room\/([A-Z2-9]{8})/i.exec(value);
  if (deepLink) return deepLink[1].toUpperCase();

  // Nested wrapping (protocol URL around another encoded form).
  if (value !== input.trim()) {
    const nested = extractRoomCode(value);
    if (nested) return nested;
  }

  const parsed = parseJoinSecret(value);
  return parsed ? parsed.roomCode : null;
}
