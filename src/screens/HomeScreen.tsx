/**
 * Home: cinematic chart backdrop + centered catalog search.
 * Chart posters are decorative chrome; search is the product CTA.
 */

import { useEffect, useRef } from "react";
import { PosterCard } from "../design/primitives";
import { useChart } from "../features/catalog";
import { SearchPanel } from "../features/search";
import { ROUTES } from "../lib/routeResolver";
import type { MediaSearchResult } from "../api/types";

/** Map a wheel gesture to a horizontal scroll delta, in pixels. */
function chartWheelDelta(event: WheelEvent, viewportWidth: number): number {
  const dominant =
    Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return dominant * 40;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return dominant * viewportWidth;
  return dominant;
}

function ChartBackdrop({ items }: { items: MediaSearchResult[] }) {
  if (items.length === 0) {
    return <div className="home-hero-backdrop home-hero-backdrop-empty" aria-hidden="true" />;
  }

  return (
    <div className="home-hero-backdrop" aria-hidden="true">
      <div className="home-hero-grid">
        {items.slice(0, 12).map((item) => (
          <div key={String(item.id)} className="home-hero-poster">
            {item.poster_url ? (
              <img src={item.poster_url} alt="" loading="lazy" />
            ) : (
              <div className="home-hero-poster-fallback">
                {item.title.slice(0, 1)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="home-hero-scrim" />
    </div>
  );
}

function ChartStrip({ items }: { items: MediaSearchResult[] }) {
  const sectionRef = useRef<HTMLElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const row = rowRef.current;
    if (!section || !row) return;

    const onWheel = (event: WheelEvent) => {
      const maxScroll = row.scrollWidth - row.clientWidth;
      if (maxScroll <= 1) return;

      const delta = chartWheelDelta(event, row.clientWidth);
      if (delta === 0) return;

      const atStart = row.scrollLeft <= 0 && delta < 0;
      const atEnd = row.scrollLeft >= maxScroll - 1 && delta > 0;
      if (atStart || atEnd) return;

      event.preventDefault();
      row.scrollLeft += delta;
    };

    section.addEventListener("wheel", onWheel, { passive: false });
    return () => section.removeEventListener("wheel", onWheel);
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <section className="home-chart" aria-label="В чарте" ref={sectionRef}>
      <div className="home-chart-head">
        <h2>В чарте</h2>
        <span className="hint">Популярные сериалы</span>
      </div>
      <div className="home-chart-row" role="list" ref={rowRef}>
        {items.map((item) => (
          <div key={String(item.id)} role="listitem" className="home-chart-item">
            <PosterCard
              title={item.title}
              subtitle={item.year != null && item.year > 0 ? String(item.year) : undefined}
              posterUrl={item.poster_url}
              rating={item.rating_kp}
              href={ROUTES.media(item.id)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function HomeScreen() {
  const { items: chart } = useChart(20);

  return (
    <div className="home-screen">
      <section className="home-hero">
        <ChartBackdrop items={chart} />
        <div className="home-hero-content">
          <p className="home-hero-kicker">Seans</p>
          <h1 className="home-hero-title">Выберите фильм на вечер</h1>
          {/* <p className="home-hero-lede">
            Найдите фильм или сериал, соберите торрент и смотрите — одни или с друзьями в комнате.
          </p> */}
          <div className="home-hero-search">
            <SearchPanel />
          </div>
        </div>
      </section>
      <ChartStrip items={chart} />
    </div>
  );
}
