/**
 * Search input + poster grid (M4). Russian UI strings.
 * Clicking a result navigates to `#/media/{id}`.
 */

import {
  PosterCard,
  JacredAttribution,
  Spinner,
  EmptyState,
  ErrorState,
} from "../../design/primitives";
import { ROUTES } from "../../lib/routeResolver";
import type { MediaSearchResult } from "../../api/types";
import { useMediaSearch } from "./useMediaSearch";
import { SEARCH_MIN_QUERY_LENGTH } from "./searchHelpers";

function mediaSubtitle(item: MediaSearchResult): string {
  const parts: string[] = [];
  if (item.year != null && item.year > 0) parts.push(String(item.year));
  if (item.kp_type) parts.push(item.kp_type);
  return parts.join(" · ");
}

export function SearchPanel() {
  const { query, results, status, error, setQuery, retry } = useMediaSearch();

  return (
    <div className="search-panel">
      <label className="input-field" htmlFor="catalog-search">
        <span className="input-label">Поиск</span>
        <div className="search-input-row">
          <input
            id="catalog-search"
            className="input"
            type="search"
            placeholder="Название фильма или сериала…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            aria-describedby="catalog-search-hint"
          />
          <JacredAttribution />
        </div>
        <span className="input-hint" id="catalog-search-hint">
          {`Введите минимум ${SEARCH_MIN_QUERY_LENGTH} символа, чтобы начать поиск.`}
        </span>
      </label>

      {status === "loading" ? (
        <Spinner label="Поиск…" />
      ) : null}

      {status === "error" ? (
        <ErrorState
          title="Не удалось выполнить поиск"
          description={error ?? "Проверьте подключение к интернету и повторите попытку."}
          onRetry={retry}
        />
      ) : null}

      {status === "idle" && query.trim().length === 0 ? (
        <EmptyState
          title="Найдите фильм или сериал"
          description="Введите название в поле поиска, чтобы увидеть результаты."
        />
      ) : null}

      {status === "idle" && query.trim().length > 0 ? (
        <EmptyState
          title="Слишком короткий запрос"
          description={`Введите минимум ${SEARCH_MIN_QUERY_LENGTH} символа для поиска.`}
        />
      ) : null}

      {status === "ready" && results.length === 0 ? (
        <EmptyState
          title="Ничего не найдено"
          description="Попробуйте изменить запрос или проверьте написание."
        />
      ) : null}

      {status === "ready" && results.length > 0 ? (
        <div className="poster-grid" role="list">
          {results.map((item) => (
            <div key={String(item.id)} role="listitem">
              <PosterCard
                title={item.title}
                subtitle={mediaSubtitle(item)}
                posterUrl={item.poster_url}
                rating={item.rating_kp}
                href={ROUTES.media(item.id)}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
