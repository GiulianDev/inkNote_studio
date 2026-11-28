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

/**
 * Calcola il top sicuro (in px) per `.pages-sidebar`, tenendo conto sia dell'header
 * che di eventuali dock contestuali (`.ui-dock`) che si sovrapporrebbero orizzontalmente
 * alla sidebar su schermi stretti (es. smartphone).
 *
 * @param {object} params
 * @param {{ height: number, bottom: number } | null | undefined} params.headerRect
 * @param {{ left: number, right: number, top: number, bottom: number, width: number, height: number } | null} [params.dockRect]
 * @param {boolean} [params.dockVisible=false]
 * @param {boolean} [params.isCompactMode=false]
 * @param {'left'|'right'} [params.sidebarPosition='left']
 * @param {number} [params.sidebarWidth=180]
 * @param {number} [params.viewportWidth=1024]
 * @param {number} [params.dockGap=8]
 * @param {number|null} [params.lastTop=null]
 * @returns {number | null}
 */
export function resolveSidebarViewportTop({
  headerRect,
  dockRect = null,
  dockVisible = false,
  isCompactMode = false,
  sidebarPosition = 'left',
  sidebarWidth = 180,
  viewportWidth = 1024,
  dockGap = 8,
  lastTop = null
} = {}) {
  let baseTop = 0;
  if (!isCompactMode) {
    if (!headerRect || !(headerRect.height > 0) || !Number.isFinite(headerRect.bottom)) {
      return null;
    }
    baseTop = Math.max(0, Math.round(headerRect.bottom));
  }

  let nextTop = baseTop;
  if (
    dockVisible &&
    dockRect &&
    Number.isFinite(dockRect.bottom) &&
    dockRect.width > 0 &&
    dockRect.height > 0
  ) {
    const sbW = Math.max(0, Number.isFinite(sidebarWidth) ? sidebarWidth : 180);
    const vpW = Math.max(sbW, Number.isFinite(viewportWidth) ? viewportWidth : 1024);
    const sbLeft = sidebarPosition === 'right' ? Math.max(0, vpW - sbW) : 0;
    const sbRight = sidebarPosition === 'right' ? vpW : sbW;

    const overlapsHorizontally =
      dockRect.left < (sbRight + 8) &&
      dockRect.right > (sbLeft - 8);

    if (overlapsHorizontally) {
      nextTop = Math.max(nextTop, Math.round(dockRect.bottom + dockGap));
    }
  }

  if (lastTop !== null && nextTop === lastTop) return null;
  return nextTop;
}

/**
 * Decide se accettare l'inizio di uno swipe laterale per aprire o chiudere la sidebar.
 * Ignora sempre i puntatori stilo (`pen`) per non interferire con la scrittura ai bordi.
 *
 * @param {object} params
 * @param {number} params.clientX
 * @param {number} params.clientY
 * @param {number} params.viewportWidth
 * @param {'left'|'right'} [params.sidebarPosition='left']
 * @param {boolean} [params.sidebarOpen=false]
 * @param {string} [params.pointerType='touch']
 * @param {{ top: number, bottom: number } | null} [params.tabRect]
 * @param {boolean} [params.startedOnTab=false]
 * @param {boolean} [params.startedInSidebar=false]
 * @param {number} [params.edgeThresholdPx=44]
 * @param {number} [params.verticalPaddingPx=140]
 * @returns {{ accept: boolean, mode: 'open' | 'close' | null }}
 */
export function evaluateSidebarSwipeStart({
  clientX,
  clientY,
  viewportWidth,
  sidebarPosition = 'left',
  sidebarOpen = false,
  pointerType = 'touch',
  tabRect = null,
  startedOnTab = false,
  startedInSidebar = false,
  edgeThresholdPx = 44,
  verticalPaddingPx = 140
} = {}) {
  if (pointerType === 'pen') return { accept: false, mode: null };

  if (sidebarOpen) {
    if (startedOnTab || startedInSidebar) {
      return { accept: true, mode: 'close' };
    }
    return { accept: false, mode: null };
  }

  if (startedOnTab) {
    return { accept: true, mode: 'open' };
  }

  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !Number.isFinite(viewportWidth)) {
    return { accept: false, mode: null };
  }

  const inEdgeBand = sidebarPosition === 'right'
    ? clientX >= (viewportWidth - edgeThresholdPx)
    : clientX <= edgeThresholdPx;

  if (!inEdgeBand) return { accept: false, mode: null };

  if (tabRect && Number.isFinite(tabRect.top) && Number.isFinite(tabRect.bottom)) {
    const inVerticalBand =
      clientY >= (tabRect.top - verticalPaddingPx) &&
      clientY <= (tabRect.bottom + verticalPaddingPx);
    if (!inVerticalBand) return { accept: false, mode: null };
  }

  return { accept: true, mode: 'open' };
}

/**
 * Valuta se il movimento accumulato (dx, dy) attiva l'apertura o la chiusura della sidebar.
 *
 * @param {object} params
 * @param {'open'|'close'} params.mode
 * @param {number} params.dx
 * @param {number} params.dy
 * @param {'left'|'right'} [params.sidebarPosition='left']
 * @param {number} [params.minDistancePx=24]
 * @param {number} [params.maxSlopeRatio=0.85]
 * @returns {'open' | 'close' | null}
 */
export function resolveSidebarSwipeDecision({
  mode,
  dx,
  dy,
  sidebarPosition = 'left',
  minDistancePx = 24,
  maxSlopeRatio = 0.85
} = {}) {
  if (mode !== 'open' && mode !== 'close') return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;

  const inwardSigned = sidebarPosition === 'right' ? -dx : dx;
  const directionalDelta = mode === 'open' ? inwardSigned : -inwardSigned;
  if (directionalDelta < minDistancePx) return null;

  if (Math.abs(dy) > Math.abs(dx) * maxSlopeRatio) return null;
  return mode;
}
