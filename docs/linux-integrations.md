# Linux desktop integrations

The Linux client keeps the same frontend auth and Discord flows as Windows,
with the operating system services selected by the Rust target:

- JWTs use the Linux Secret Service through `keyring`'s
  `linux-secret-service` backend. A desktop keyring such as GNOME Keyring or
  KWallet must be available and unlocked. If the service cannot be reached,
  token save/load returns an error; the app does not write the JWT to a file.
- `discord-presence` uses Discord's Unix-domain IPC socket on Linux. The same
  worker and activity/join event flow is shared with Windows, where the crate
  connects over the Windows IPC transport.
- Tauri's deep-link bundle configuration declares `seans://` and Discord's
  `discord-<application-id>://` callback schemes. At startup the app writes a
  per-user desktop entry under `$XDG_DATA_HOME/applications` (or
  `~/.local/share/applications`) and asks `xdg-mime` to associate both
  `x-scheme-handler` types with it. For AppImage launches it uses the AppImage
  path rather than the temporary mounted executable path.

The desktop session needs `xdg-mime` for automatic protocol association and a
Secret Service implementation for persistent login. Discord Join callbacks
and OAuth callbacks are forwarded through the existing Tauri events, so the
frontend URL parsing and state validation remain unchanged.
