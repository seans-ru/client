/** Design system barrel (M3). */
export {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  JacredAttribution,
  Modal,
  PosterCard,
  ProgressBar,
  RatingStars,
  Row,
  Spinner,
} from "./primitives";
export type {
  BadgeTone,
  ButtonSize,
  ButtonVariant,
} from "./primitives";
export {
  applyTheme,
  getTheme,
  nextTheme,
  normalizeTheme,
  resolveTheme,
  setTheme,
  THEME_STORAGE_KEY,
  themeLabel,
} from "./theme";
export type { ResolvedTheme, ThemePreference } from "./theme";
export { useThemePreference } from "./useTheme";
export { EmptySlot, ErrorSlot, LoadingSlot, Screen } from "./slots";
