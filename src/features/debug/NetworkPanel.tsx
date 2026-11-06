/**
 * In-app network diagnostics panel (issue #58).
 *
 * The desktop shell runs HTTP through `tauri-plugin-http`, so the browser
 * Network tab is useless. This panel lists every app request (method, URL,
 * status, timing) with full request/response headers and bodies from
 * `lib/httpLog`. Open with Ctrl+Shift+H or from Settings.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { httpLog, type HttpLogEntry } from "../../lib/httpLog";
import "./networkPanel.css";

export const NETWORK_PANEL_OPEN_EVENT = "seans:network-panel-open";

const STATUS_FILTERS = [
  { id: "all", label: "Все" },
  { id: "error", label: "Ошибки" },
  { id: "ok", label: "Успешные" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["id"];

function statusClass(entry: HttpLogEntry): string {
  if (entry.error != null || entry.status == null) {
    return entry.status == null && entry.error == null
      ? "network-panel-status-pending"
      : "network-panel-status-error";
  }
  if (entry.status < 300) return "network-panel-status-ok";
  if (entry.status < 400) return "network-panel-status-warn";
  return "network-panel-status-error";
}

function statusText(entry: HttpLogEntry): string {
  if (entry.error != null) return "ERR";
  if (entry.status == null) return "…";
  return String(entry.status);
}

function formatTime(startedAt: number): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function formatBody(body: string | null): string {
  if (body == null || body.length === 0) return "—";
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

function HeadersTable({
  headers,
}: {
  headers: Record<string, string> | null;
}): ReactElement {
  const rows = Object.entries(headers ?? {});
  if (rows.length === 0) {
    return <p className="hint">—</p>;
  }
  return (
    <table className="network-panel-headers">
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <td>{key}</td>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EntryDetail({
  entry,
  onBack,
}: {
  entry: HttpLogEntry;
  onBack: () => void;
}): ReactElement {
  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(JSON.stringify(entry, null, 2))
      .catch(() => {});
  }, [entry]);

  return (
    <div className="network-panel-detail">
      <div className="network-panel-toolbar">
        <button type="button" className="network-panel-back" onClick={onBack}>
          ← Назад
        </button>
        <span className={`network-panel-status ${statusClass(entry)}`}>
          {statusText(entry)}
        </span>
        <span className="network-panel-method">{entry.method}</span>
        <span className="network-panel-url" title={entry.url}>
          {shortUrl(entry.url)}
        </span>
        <button type="button" className="network-panel-back" onClick={copy}>
          Копировать
        </button>
      </div>

      <div className="network-panel-scroll">
        <section className="network-panel-section">
          <h3 className="network-panel-section-title">Обзор</h3>
          <div className="network-panel-kv">
            <span>
              URL: <strong>{entry.url}</strong>
            </span>
            <span>
              Время: <strong>{formatTime(entry.startedAt)}</strong>
            </span>
            <span>
              Длительность:{" "}
              <strong>
                {entry.durationMs == null ? "—" : `${entry.durationMs} мс`}
              </strong>
            </span>
            <span>
              Источник: <strong>{entry.kind}</strong>
            </span>
          </div>
          {entry.error != null ? (
            <p className="hint">Ошибка: {entry.error}</p>
          ) : null}
          {entry.resBodyTruncated ? (
            <p className="hint">Тело ответа обрезано</p>
          ) : null}
        </section>

        <section className="network-panel-section">
          <h3 className="network-panel-section-title">Запрос</h3>
          <HeadersTable headers={entry.reqHeaders} />
          <pre className="network-panel-body">{formatBody(entry.reqBody)}</pre>
        </section>

        <section className="network-panel-section">
          <h3 className="network-panel-section-title">Ответ</h3>
          <HeadersTable headers={entry.resHeaders} />
          <pre className="network-panel-body">{formatBody(entry.resBody)}</pre>
        </section>
      </div>
    </div>
  );
}

export function NetworkPanel(): ReactElement | null {
  const entries = useSyncExternalStore(httpLog.subscribe, httpLog.getEntries);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  // Hotkey + open request from other screens (Settings row).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.code === "KeyH") {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(NETWORK_PANEL_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(NETWORK_PANEL_OPEN_EVENT, onOpen);
    };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filter === "error" && entry.error == null) {
        if (entry.status == null || entry.status < 400) return false;
      }
      if (filter === "ok" && (entry.error != null || entry.status == null || entry.status >= 400)) {
        return false;
      }
      if (needle.length === 0) return true;
      return (
        entry.url.toLowerCase().includes(needle) ||
        entry.method.toLowerCase().includes(needle) ||
        String(entry.status ?? "").includes(needle)
      );
    });
  }, [entries, query, filter]);

  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );

  if (!open) return null;

  return (
    <aside className="network-panel" aria-label="Сетевые запросы">
      <div className="network-panel-header">
        <span className="network-panel-title">Сетевые запросы</span>
        <span className="network-panel-count">{entries.length}</span>
        <input
          className="network-panel-search"
          type="search"
          placeholder="Поиск: URL, метод, статус"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="network-panel-back"
          onClick={() => httpLog.clear()}
        >
          Очистить
        </button>
        <button
          type="button"
          className="network-panel-back"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
      </div>

      <div className="network-panel-filters">
        {STATUS_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`network-panel-chip${filter === item.id ? " network-panel-chip-active" : ""}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
        <span className="hint" style={{ marginLeft: "auto" }}>
          Ctrl+Shift+H
        </span>
      </div>

      {selected ? (
        <EntryDetail entry={selected} onBack={() => setSelectedId(null)} />
      ) : (
        <div className="network-panel-list">
          {visible.length === 0 ? (
            <p className="network-panel-empty">Запросов пока нет</p>
          ) : (
            visible.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`network-panel-row${selectedId === entry.id ? " network-panel-row-selected" : ""}`}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className={`network-panel-status ${statusClass(entry)}`}>
                  {statusText(entry)}
                </span>
                <span className="network-panel-method">{entry.method}</span>
                <span className="network-panel-url" title={entry.url}>
                  {shortUrl(entry.url)}
                </span>
                <span className="network-panel-meta">
                  {formatTime(entry.startedAt)}
                  {entry.durationMs != null ? ` · ${entry.durationMs} мс` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </aside>
  );
}

/** Open the panel from anywhere (Settings row). */
export function openNetworkPanel(): void {
  window.dispatchEvent(new Event(NETWORK_PANEL_OPEN_EVENT));
}
