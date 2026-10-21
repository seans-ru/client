/**
 * Home: cinematic chart backdrop + centered catalog search.
 * Chart posters are decorative chrome; search is the product CTA.
 */

import { PosterCard } from "../design/primitives";
import { useChart } from "../features/catalog";
import { SearchPanel } from "../features/search";
import { ROUTES } from "../lib/routeResolver";
import type { MediaSearchResult } from "../api/types";

function heroPosterClass(index: number): string {
  const variant = index % 5;
  return `home-hero-poster home-hero-poster-${variant}`;
}

function ChartBackdrop({ items }: { items: MediaSearchResult[] }) {
  if (items.length === 0) {
    return <div className="home-hero-backdrop home-hero-backdrop-empty" aria-hidden="true" />;
  }

  return (
    <div className="home-hero-backdrop">
      <div className="home-hero-grid">
        {items.slice(0, 12).map((item, index) => (
          <a
            key={String(item.id)}
            className={heroPosterClass(index)}
            href={ROUTES.media(item.id)}
            title={item.title}
          >
            {item.poster_url ? (
              <img src={item.poster_url} alt="" loading="lazy" />
            ) : (
              <div className="home-hero-poster-fallback" aria-hidden="true">
                {item.title.slice(0, 1)}
              </div>
            )}
            <span className="visually-hidden">{item.title}</span>
          </a>
        ))}
      </div>
      <div className="home-hero-scrim" />
    </div>
  );
}

function ChartStrip({ items }: { items: MediaSearchResult[] }) {
  if (items.length === 0) return null;

  return (
    <section className="home-chart" aria-label="В чарте">
      <div className="home-chart-head">
        <h2>В чарте</h2>
        <span className="hint">Популярные сериалы</span>
      </div>
      <div className="home-chart-row" role="list">
        {items.map((item) => (
          <div key={String(item.id)} role="listitem" className="home-chart-item">
            <PosterCard
              title={item.title}
              subtitle={item.year > 0 ? String(item.year) : undefined}
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
          <p className="home-hero-lede">
            Найдите фильм или сериал, соберите торрент и смотрите — одни или с друзьями в комнате.
          </p>
          <div className="home-hero-search">
            <SearchPanel />
          </div>
        </div>
      </section>
      <ChartStrip items={chart} />
    </div>
  );
}
