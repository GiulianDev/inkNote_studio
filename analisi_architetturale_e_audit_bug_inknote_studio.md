# Analisi Architetturale e Audit Bug — InkNote Studio (`v0.2.5`)

> **Ultimo aggiornamento**: 28 Novembre 2026 — Revisione architetturale, persistenza multi-tab e supporto PWA alla versione **`v0.2.5`** (`package.json`).  
> **Stato verifiche automatiche post-fix**:
> - `npx eslint .`: **0 errori, 0 warning** (exit code `0`).
> - `node --test 'src/**/*.test.js'`: **206/206 passati, 0 falliti**.
> - Verifica end-to-end in browser (Chromium): registrazione Service Worker PWA e manifest, indicatore offline/online, persistenza automatica su `visibilitychange` (`hidden`) per casella di testo non ancora confermata, avviso multi-tab `BroadcastChannel` e build `singlefile` verificati con **0 errori runtime**.

Questo documento fotografa l'architettura attuale di **InkNote Studio**, traccia lo stato dei 10 bug storici, documenta la risoluzione dei bug dell'audit `v0.2.2` e le 5 criticità architetturali risolte in `v0.2.5`.

---

## 1. Architettura Attuale del Progetto (`v0.2.2`)

L'applicazione è organizzata in tre domini principali orchestrati da un unico composition root (`src/main.js`), senza dipendenze circolari verso l'alto da `shared/` verso `notebook/` o `library/`:

### 1.1 Bootstrap & Navigazione (`src/main.js`, `src/shared/core/back-navigation.js`, `src/shared/components/modal.js`)
1. `window.load` monta in sequenza `#libraryView` + `#newNotebookModal` (`mountLibraryPage()`), `#viewport` + overlay (`mountNotebookPage()`), la barra strumenti (`mountToolbar()`), il modale impostazioni (`mountSettingsModal()`) e la sidebar pagine (`mountPagesSidebar()`).
2. Inizializza profilo piattaforma (`desktop`, `ios`, `android`), store globale (`initSettings()`), store toolbar (`initToolbarSettings(null)`), IndexedDB v5 (`initDB()`), redirect OAuth Firebase (`handleRedirectResult()`), adapter di sessione/sync (`registerSessionAdapters`, `registerSyncNotebookHandlers`), gesture, scorciatoie da tastiera e controller unificato del tasto Indietro (`initBackNavigation()`).
3. Tutte le modali dell'app passano attraverso lo stack LIFO `modal.js` (`registerModal` / `openModalOverlay`), con gestione centralizzata di `Escape`, backdrop drag-safe e priorità su `popstate`.

### 1.2 Libreria, Cartelle, Persistenza Locale e Sync/Backup (`src/library/*`, `src/shared/*`)
* **Libreria (`src/library/library.js`, `src/library/library-helpers.js`)**: griglia/lista di quaderni e cartelle gerarchiche, ricerca, filtro preferiti, ordinamento, selezione multipla (long-press `500 ms` o bottone dedicato), drag & drop su cartelle/breadcrumb.
* **Persistenza locale (`src/shared/services/db.js`, `session.js`, `autosave.js`, `lazy-strokes.js`)**: IndexedDB v5 (`notebooks`, `pages`, `folders`, `syncTombstones`) con packing compatto dei tratti (`serialization.js`), decompressione lazy di `page.strokes` (`attachLazyStrokes`), salvataggio differenziale per pagine sporche (`dirtyPages` / `deletedPages` / `orderDirty`) e autosave con debounce (`1200 ms`) + `requestIdleCallback`.
* **Cloud Sync manuale (`src/shared/services/sync-cloud.js`, `src/shared/sync/*`)**: sincronizzazione manuale su Firestore (`users/{uid}/sync_folders`, `sync_notebooks`, `pages`, `chunks`), deduplicazione pagine via SHA-256, chunking per payload > ~700 KB (limite Firestore 1 MiB) e rilevazione conflitti via signature metadati/pagine. Zero listener in background.
* **Backup `.inknote` e Condivisione P2P (`src/shared/backup/*`, `src/shared/services/sharing-cloud.js`, `firestore.rules`)**: export/import archivi `.inknote` (formato v4 con compressione GZIP/base64 e Web Worker dedicato) e invio diretto tra utenti su Firestore (`transfers/{transferId}/chunks`).

