/**
 * @module notebook/editor/hud-layout
 *
 * Calcoli puri per il posizionamento adattivo degli HUD dell'editor
 * (`#undoRedoContainer`, `#zoomBadge`), la luce libera sotto al dock contestuale
 * e la logica di avvio trascinamento del pannello Annulla/Ripristina.
 */

/**
 * Calcola il rettangolo sicuro del viewport per gli HUD mobili dell'editor,
 * escludendo l'area occupata dalla sidebar pagine (quando aperta) e dall'header.
 *
 * @param {object} params
 * @param {{ left: number, top: number, width: number, height: number, right?: number, bottom?: number }} params.viewportRect
 * @param {boolean} [params.sidebarOpen=false]
 * @param {'left'|'right'} [params.sidebarPosition='left']
 * @param {number} [params.sidebarWidth=180]
 * @param {number} [params.headerBottom=0]
 * @param {boolean} [params.isCompactMode=false]
 * @param {number} [params.margin=8]
 * @returns {{
 *   viewportRect: { left: number, top: number, width: number, height: number, right: number, bottom: number },
 *   minTop: number
 * }}
 */
export function computeSafeHudViewportRect({
  viewportRect,
  sidebarOpen = false,
  sidebarPosition = 'left',
  sidebarWidth = 180,
  headerBottom = 0,
  isCompactMode = false,
  margin = 8
}) {
  const rawLeft = Number.isFinite(viewportRect?.left) ? viewportRect.left : 0;
  const rawTop = Number.isFinite(viewportRect?.top) ? viewportRect.top : 0;
  const rawWidth = Math.max(0, Number.isFinite(viewportRect?.width) ? viewportRect.width : 1024);
  const rawHeight = Math.max(0, Number.isFinite(viewportRect?.height) ? viewportRect.height : 768);
  const rawRight = Number.isFinite(viewportRect?.right) ? viewportRect.right : rawLeft + rawWidth;
  const rawBottom = Number.isFinite(viewportRect?.bottom) ? viewportRect.bottom : rawTop + rawHeight;

  let safeLeft = rawLeft;
  let safeRight = rawRight;

  const sbW = Math.max(0, Number.isFinite(sidebarWidth) ? sidebarWidth : 0);
  if (sidebarOpen && sbW > 0) {
    if (sidebarPosition === 'right') {
      safeRight = Math.max(safeLeft + margin * 2, rawRight - sbW);
    } else {
      safeLeft = Math.min(safeRight - margin * 2, rawLeft + sbW);
    }
  }

  const safeHeaderBottom = (!isCompactMode && Number.isFinite(headerBottom) && headerBottom > rawTop)
    ? headerBottom
    : rawTop;
  const minTop = Math.round(safeHeaderBottom + margin);

  return {
    viewportRect: {
      left: Math.round(safeLeft),
      top: Math.round(rawTop),
      width: Math.max(0, Math.round(safeRight - safeLeft)),
      height: Math.max(0, Math.round(rawBottom - rawTop)),
      right: Math.round(safeRight),
      bottom: Math.round(rawBottom)
    },
    minTop
  };
}

/**
 * Calcola il margine superiore (in px CSS relativi a `#viewport`) da applicare
 * al posizionamento iniziale o allo scroll pagina affinché il bordo superiore del
 * foglio respiri sotto al dock strumenti flottante.
 *
 * @param {object} [params]
 * @param {number} [params.viewportTop=0]
 * @param {number} [params.dockBottom=0]
 * @param {boolean} [params.dockVisible=false]
 * @param {number} [params.minMargin=20]
 * @param {number} [params.dockGap=16]
 * @param {number} [params.maxMargin=180]
 * @returns {number}
 */
export function computeDockTopClearance({
  viewportTop = 0,
  dockBottom = 0,
  dockVisible = false,
  minMargin = 20,
  dockGap = 16,
  maxMargin = 180
} = {}) {
  if (!dockVisible || !Number.isFinite(dockBottom) || !Number.isFinite(viewportTop)) {
    return minMargin;
  }
  const relativeDockBottom = dockBottom - viewportTop;
  if (relativeDockBottom <= 0) return minMargin;
  return Math.min(maxMargin, Math.max(minMargin, Math.round(relativeDockBottom + dockGap)));
}

/**
 * Decide se avviare il trascinamento di `#undoRedoContainer`:
 * parte appena il puntatore si sposta oltre la soglia (`thresholdPx`, >= 8px)
 * in qualsiasi punto del pannello, oppure dopo una breve pressione ferma (`holdElapsed`).
 *
 * @param {object} params
 * @param {number} [params.distancePx=0]
 * @param {boolean} [params.holdElapsed=false]
 * @param {number} [params.thresholdPx=8]
 * @returns {boolean}
 */
export function shouldStartUndoRedoDrag({
  distancePx = 0,
  holdElapsed = false,
  thresholdPx = 8
} = {}) {
  if (holdElapsed) return true;
  if (!Number.isFinite(distancePx) || distancePx < 0) return false;
  return distancePx >= thresholdPx;
}

/**
 * Calcola la posizione iniziale sicura di `#undoRedoContainer` quando l'utente non
 * ha ancora salvato una posizione personalizzata, evitando sovrapposizioni con il dock
 * contestuale su schermi stretti (es. smartphone).
 *
 * @param {object} [params]
 * @param {{ left: number }} [params.viewportRect]
 * @param {{ left: number, top: number, right: number, bottom: number, width: number, height: number } | null} [params.dockRect]
 * @param {boolean} [params.dockVisible=false]
 * @param {number} [params.minTop=72]
 * @param {number} [params.containerWidth=96]
 * @param {number} [params.containerHeight=50]
 * @param {number} [params.margin=10]
 * @returns {{ x: number, y: number }}
 */
export function resolveDefaultUndoRedoPosition({
  viewportRect,
  dockRect = null,
  dockVisible = false,
  minTop = 72,
  containerWidth = 96,
  containerHeight = 50,
  margin = 10
} = {}) {
  const baseLeft = Number.isFinite(viewportRect?.left) ? viewportRect.left : 0;
  const defaultX = Math.round(baseLeft + 16);
  const defaultY = Math.max(Math.round(minTop), 140);

  if (!dockVisible || !dockRect || dockRect.width <= 0 || dockRect.height <= 0) {
    return { x: defaultX, y: defaultY };
  }

  const overlapsX = defaultX < dockRect.right + margin && (defaultX + containerWidth) > dockRect.left - margin;
  const overlapsY = defaultY < dockRect.bottom + margin && (defaultY + containerHeight) > dockRect.top - margin;

  if (!overlapsX || !overlapsY) {
    return { x: defaultX, y: defaultY };
  }

  return {
    x: Math.round(baseLeft + 12),
    y: Math.round(dockRect.bottom + 12)
  };
}

