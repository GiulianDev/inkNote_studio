/**
 * @module features/pages-sidebar/sidebar-layout
 *
 * Calcolo puro dell'offset superiore della sidebar pagine rispetto a `#mainHeader`.
 */

/**
 * Calcola il nuovo valore (in px interi) per `--pages-sidebar-header-height`,
 * oppure `null` se l'aggiornamento va saltato (header nascosto, compact-mode
 * con header flottante o valore invariato).
 *
 * @param {{
 *   rect: { height: number, bottom: number } | null | undefined,
 *   isCompactMode?: boolean,
 *   lastTop?: number | null
 * }} params
 * @returns {number | null}
 */
export function resolveSidebarHeaderTop({ rect, isCompactMode = false, lastTop = null }) {
  if (!rect || isCompactMode) return null;
  if (!(rect.height > 0) || !Number.isFinite(rect.bottom)) return null;
  const nextTop = Math.max(0, Math.round(rect.bottom));
  if (lastTop !== null && nextTop === lastTop) return null;
  return nextTop;
}