### 1.3 Editor, Input & Rendering (`src/notebook/*`)
* **Viewport & Gesture (`gestures.js`, `palm-rejection.js`, `transform.js`)**: listener `pointerdown`/`pointermove` in capture su `#viewport` e `pointerup`/`pointercancel` su `window`; pan ad 1 dito con asse verticale opzionale e inerzia (`requestAnimationFrame`), pinch-to-zoom a 2 dita con `_pinchConfirm`, zoom trackpad/rotellina (`wheel` + `ctrlKey`), pull-to-add-page e `clampViewport()` basato su `_clampCache`.
* **Strumenti & Rendering (`tools/dispatcher.js`, `ink.js`, `shapes.js`, `lazo.js`, `text.js`, `render.js`, `page-pool.js`)**: disegno su overlay canvas + commit sul canvas pooled di pagina; profilo iOS dedicato con nastro continuo per Apple Pencil; riconoscimento forme geometriche/matematiche/greche; caselle di testo con editing DOM e raster/PDF vettoriale (`export-pdf.js`); history undo/redo per-pagina/ordine.

---

## 2. Stato dei 10 Bug Storici dell'Audit Precedente

| # | Problema storico | Stato in `v0.2.4` | Note di verifica |
|---|------------------|-------------------|------------------|
| 1 | Perdita contenuti nella duplicazione quaderni (`handleDuplicateSelection`) | **Risolto** | `library.js:1007-1041` clona le pagine preservando `textBoxes`, `paperColor`, `patternColor`, `bgPattern`, ecc. e rigenerando solo `pageId` e ID box testo. |
| 2 | Blocco permanente `_gestureBlocked` se un puntatore resta orfano | **Risolto** | `gestures.js:412-417` usa cooldown temporizzato (`GESTURE_BLOCK_COOLDOWN_MS`) e chiama `_clearTouchPointers()`. |
| 3 | Stato sporco `activePointers` quando `state.fingerWriting === true` | **Risolto** | I puntatori `fingerWriting` vengono etichettati e ripuliti preventivamente in `gestures.js` quando nessun tratto, pan o pinch è attivo, evitando falsi pinch da puntatori orfani. |
| 4 | Impossibile passare da pan a 1 dito a pinch dopo `300 ms` | **Risolto** | Il vincolo temporale sul secondo dito è stato rimosso in `gestures.js:440-466`. |
| 5 | `_clampCache` non invalidata al cambio quaderno o viewport | **Risolto** | `invalidateClampCache()` viene chiamata in `openNotebook`, `ResizeObserver`, sidebar (`pages-sidebar.js`), e ora anche `resetZoom()` usa `applyPinchTransform` / `clampViewport()` centrato sul viewport. |
| 6 | Zoom via `wheel` (`ctrlKey`) lascia i canvas a bassa risoluzione | **Risolto** | `gestures.js` chiama `_scheduleWheelResolutionRefresh()` (debounced `180 ms`), mentre `keyboard.js` e `resetZoom()` (`pages.js`) invocano `scheduleResolutionRefresh()`. |
| 7 | File `.inknote` non selezionabili su iPadOS | **Risolto** | `index.html:26` permette la selezione senza blocchi iPadOS. |
| 8 | Tocco sullo sfondo della libreria chiude `_selectionMode` su `pointerdown` | **Risolto** | `library.js` usa `click` e include `#libraryControlsWrap` e `#librarySelectionBar` nel selettore di esclusione. |
| 9 | Doppio tap "Crea Quaderno" e race condition in `renderLibraryView()` | **Risolto** | Introdotti `_isCreatingNotebook`, `confirmBtn.disabled`, suffisso random nell'ID e `_renderRequestToken` in `library.js`. |
| 10 | Posizionamento iniziale `#undoRedoContainer` su viewport stretti (`left: 80px`) | **Risolto** | `notebook-page.html:111` e `ui-bindings.js:284-320` posizionano e clampano dinamicamente il dock. |

---

## 3. Stato dei Bug e Criticità dell'Audit `v0.2.2` (Aggiornato a `v0.2.4`)

### Livello Critico (Risolto)

#### C1. Upload Cloud non atomico in `_uploadNotebookToCloud` — **RISOLTO**
* **File**: `src/shared/services/sync-cloud.js` (`_uploadNotebookToCloud`, `_downloadNotebookFromCloud`)
* **Soluzione applicata**:
  1. Per i nuovi quaderni cloud (`!existingCloudNb`), viene creato un documento di staging `sync_notebooks/{id}` con `pageOrder: []` e `pageCount: 0` (per soddisfare le regole Firestore sulle sotto-collezioni `pages`), vengono caricati tutti i payload e chunk delle pagine e solo alla fine i metadati completi vengono finalizzati con `updateDoc` (con pulizia best-effort in caso di errore).
  2. Per i quaderni esistenti, vengono caricate prima le pagine attive, poi aggiornato `pageOrder`/`pageCount` sul padre e solo infine eliminate in best-effort le pagine rimosse.
  3. In `_downloadNotebookFromCloud`, l'assenza di una pagina dichiarata in `pageOrder` solleva ora un errore esplicito anziché sintetizzare una pagina bianca.

