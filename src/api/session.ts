/**
 * JWT session storage.
 *
 * The token lives in memory for the request layer and is persisted ONLY via the
 * OS credential store (Rust `keyring` crate: service `seans`, account `session`).
 * Windows uses Credential Manager; Linux uses Secret Service. It is never
 * written to localStorage or any other JS-visible disk store.
 */

import { invoke } from "@tauri-apps/api/core";

/** Keyring service/account used by the Rust side (kept in sync with commands.rs). */
export const KEYRING_SERVICE = "seans";
export const KEYRING_ACCOUNT = "session";

let memoryToken: string | null = null;

/** In-memory token used by `Authorization: Bearer …` headers. */
export function getSessionToken(): string | null {
  return memoryToken;
}

/** Replace the in-memory token (does not touch the keyring). */
export function setSessionToken(token: string | null): void {
  memoryToken = token && token.length > 0 ? token : null;
}

/** Persist the token to the OS credential store and keep it in memory. */
export async function saveSessionToken(token: string): Promise<void> {
  setSessionToken(token);
  await invoke("save_token", { token });
}

/** Load the token from the OS credential store into memory. Null when absent. */
export async function loadSessionToken(): Promise<string | null> {
  const token = await invoke<string | null>("load_token");
  setSessionToken(token ?? null);
  return getSessionToken();
}

/** Clear the token from memory and from the Credential Manager. */
export async function clearSessionToken(): Promise<void> {
  setSessionToken(null);
  await invoke("clear_token");
}
