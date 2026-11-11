/**
 * @module core/types
 *
 * HUB CENTRALIZZATO DEI TYPEDEF.
 *
 * Questo file è puramente documentale: non contiene codice runtime.
 * Serve come unico punto di riferimento per le forme dati condivise
 * fra più moduli (state, settings, persistence, render, tools).
 *
 * Nota: alcuni typedef sono DUPLICATI nei file che li usano (state.js,
 * app-settings.js, toolbar-settings.js) per comodità del tooling JSDoc.
 * In caso di divergenza, la fonte di verità è QUESTO file.
 *
 * @see core/state.js           — state.settings / state.pages
 * @see core/app-settings.js    — AppSettings
 * @see features/toolbar/toolbar-settings.js — ToolbarSettings
 * @see features/persistence/session.js      — Notebook
 */

// ============================================================
// ENUMS (union di stringhe)
// ============================================================

/**
 * Nome di uno strumento selezionabile dalla toolbar.
 * - `pen`, `pencil`, `marker`, `highlighter` → tracciano stroke
 * - `lasso` → selezione/editing
 * - `eraser` → cancellazione
 *
 * @typedef {'pen'|'pencil'|'marker'|'highlighter'|'lasso'|'eraser'} ToolName
 */

/**
 * Sottoinsieme di ToolName che produce uno `Stroke` (tutti tranne
 * lasso ed eraser). Usato nel modello dati.
 *
 * @typedef {'pen'|'pencil'|'marker'|'highlighter'} StrokeTool
 */

/**
 * Pattern di sfondo della pagina.
 *
 * @typedef {'ruled'|'grid'|'dots'|'blank'} BgPattern
 */

/**
 * Tipo di pointer event secondo la Pointer Events API,
 * più il valore sintetico 'eraser' (tasto laterale penna).
 *
 * @typedef {'pen'|'touch'|'mouse'|'eraser'} PointerType
 */

// ============================================================
// GEOMETRIA
// ============================================================

/**
 * Un punto campionato durante il disegno.
 * Le coordinate sono in riferimento canvas (0..PAGE_WIDTH, 0..PAGE_HEIGHT).
 *
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 * @property {number} [pressure]    0..1 (0.5 se non pen)
 * @property {number} [tiltX]       gradi inclinazione X
 * @property {number} [tiltY]       gradi inclinazione Y
 * @property {number} [speed]       distanza dall'ultimo punto (px)
 * @property {PointerType} [pointerType]
 */

/**
 * Bounding box in coordinate canvas.
 *
 * @typedef {Object} BBox
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

// ============================================================
// STROKE
// ============================================================

/**
 * Un tratto disegnato (unità atomica del documento).
 *
 * Campi persistenti (salvati su IDB):
 *   tool, color, size, points
 *
 * Campi runtime/cache (NON salvati, ricreati al caricamento):
 *   startTime, _styleCache, _pathLen, _drawnIdx, _cacheCanvas, _cacheKey
 *   → vedi session.js::_cloneStrokeForSave
 *
 * @typedef {Object} Stroke
 * @property {StrokeTool} tool
 * @property {string} color            hex (#rrggbb)
 * @property {number} size             valore slider 1..25
 * @property {Point[]} points
 * @property {number} [startTime]      performance.now() al pointerdown
 * @property {Object} [_styleCache]    cache stile canvas (invalicata da cambio tema)
 * @property {number} [_pathLen]       lunghezza cumulativa path (cache forme)
 * @property {number} [_drawnIdx]      indice ultimo punto renderizzato (batch rAF)
 * @property {Object} [_cacheCanvas]   bitmap cache per tool pencil
 * @property {string} [_cacheKey]      chiave cache (dpr + tema)
 */

// ============================================================
// PAGE
// ============================================================

/**
 * Una pagina del notebook (canvas + overlay + stroke).
 *
 * @typedef {Object} PageData
 * @property {number} index
 * @property {HTMLDivElement} wrapper
 * @property {HTMLCanvasElement} canvas
 * @property {CanvasRenderingContext2D} ctx
 * @property {HTMLCanvasElement} overlayCanvas
 * @property {CanvasRenderingContext2D} overlayCtx
 * @property {Stroke[]} strokes
 * @property {number} [dpr]           device pixel ratio canvas principale
 * @property {number} [overlayDpr]    dpr overlay (limitato a 1.5)
 * @property {boolean} [_wasVisible]  cache visibilità (per refreshCanvasResolution)
 * @property {HTMLCanvasElement} [_predCanvas]  canvas prediction events
 * @property {CanvasRenderingContext2D} [_predCtx]
 */

// ============================================================
// HISTORY
// ============================================================

/**
 * Snapshot per undo/redo (per-pagina).
 *
 * @typedef {Object} Snapshot
 * @property {number} pageIndex
 * @property {Stroke[]} strokes       copia "pulita" (no cache runtime)
 * @property {BgPattern} bgPattern
 * @property {number} [_hash]         hash stato (per skip se identico)
 */

// ============================================================
// SETTINGS — GLOBALI (localStorage)
// ============================================================

/**
 * Impostazioni globali cross-notebook, persistite in localStorage.
 * Vedi core/app-settings.js::DEFAULT_SETTINGS.
 *
 * @typedef {Object} AppSettings
 * @property {'auto'|'light'|'dark'} theme
 * @property {'light'|'dark'} printTheme
 * @property {'right'|'left'} handedness
 * @property {'small'|'medium'|'large'} dockSize
 * @property {number} pressureLight        0..100
 * @property {number} pressureHeavy        100..500
 * @property {number} pressureCurve        0..100
 * @property {number} scrollSensitivity    0..100
 * @property {boolean} palmRejection
 */

// ============================================================
// SETTINGS — TOOLBAR (per-notebook, IDB)
// ============================================================

/**
 * Configurazione per-tool di colore e spessore.
 *
 * @typedef {Object} ToolConfig
 * @property {string} color hex
 * @property {number} width 1..25
 */

/**
 * Impostazioni toolbar, persistite DENTRO il notebook
 * (`notebook.toolbarSettings`).
 * Vedi features/toolbar/toolbar-settings.js::DEFAULT_TOOLBAR_SETTINGS.
 *
 * @typedef {Object} ToolbarSettings
 * @property {Object.<StrokeTool, ToolConfig>} tools
 * @property {number} eraserSize        1..5
 * @property {'stroke'|'point'} eraserMode
 * @property {boolean} autoShapeEnabled
 * @property {number} smoothing         0..100
 * @property {boolean} subbarVisible
 * @property {boolean} compactMode
 * @property {string[]} recentColors    array di hex
 */

// ============================================================
// NOTEBOOK
// ============================================================

/**
 * Un quaderno completo, salvato in IndexedDB (object store `notebooks`,
 * keyPath `id`).
 *
 * @typedef {Object} Notebook
 * @property {string} id              'nb_<timestamp>'
 * @property {string} title
 * @property {string} coverColor      hex
 * @property {BgPattern} pattern
 * @property {string} createdAt       ISO 8601
 * @property {string} updatedAt       ISO 8601 (auto-aggiornato al save)
 * @property {Array<{pageIndex: number, strokes: Stroke[]}>} pages
 * @property {ToolbarSettings} [toolbarSettings]  retrocompat: notebook
 *                                                creati prima dell'introduzione
 *                                                di questo campo non lo hanno
 */

// Export vuoto per rendere il file un modulo ES (evita warning "not a module")
export {};