---

### Livello Alto (Tutti Risolti)

#### A1. Eliminazione quaderno/cartella in Libreria prima di chiudere l'editor e attendere i salvataggi — **RISOLTO**
* **File**: `src/library/library.js`, `src/shared/persistence/session.js`
* **Soluzione applicata**: Esportato `waitForPendingSaves()` da `session.js` e invocati `closeNotebookIfOpen(...)` + `await waitForPendingSaves()` **prima** di `deleteNotebookFromDB` / `deleteLibraryItemsFromDB` in `_deleteNotebook`, `_handleDeleteFolder` e `_handleDeleteSelection`.

#### A2. Importazione backup `.inknote` `"overwrite"` disallineata dal quaderno aperto — **RISOLTO**
* **File**: `src/shared/backup/backup-import.js`, `src/main.js`
* **Soluzione applicata**: Registrato `registerBackupNotebookHandlers({ closeNotebookIfOpen })` in `main.js`; prima della sovrascrittura in `backup-import.js`, se il quaderno coincide con `getCurrentNotebook()?.id`, vengono eseguiti `closeNotebookIfOpen(nb.id)`, `cancelPendingSave()` e `await waitForPendingSaves()`.

#### A3. `resetZoom()`, zoom da tastiera (`+`/`-`) e zoom `wheel` (`ctrlKey`) — **RISOLTO**
* **File**: `src/notebook/editor/pages.js`, `src/notebook/shortcuts/keyboard.js`, `src/notebook/viewport/gestures.js`
* **Soluzione applicata**: `resetZoom()` centra il reset attorno al centro di `#viewport` tramite `applyPinchTransform` (fallback `clampViewport()`) e chiama `scheduleResolutionRefresh()`; anche `_zoomByFactor()` in `keyboard.js` e lo zoom `wheel` (`ctrlKey`, debounced a `180 ms`) in `gestures.js` attivano `scheduleResolutionRefresh()`.

#### A4. Cleanup concorrente in `deleteTransferWithChunks` — **RISOLTO**
* **File**: `src/shared/services/sharing-cloud.js`
* **Soluzione applicata**: Introdotta deduplica delle cancellazioni in corso (`_transferDeleteInFlight`), cache breve degli ID già eliminati (`_recentlyDeletedTransfers`, TTL `15 s`) e gestione idempotente di `not-found` / `permission-denied` durante il cleanup concorrente tra mittente e destinatario.

---

### Livello Medio (Tutti Risolti)

#### M1. Interruzione drag/resize lazo deseleziona gli elementi — **RISOLTO**
* **File**: `src/notebook/tools/lazo.js`
* **Soluzione applicata**: `endResizeSelection()` ed `endSelectionDrag()` reimpostano `state.isDrawing = false` direttamente, impedendo ad `abortCurrentDrawing()` di invocare `clearSelection()`.

#### M2. Stato sporco in `activePointers` durante `fingerWriting` — **RISOLTO**
* **File**: `src/notebook/viewport/gestures.js`
* **Soluzione applicata**: I nuovi puntatori touch vengono marcati con `fingerWriting: !!state.fingerWriting` e gli eventuali puntatori orfani `fingerWriting` vengono rimossi quando `!state.isDrawing && !viewport.isPanning && !viewport.isPinching` prima di valutare `activePointers.size`.

#### M3. Pulsanti UI `#undoBtn` / `#redoBtn` con casella di testo attiva — **RISOLTO**
* **File**: `src/notebook/history/history.js`
* **Soluzione applicata**: `undo()` e `redo()` invocano `commitActiveTextBox({ deselect: true })` se `state.editingTextBoxId` è valorizzato prima di `flushHistory()`.

#### M4. Troncamento silente oltre 500 pagine nel Cloud Sync e invio P2P — **RISOLTO**
* **File**: `src/shared/sync/sync-helpers.js`, `src/shared/services/sync-cloud.js`, `src/shared/services/sharing-cloud.js`
* **Soluzione applicata**: Introdotto `assertCloudSyncPageLimit(notebook, 500)` con test unitario dedicato; sia il sync cloud sia `sendNotebookToFriend` rifiutano preventivamente quaderni oltre 500 pagine con un errore esplicito invece di troncarli silenziosamente.

