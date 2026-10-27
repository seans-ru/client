/**
 * Media detail view (M4 + M5): poster, metadata, KP rating, releases,
 * reviews + review form.
 */

import type { ApiId, MediaDetail, ReviewResponse } from "../../api/types";
import {
  EmptyState,
  ErrorState,
  PosterCard,
  RatingStars,
  Spinner,
} from "../../design/primitives";
import { ReleaseList, useMediaReleases } from "../releases";
import { ReviewForm, ReviewList } from "../reviews";
import { useMediaDetail } from "./useMediaDetail";

function formatUpdatedAt(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU");
}

function MediaOverview({ detail }: { detail: MediaDetail }) {
  return (
    <div className="media-detail">
      <div className="media-poster-col">
        <PosterCard
          title={detail.title}
          posterUrl={detail.poster_url}
          rating={detail.rating_kp}
        />
      </div>
      <div className="media-info-col">
        <h2 className="media-title">{detail.title}</h2>
        {detail.original_title && detail.original_title !== detail.title ? (
          <p className="media-original-title">{detail.original_title}</p>
        ) : null}

        <p className="media-meta">
          {detail.year != null && detail.year > 0 ? <span>{detail.year}</span> : null}
          {detail.year != null && detail.year > 0 && detail.genres.length > 0 ? <span aria-hidden="true"> · </span> : null}
          {detail.genres.length > 0 ? <span>{detail.genres.join(", ")}</span> : null}
        </p>

        <div className="media-rating">
          <RatingStars value={detail.rating_kp} />
          <span className="media-rating-text">
            {detail.rating_kp != null
              ? `Кинопоиск: ${detail.rating_kp}`
              : "Нет оценки Кинопоиска"}
          </span>
        </div>

        {detail.overview ? (
          <p className="media-overview">{detail.overview}</p>
        ) : (
          <p className="hint">Описание отсутствует.</p>
        )}

        <p className="hint">Обновлено: {formatUpdatedAt(detail.updated_at)}</p>
      </div>
    </div>
  );
}

export function MediaDetailPanel({
  mediaId,
  currentUserId,
}: {
  mediaId: string;
  currentUserId?: ApiId | null;
}) {
  const {
    detail,
    reviews,
    status,
    reviewsStatus,
    error,
    reviewsError,
    refresh,
  } = useMediaDetail(mediaId);

  const releasesState = useMediaReleases(mediaId);

  const handleSubmitted = (_review: ReviewResponse) => {
    refresh();
  };

  if (status === "loading") {
    return <Spinner label="Загрузка фильма…" />;
  }

  if (status === "error") {
    return (
      <ErrorState
        title="Не удалось загрузить фильм"
        description={error ?? "Проверьте подключение к интернету и повторите попытку."}
        onRetry={refresh}
      />
    );
  }

  if (!detail) {
    return (
      <EmptyState
        title="Данные о фильме не найдены"
        description="Попробуйте обновить страницу или вернуться на главную."
      />
    );
  }

  return (
    <div className="media-panel">
      <MediaOverview detail={detail} />

      <section className="media-releases" aria-label="Релизы">
        <h3>Релизы</h3>
        <ReleaseList
          releases={releasesState.releases}
          loading={releasesState.status === "loading"}
          error={releasesState.status === "error" ? releasesState.error : null}
          refreshing={releasesState.refreshing}
          onRetry={releasesState.reload}
          onRefresh={releasesState.refreshFromTrackers}
        />
      </section>

      <section className="media-reviews" aria-label="Отзывы">
        <h3>Отзывы</h3>
        <ReviewList
          reviews={reviews}
          loading={reviewsStatus === "loading"}
          error={reviewsStatus === "error" ? reviewsError : null}
          onRetry={refresh}
          detail={detail}
          currentUserId={currentUserId}
        />
      </section>

      <ReviewForm
        mediaId={detail.id}
        detail={detail}
        reviews={reviews}
        currentUserId={currentUserId}
        onSubmitted={handleSubmitted}
      />
    </div>
  );
}
