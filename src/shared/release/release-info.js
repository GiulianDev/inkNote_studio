// File generato automaticamente da scripts/sync-release.mjs durante il build.
// NON modificare manualmente: viene rigenerato ad ogni `npm run build`.

export const RELEASE_INFO = Object.freeze({
  "version": "0.2.9",
  "builtAt": "2026-11-28T16:40:15.644Z",
  "date": "2026-11-28",
  "currentNotes": [
    "**Isolamento Libreria per Account & Migrazione Quaderni Guest (`db.js`, `db-scope-helpers.js`, `library-auth.js`, `sync-helpers.js`, `backup-import.js`, `sync-cloud.js`, `sharing-ui.js`, `main.js`)**: associati quaderni e raccolte locali al profilo Google autenticato (`ownerUid`) mantenendo i quaderni creati senza accesso (`ownerUid === null`) visibili da disconnessi; aggiunta richiesta interattiva al login per associare al proprio account eventuali elementi guest presenti sul dispositivo, isolamento delle tombstone per UID e protezione da collisioni ID multi-account in IndexedDB.",
    "**Loader operazioni asincrone & avvio pulito (`library-page.html`, `library.js`, `library-auth.js`, `sync-ui.js`, `main.js`)**: aggiunto stato di caricamento iniziale della libreria in attesa della verifica account/IndexedDB (senza lampeggiare stati vuoti o libreria di altri profili) e indicatori di caricamento dedicati su login, logout, associazione quaderni, creazione, duplicazione, spostamento ed eliminazione.",
    "**Fix Modale Sync Cloud su smartphone e annullamento (`sync-ui.js`, `sync-cloud.js`)**: impostato layout flex vincolato al viewport (`max-h-[90dvh]`) con header `×` e footer (`Chiudi` / `Annulla sync` / azione primaria) sempre fissi e corpo centrale/conflitti scrollabile; risolti i mancati click durante il progresso tramite aggiornamento testuale in-place e aggiunto supporto `AbortController` per interrompere la sincronizzazione in corso.",
    "**Disabilitazione `dev-dist/` in sviluppo (`vite.config.js`)**: impostato `devOptions.enabled: false` nella configurazione PWA per evitare la generazione della cartella temporanea `dev-dist/` durante `npm run dev`."
  ],
  "notesSourceVersion": "0.2.9",
  "hasExactChangelog": true,
  "releases": [
    {
      "version": "0.2.9",
      "date": "2026-11-28",
      "items": [
        "**Isolamento Libreria per Account & Migrazione Quaderni Guest (`db.js`, `db-scope-helpers.js`, `library-auth.js`, `sync-helpers.js`, `backup-import.js`, `sync-cloud.js`, `sharing-ui.js`, `main.js`)**: associati quaderni e raccolte locali al profilo Google autenticato (`ownerUid`) mantenendo i quaderni creati senza accesso (`ownerUid === null`) visibili da disconnessi; aggiunta richiesta interattiva al login per associare al proprio account eventuali elementi guest presenti sul dispositivo, isolamento delle tombstone per UID e protezione da collisioni ID multi-account in IndexedDB.",
        "**Loader operazioni asincrone & avvio pulito (`library-page.html`, `library.js`, `library-auth.js`, `sync-ui.js`, `main.js`)**: aggiunto stato di caricamento iniziale della libreria in attesa della verifica account/IndexedDB (senza lampeggiare stati vuoti o libreria di altri profili) e indicatori di caricamento dedicati su login, logout, associazione quaderni, creazione, duplicazione, spostamento ed eliminazione.",
        "**Fix Modale Sync Cloud su smartphone e annullamento (`sync-ui.js`, `sync-cloud.js`)**: impostato layout flex vincolato al viewport (`max-h-[90dvh]`) con header `×` e footer (`Chiudi` / `Annulla sync` / azione primaria) sempre fissi e corpo centrale/conflitti scrollabile; risolti i mancati click durante il progresso tramite aggiornamento testuale in-place e aggiunto supporto `AbortController` per interrompere la sincronizzazione in corso.",
        "**Disabilitazione `dev-dist/` in sviluppo (`vite.config.js`)**: impostato `devOptions.enabled: false` nella configurazione PWA per evitare la generazione della cartella temporanea `dev-dist/` durante `npm run dev`."
      ]
    },
    {
      "version": "0.2.8",
      "date": "2026-11-28",
      "items": [
        "**Fix Sync Cloud & Chunk Transition (`sync-cloud.js`, `sync-helpers.js`, `sync-ui.js`)**: rimossa l'invocazione doppia residua su `withCrossTabSyncLock` in `runManualCloudSync` (che causava `TypeError: ... is not a function`), corretto `prevChunkCount` nel passaggio di una pagina da documento singolo a chunked e normalizzato il formato errore Auth in `_formatSyncError`.",
        "**Stato copia cloud su nuovo dispositivo (`sync-cloud.js`, `sync-ui.js`, `sync-helpers.js`)**: introdotto controllo leggero dei soli metadati (`peekCloudSyncInventory`) quando il dispositivo corrente non ha ancora sincronizzato (`Mai su questo dispositivo`), mostrando chiaramente se esistono già quaderni e raccolte salvati nel cloud pronti per il download.",
        "**Configurazione Firebase unificata & sanitizzazione env (`sharing-helpers.js`, `firebase.js`, `.gitignore`)**: aggiunta sanitizzazione automatica di virgolette/punti e virgola accidentali sulle variabili `VITE_FIREBASE_*` e priorità unificata a `VITE_FIREBASE_*` in tutti gli ambienti (preview AI Studio, sviluppo locale PC e build/deploy esterni, con fallback automatico su `firebase-applet-config.json` e su database `(default)` se `VITE_FIREBASE_DATABASE_ID` punta a un vecchio DB AI Studio); aggiunta `dev-dist` a `.gitignore`."
      ]
    },
    {
      "version": "0.2.11",
      "date": "2026-11-28",
      "items": [
        "**Pulsante \"Installa come App\" nelle Impostazioni (`pwa.js`, `settings-modal.html`, `settings-modal.js`)**: aggiunta una card dedicata nel pannello Impostazioni con rilevamento automatico dello stato (prompt nativo su Chromium/Edge/Android, guida rapida iOS/iPadOS Safari, stato già installato in modalità app o istruzioni browser).",
        "**Modale Impostazioni a tab e segmented control (`settings-modal.html`, `settings-modal.js`, `pressure-preview.js`, `style.css`)**: aggiunto pulsante di chiusura `×`, suddivisione in tre tab (`Aspetto`, `Input & Penna`, `Inchiostro`) e sostituzione dei `<select>` con segmented control visivi (`Tema`, `Tema Stampa / PDF`, `Mano Dominante`, `Dimensione Dock`, `Sidebar Pagine`), mantenendo sincronizzata l'anteprima curva pressione al cambio tab.",
        "**Copertine editoriali e metadati puliti (`app-settings.js`, `library-cards.js`, `library-helpers.js`, `style.css`)**: attivati di default titoli e metadati sotto copertina con `tabular-nums`, eliminate le capsule scure sovrapposte alle copertine, migliorato dorso e bordo fogli con accenno discreto del pattern fogli (`ruled`, `grid`, `dots`, `blank`) e footer sfumato opzionale.",
        "**Header Libreria pulito & layout mobile compatto (`library-page.html`, `library.js`, `style.css`)**: rimossi badge versione statico e sottotitolo ridondante dall'intestazione principale (info release accessibili da logo/titolo); compattata l'intestazione su smartphone (`< 640px`) in una singola riga con menu contestuale `<ink-menu id=\"libraryMobileMenu\">` per azioni secondarie (*Nuova Raccolta*, *Seleziona*, *Importa*, *Schermo intero*, *Installa come app*)."
      ]
    },
    {
      "version": "0.2.6",
      "date": "2026-11-28",
      "items": [
        "**Sidebar Pagine mobile senza collisioni e apertura con swipe (`pages-sidebar.js`, `pages-sidebar.css`, `sidebar-layout.js`, `gestures.js`)**: posizionato dinamicamente il bordo superiore della sidebar sotto alla toolbar contestuale su schermi stretti per mantenere sempre accessibile il tasto `+` (Nuova pagina), ampliata l'area touch della linguetta laterale (`24×74px` + hit-area estesa) e introdotto lo swipe da bordo/linguetta verso l'interno per aprire (e verso l'esterno per chiudere) la sidebar.",
        "**Redesign & Drag Intuitivo Annulla / Ripristina (`notebook-page.html`, `style.css`, `ui-bindings.js`, `hud-layout.js`, `shortcuts-catalog.js`)**: uniformata la grafica di `#undoRedoContainer` allo stile `.ui-dock` in tema chiaro e scuro (senza grip laterale) con trascinamento immediato da qualsiasi punto del pannello, anche sopra i pulsanti disabilitati, oltre al fallback a pressione breve.",
        "**Posizionamento adattivo HUD & Controlli Zoom (`hud-layout.js`, `ui-bindings.js`, `pages-sidebar.js`, `pages.js`, `keyboard.js`, `style.css`)**: spostati dinamicamente `#undoRedoContainer` e `#zoomBadge` quando la sidebar pagine sinistra o destra è aperta (e sotto il dock su smartphone) per evitare ogni sovrapposizione; esteso il badge zoom a controlli `− / 100% / +`.",
        "**Spazio iniziale pagina sotto il dock (`editor.js`, `pages.js`, `hud-layout.js`)**: calcolato il margine superiore utile sotto `#dockWriting` all'apertura del quaderno, al centramento, al reset zoom e all'aggiunta/navigazione pagine per non nascondere il bordo superiore del primo foglio.",
        "**Icone SVG uniformi (1.75px) & Toast silenziosi (`ui-icons.js`, `utils.js`, `gestures.js`, `library.js`, `library-page.html`, `settings-modal.html`, `backup-import.js`, `index.html`)**: sostituite le emoji OS con icone SVG monocromatiche coerenti in toast, indicatore pull-to-add-page, barra zoom, stati vuoti libreria, intestazioni Impostazioni e dialog conflitti; rimossi i toast superflui su apertura quaderno e reset zoom."
      ]
    },
    {
      "version": "0.2.5",
      "date": "2026-11-28",
      "items": [
        "**Salvataggio affidabile su chiusura e cambio app mobile (`main.js`, `editor.js`, `autosave.js`)**: introdotto `flushActiveEditorBeforeLeave()` su `visibilitychange` (`hidden`), `pagehide` e `beforeunload` per consolidare caselle di testo attive (`commitActiveTextBox`) e forme pendenti (`finalizePendingShape`) prima di eseguire `flushHistory()` e `flushAutoSave()`.",
        "**Ripristino sync su errori parziali e lock multi-tab (`sync-cloud.js`)**: salvati `nextSyncState` e `recordDailySyncUsage` nel blocco `finally` quando sono state completate operazioni parziali prima di un errore; aggiunto mutex cross-tab tramite `navigator.locks` (`inknote_cloud_sync`).",
        "**Coerenza `pageOrders` & gestione esplicita errori IndexedDB / Quota (`db.js`, `autosave.js`, `library.js`, `main.js`)**: scritto `pageOrdersStore.put` ogni volta che `needsOrderRebuild` è attivo; trasformati in reject espliciti gli accessi a DB non disponibile (`!db`), gestiti `onblocked` e `onversionchange`, notificato `QuotaExceededError` su badge/toast e aggiunta gestione errore in `renderLibraryView()`.",
        "**Coordinamento multi-tab (`tab-sync.js`, `session.js`, `backup-import.js`, `main.js`)**: introdotto `BroadcastChannel('inknote_studio_tab_sync_v1')` per aggiornare la libreria, avvisare su modifiche concorrenti di un quaderno aperto e chiudere in sicurezza quaderni eliminati o sovrascritti da un'altra scheda.",
        "**Disaccoppiamento `library → notebook` & modalità PWA offline (`library.js`, `vite.config.js`, `pwa.js`, `index.html`, `library-page.html`, `public/`)**: invertiti gli import da `library.js` verso `notebook/` tramite `registerLibraryNotebookHandlers()`; configurati manifest, Service Worker (`vite-plugin-pwa`), icone app, installazione in-app (Chromium e guida iOS) e badge di stato offline preservando le build `singlefile`."
      ]
    },
    {
      "version": "0.2.4",
      "date": "2026-11-28",
      "items": [
        "**Integrità Sync Cloud & P2P (C1, M4, A4)**: reso atomico l'ordine di upload su Firestore (`sync-cloud.js`) con caricamento preventivo di pagine e chunk prima dell'aggiornamento di `pageOrder`, errore esplicito su pagine mancanti in download, blocco preventivo oltre 500 pagine (`assertCloudSyncPageLimit` in `sync-helpers.js` e `sharing-cloud.js`) e gestione idempotente/deduplicata di `deleteTransferWithChunks`.",
        "**Race condition Eliminazione & Import Backup (A1, A2)**: attesa di `waitForPendingSaves()` e chiusura dell'editor (`closeNotebookIfOpen`, `cancelPendingSave`) prima delle eliminazioni in libreria (`library.js`) e prima della sovrascrittura in import backup `.inknote` (`backup-import.js`, `main.js`).",
        "**Viewport, Input & Editor (A3, M1, M2, M3, M5, M6)**: centrato e clampato `resetZoom()` (`pages.js`) con refresh risoluzione su `resetZoom()`, scorciatoie zoom (`keyboard.js`) e `wheel` debounced (`gestures.js`); prevenuti puntatori touch orfani in `fingerWriting` (`gestures.js`); evitata deselezione su pinch durante drag/resize lazo (`lazo.js`); consolidato il testo attivo prima di Undo/Redo da UI (`history.js`); limitato il refresh completo delle miniature su `history:restore` ai soli cambi pattern (`pages-sidebar.js`); mantenuta la selezione multipla cliccando i controlli libreria (`library.js`).",
        "**Test & Audit (B1)**: allineato `release-info.test.js` al percorso `src/shared/release/release-info.js` (197/197 test passati) e aggiornato `analisi_architetturale_e_audit_bug_inknote_studio.md`."
      ]
    },
    {
      "version": "0.2.2",
      "date": "2026-11-28",
      "items": [
        "Rimossi gli import residui da `src/shared/` verso `notebook/` e `library/`: spostati gli helper puri di gerarchia cartelle in `shared/core/folder-tree.js` e `setNonEnumerable` in `shared/core/utils.js`.",
        "Disaccoppiati `sharing-ui.js`, `settings-modal.js`, `library-auth.js`, `sync-ui.js` e `session.js` usando `closeAllFloatingMenus`, eventi (`auth:changed`, `help:open`) e registrazione adapter nel composition root (`main.js`).",
        "Aggiornato `analisi_architetturale_e_audit_bug_inknote_studio.md` con la mappatura architetturale `v0.2.2`, la verifica dei bug storici e il catalogo aggiornato delle criticità ancora aperte."
      ]
    },
    {
      "version": "0.2.0",
      "date": "2026-11-27",
      "items": [
        "Incluso il campo opzionale `smoothing` per-tratto nella serializzazione cloud/backup (`serialization-cloud-core.js`), completando l'allineamento dei metadati stroke con `serialization.js`.",
        "Aggiunto guard sul limite di 1 MiB di Firestore per singola pagina (`measureFirestorePagePayload`, `splitCompressedPageForFirestore`, `reassembleCompressedPageFromChunks`, `compressPageBundleForCloud`) con soglia di avviso e suddivisione/ricomposizione automatica in chunk binari.",
        "Implementata la sincronizzazione cloud manuale su Firestore (`sync-cloud.js`, `sync-helpers.js`, `sync-ui.js`): schema `firebase-blueprint.json` e regole di sicurezza `firestore.rules` per `sync_folders`, `sync_notebooks`, `pages` e `chunks`, zero listener automatici in background, deduplicazione delle pagine via SHA-256, tracciamento tombstone eliminazioni locali (`db.js`), risoluzione interattiva dei conflitti e riepilogo locale dei consumi giornalieri dal menu utente (`Sincronizza Cloud`)."
      ]
    },
    {
      "version": "0.1.11",
      "date": "2026-11-27",
      "items": [
        "Risolto errore `ResizeObserver loop completed with undelivered notifications` in libreria differendo le misurazioni di `#libraryControlsWrap` e `#libraryNotebooksScroll` su `requestAnimationFrame` e aggiornando le variabili CSS solo al cambio effettivo di valore."
      ]
    },
    {
      "version": "0.1.10",
      "date": "2026-11-27",
      "items": [
        "Spostata la barra di ricerca e filtri della libreria (`#libraryControlsWrap`) in overlay indipendente sopra la lista quaderni (`#libraryContentStage`), animandola esclusivamente su GPU (`transform` e `opacity`) senza spingere né ridimensionare la griglia sottostante.",
        "Ottimizzata la fluidità dello scorrimento su desktop rimuovendo i `backdrop-filter` ripetitivi dalle singole card, aggiungendo `contain: layout style paint` e sospendendo i micro-sollevamenti hover durante lo scroll attivo.",
        "Aggiunto `AGENTS.md` con le regole fisse del progetto (conferma esplicita prima di ogni modifica e aggiornamento costante di `log.md`)."
      ]
    },
    {
      "version": "0.1.9",
      "date": "2026-11-27",
      "items": [
        "Nascosta automaticamente la barra di ricerca e filtri della libreria (`#libraryControlsWrap`) sotto l'intestazione fissa quando si scorre verso il basso nella griglia/lista quaderni, con ricomparsa fluida allo scorrimento verso l'alto e protezione durante ricerca attiva, focus o drag-and-drop."
      ]
    },
    {
      "version": "0.1.8",
      "date": "2026-11-27",
      "items": [
        "Confinato lo scroll della libreria alla sola sezione quaderni/raccolte (`#libraryNotebooksScroll`) mantenendo fissi header e barra controlli, con scrollbar `.custom-scrollbar` coerente al tema chiaro e scuro dell'app."
      ]
    },
    {
      "version": "0.1.7",
      "date": "2026-11-27",
      "items": [
        "Pulito il meta tag `viewport` in `index.html` impostando `width=device-width, initial-scale=1.0` senza direttive contraddittorie (`user-scalable=no` / `maximum-scale=5.0`), preservando l'isolamento touch del canvas e prevenendo overflow su schermi mobili ridotti."
      ]
    },
    {
      "version": "0.1.6",
      "date": "2026-11-27",
      "items": [
        "Rendering a nastro continuo singolo su profilo isolato `ios` (iPadOS / Apple Pencil Pro) con ridisegno completo dello stroke attivo sull'overlay, finestre tangenti stabilizzate per la stilografica, canvas scratch ampliato, DPR adattivo allo zoom (fino a 3.8x/3.0x) e prediction layer 2x.",
        "Eliminazione delle sbavature a inizio e fine tratto su iPad: filtro anti-hover dopo contatto reale (`buttons === 0 && pressure === 0`), cattura controllata dell'estremità al `pointerup`, stabilizzazione iniziale di atterraggio e filtraggio temporale/spaziale della pressione a 120/240Hz.",
        "Potenziamento del riconoscimento su iPadOS di linee dritte (hold e rilascio), frecce, simboli, triangoli, cerchi, ellissi orientate e rettangoli inclinati tramite pulizia non distruttiva delle estremità (`cleanIosShapePoints` / `cleanIosReleasePoints`), ricampionamento uniforme e semplificazione RDP, senza impatti su Desktop/Surface e Android."
      ]
    },
    {
      "version": "0.1.5",
      "date": "2026-11-26",
      "items": [
        "Risolto l'overflow orizzontale su schermi stretti e smartphone in `#libraryView` e nell'intestazione libreria: adattata la barra azioni mobile (`< 420px`), abilitato il wrap sicuro su viewport molto strette, contenuto lo slot delle transizioni normale/selezione con `overflow-x: clip` e aggiunto `overflow-x-hidden` su `#libraryView` e `html, body`.",
        "Protetti da espansioni orizzontali i controlli filtro/ordinamento, i badge di ricerca nelle breadcrumb, le card in griglia/lista (`min-width: 0`), le miniature a ventaglio delle raccolte e i toast di notifica (`#toastNotification`) con messaggi lunghi."
      ]
    },
    {
      "version": "0.1.4",
      "date": "2026-11-26",
      "items": [
        "Centralizzato il calcolo di `visualViewport` e del clamping ai margini in `floating-menu-position.js` e `floating-menu.js` (rilevando anche resize/scroll della tastiera virtuale e pinch-zoom su iPadOS).",
        "Uniformati `#textSelectionMenu`, `#selectionMenu`, `#selectionStylePopover`, `#colorPickerPopover` e il dock trascinabile `#undoRedoContainer` sull'helper condiviso con flip automatico sotto l'header/dock e ripristino della posizione salvata alla chiusura della tastiera."
      ]
    },
    {
      "version": "0.1.3",
      "date": "2026-11-26",
      "items": [
        "Introdotta architettura a 3 profili dispositivo isolati (`desktop`, `ios`, `android`) in `notebook/platform/profiles`: comportamento Desktop/Surface preservato al 100%, tarature dedicate su iPadOS/Apple Pencil (Safari, Chrome e WKWebView) e profilo Android pronto per future calibrazioni.",
        "Risolto il tratto visivamente spezzato su iPadOS abilitando raccordi circolari continui anche sotto `1.8px`, fallback sicuro degli eventi `pointermove` a pressione `0` durante lo stroke attivo, deduplicazione coalesced e cattura dell'ultimo punto al `pointerup`.",
        "Migliorato il riconoscimento di linee dritte e frecce su iPad/Apple Pencil con pulizia non distruttiva dei micro-ganci di atterraggio/sollevamento e riduzione dell'effetto del micro-jitter 120/240Hz senza introdurre falsi snap su scrittura a mano libera."
      ]
    },
    {
      "version": "0.1.2",
      "date": "2026-11-26",
      "items": [
        "Segnalazione bug diretta su Firestore (`bug_reports`) tramite Auth anonima trasparente senza aprire il client email né esporre indirizzi.",
        "Controlli anti-spam su frontend e regole server (15–1500 caratteri, blocco duplicati/honeypot, cooldown atomico 5 min e limite 3 invii/24h)."
      ]
    },
    {
      "version": "0.1.1",
      "date": "2026-11-26",
      "items": [
        "Menu contestuale del lazo adattivo: mostra solo i controlli pertinenti per inchiostro, solo testo (colore, dimensione font `A- / px / A+`, modifica rapida) o selezione mista (colore unificato).",
        "Corretto il riquadro blu di selezione del lazo dopo duplicazione e incolla."
      ]
    },
    {
      "version": "0.1.0",
      "date": "2026-11-26",
      "items": [
        "Disaccoppiate impostazioni app e anteprima curva pressione dal motore di disegno, con aggiornamento live su `state.settings`.",
        "Unificato il drag & drop orizzontale della toolbar in un componente condiviso riutilizzabile."
      ]
    }
  ]
});