#### M5. Rebuild completo delle miniature su `history:restore` — **RISOLTO**
* **File**: `src/notebook/pages-sidebar/pages-sidebar.js`
* **Verifica e soluzione applicata**: Le coordinate dei pattern fallback (`pages-sidebar.js:813-855`) risultavano già allineate a `render.js::getBackgroundCanvas` (`y=60`, `0..PAGE_WIDTH`). Corretto invece il listener `on('history:restore', (detail) => ...)`: rigenera tutte le miniature solo quando `detail?.patternChanged` è vero, aggiornando altrimenti esclusivamente la miniatura della pagina modificata.

#### M6. Click sulla barra ricerca/filtri chiude la selezione multipla — **RISOLTO**
* **File**: `src/library/library.js`
* **Soluzione applicata**: Aggiunti `#libraryControlsWrap` e `#librarySelectionBar` al selettore di esclusione del listener `click` globale.

---

### Livello Basso & Debito Tecnico

#### B1. Test automatico `release-info.test.js` rotto dopo lo spostamento di modulo — **RISOLTO**
* **File**: `src/shared/release/release-info.test.js`
* **Soluzione applicata**: Aggiornato il percorso verificato a `src/shared/release/release-info.js`; l'intera suite passa (`197/197`).

#### B2. Debito tecnico residuo su file monolitici (`style.css`, `render.js`, `toolbar.js`, `library.js`, `sharing-ui.js`) — **APERTO (Non bloccante)**
* **Osservazione**: La separazione dei layer è ora completa (`0` import di produzione verso l'alto da `shared/` o `library/` verso `notebook/`), ma restano 5 file di grandi dimensioni (`style.css`, `render.js`, `toolbar.js`, `library.js`, `sharing-ui.js`). Non costituiscono bug, ma conviene modularizzarli gradualmente in interventi mirati futuri.

---

## 4. Criticità Architetturali Risolte (`v0.2.5`)

1. **Perdita modifiche su chiusura app o cambio scheda mobile (`main.js`, `editor.js`, `autosave.js`) — RISOLTO**: Aggiunto `flushActiveEditorBeforeLeave()` collegato a `visibilitychange` (`hidden`), `pagehide` e `beforeunload`. Prima di svuotare history e autosave, consolida `state.pendingShape` (`finalizePendingShape`) e la casella di testo in modifica (`commitActiveTextBox`).
2. **Stato sync perso su errori parziali & concorrenza multi-tab (`sync-cloud.js`) — RISOLTO**: `saveUserSyncState` e `recordDailySyncUsage` vengono eseguiti nel blocco `finally` quando risultano operazioni completate o traffico Firestore prima di un errore parziale; protetta l'esecuzione tra schede con `navigator.locks.request('inknote_cloud_sync', { ifAvailable: true })`.
3. **Disallineamento `needsOrderRebuild` vs `pageOrders` (`db.js`) — RISOLTO**: In `saveNotebookToDB()`, la scrittura su `pageOrdersStore` viene eseguita ogniqualvolta `needsOrderRebuild` è `true` (incluso `notebook.pageOrder.length !== pages.length`), mantenendo sempre allineati `notebooks.pageCount` e `pageOrders`.
4. **Errori silenziosi IndexedDB / Quota e coordinamento multi-tab (`db.js`, `autosave.js`, `session.js`, `library.js`, `tab-sync.js`, `main.js`) — RISOLTO**: Espliciti i reject quando `!db`, gestiti `onblocked` e `onversionchange` con notifiche UI, evidenziato `QuotaExceededError` su status badge e toast, aggiunta gestione errori in `renderLibraryView()` e introdotto `BroadcastChannel('inknote_studio_tab_sync_v1')` per sincronizzare le schede aperte su salvataggi, eliminazioni, import e sync cloud.
5. **Disaccoppiamento `library → notebook` & PWA offline installabile (`library.js`, `vite.config.js`, `pwa.js`, `index.html`, `library-page.html`, `public/`) — RISOLTO**: Eliminati gli import diretti da `library.js` verso `editor.js` e `toolbar-settings.js` tramite `registerLibraryNotebookHandlers()` nel composition root; aggiunti manifest PWA, icone dedicata (`any`, `maskable`, `apple-touch-icon`), Service Worker Workbox per l'uso offline completo su iPad/tablet/desktop e bottone in-app di installazione preservando i profili di build `singlefile` e `singlefileoffline`.