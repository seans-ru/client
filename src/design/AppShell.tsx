/**
 * App chrome: three destinations (Home, Library, Settings).
 *
 * Player and room routes are full-bleed (no nav) — see `isFullBleedRoute`.
 * Account lives inside Settings; dark-only violet palette (no theme cycler).
 */

import { useEffect } from "react";
import type { ReactNode } from "react";
import { useAuth } from "../features/auth";
import { UpdateBanner } from "../features/updater";
import { ROUTES, isFullBleedRoute } from "../lib/routeResolver";
import { Button } from "./primitives";

type NavItem = { href: string; label: string };

export const NAV_ITEMS: readonly NavItem[] = [
  { href: ROUTES.home, label: "Главная" },
  { href: ROUTES.library, label: "Библиотека" },
  { href: ROUTES.settings, label: "Настройки" },
];

function NavFooter() {
  const { user, logout } = useAuth();
  const name = user ? user.display_name || user.email : null;

  return (
    <footer className="nav-footer">
      {name ? (
        <>
          <a className="nav-user" href={ROUTES.settings} title={name}>
            {name}
          </a>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            Выйти
          </Button>
        </>
      ) : null}
    </footer>
  );
}

function SideNav({ route }: { route: string }) {
  return (
    <nav className="app-nav" aria-label="Основная навигация">
      <div className="nav-brand">Seans</div>
      <ul className="nav-items">
        {NAV_ITEMS.map((item) => {
          const selected =
            item.href === ROUTES.home
              ? route === ROUTES.home
              : route === item.href || route.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <a
                className={`nav-link${selected ? " nav-link-selected" : ""}`}
                href={item.href}
                aria-current={selected ? "page" : undefined}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
      <NavFooter />
    </nav>
  );
}

export function AppShell({
  route,
  children,
}: {
  route: string;
  children: ReactNode;
}) {
  const fullBleed = isFullBleedRoute(route);

  // Player / room: transparent WebView chrome so libmpv video shows behind.
  useEffect(() => {
    const body = document.body;
    body.classList.toggle("player-chrome", fullBleed);
    return () => body.classList.remove("player-chrome");
  }, [fullBleed]);

  // Full-bleed chrome: player / room (and any future immersive surface).
  if (fullBleed) {
    return <div className="app-fullbleed">{children}</div>;
  }

  return (
    <div className="app-shell">
      <SideNav route={route} />
      <main className="app-content">
        <UpdateBanner />
        {children}
      </main>
    </div>
  );
}
