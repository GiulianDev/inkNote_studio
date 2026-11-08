
# InkNote Studio

App di note-taking con canvas per penna/stylus, in stile GoodNotes.
Vanilla JS + ES Modules, bundlata con Vite. Predisposta per essere
compilata come eseguibile desktop con Tauri.

## Prerequisiti

- **Node.js** ≥ 18 (raccomandato 20+)
- **npm** ≥ 9

## Comandi

```bash
# installa dipendenze
npm install

# dev server con HMR
npm run dev
# → apri http://localhost:5173/

# build di produzione (in dist/)
npm run build

# anteprima del build di produzione (NON durante lo sviluppo)
npm run preview
```

> ⚠️ **Durante lo sviluppo usa sempre `npm run dev`**, mai `npm run preview`.
> Apri sempre `http://localhost:5173/` e **mai** il file `index.html` da
> `file://` (i moduli ES non caricano da file system).

## Struttura

```
src/
├── main.js                    Composition root (bootstrap)
├── style.css                  CSS (Tailwind + custom)
├── core/
│   ├── state.js               Stato globale (state + viewport)
│   └── utils.js               Costanti, helper puri, event bus, toast
├── services/
│   ├── db.js                  IndexedDB puro
│   ├── auth.js                Login Google (mock)
│   └── settings.js            Persistenza impostazioni + cache pressione
└── features/
    ├── library/library.js           Vista libreria + modale nuovo quaderno
    ├── settings/settings.js         Modale impostazioni + calibrazione
    └── editor/
        ├── session.js               Notebook aperto + sync/save
        ├── autosave.js              Debounce 500ms → save
        ├── editor.js                open/close notebook
        ├── header.js                Page counter
        ├── history.js               Undo/redo (snapshot per-pagina)
        ├── pages.js                 createNewPageDOM + resolution
        ├── transform.js             applyTransform + pinch
        ├── gestures.js              Pan/pinch/pull-to-add-page
        ├── toolbar.js               Toolbar + subbar + theme
        ├── keyboard.js              Shortcuts
        ├── input.js                 Pointer handlers + batching rAF
        ├── render.js                Rendering + geometry bbox
        ├── shapes.js                Riconoscimento forme
        ├── scribble.js              Scribble-to-erase
        ├── lasso.js                 Lasso + resize + selection menu
        ├── export.js                PDF + fullscreen
        └── bindings.js              Bind di tutta la UI editor
```

## Architettura (in 30 secondi)

- **Moduli ES** con una sola direzione di dipendenza:
  `core ← services ← features ← main.js`
- **Nessun ciclo di import** (verificato).
- **Nessun `onclick` inline**: tutti i listener sono in `bindings.js` (editor),
  `library.js#bindLibraryUI`, `settings.js#bindSettingsUI`.
- **Stato in `core/state.js`** (`state` + `viewport`), plain object mutabili,
  senza Proxy/reactive (hot path a 120+ Hz).
- **Event bus** (`emit`/`on`) solo per broadcast UI a bassa frequenza
  (`library:refresh`, `history:restore`, `settings:changed`).
- **Callback injection** per rompere gli accoppiamenti caldi
  (`setViewportChangeHandler`, `setDarkModeHandler`).

## Note di performance

Il motore di disegno usa:

- `pointerrawupdate` (Chrome/Edge/WebView2) per minima latenza
- Batching rAF: max 8 punti per frame, poi flush sincrono
- Overlay canvas: lo stroke in corso è disegnato lì, poi copiato 1:1
  sul page canvas al pointerup (evita redraw O(N) per ogni punto)
- Cache stile (`stroke._styleCache`) invalidata solo su cambio tema
- Cache lunghezza path (`stroke._pathLen`) per il riconoscimento forme

Ottimizzazioni rimandate (Fase 6):

- History: version counter invece di `JSON.stringify` per confronto snapshot
- `getCanvasCoords` con out-param (elimina ~200 allocazioni/sec)
- `palmRejectionEnabled` / `eraserMode` spostati nello store
  (eliminano `getElementById` dal hot path)

## Roadmap

- [x] Refactoring a ES Modules con gerarchia pulita
- [x] Rimozione `onclick` inline e bridge `window.*`
- [ ] Pulizia finale (rename `services/settings.js` → `preferences.js`)
- [ ] Compilazione Tauri (`.exe` / `.app` / `.AppImage`)
- [ ] Ottimizzazioni Fase 6 con benchmark

## Licenza

Da definire.




## CONFRONTO CON GOODNOTES

# Il gap più grande: i PDF (non solo esportarli, ma abitarli)
    GoodNotes non è “un’app che esporta PDF”: è un’app costruita attorno ai PDF. La differenza è enorme.

# Latenza e “feeling” della penna: il gap tecnico più difficile
    GoodNotes sulla PWA Windows usa la Ink API di Microsoft: i punti vengono passati direttamente al compositor del sistema operativo, fuori dal ciclo di rendering del browser, abbattendo la latenza. 
    Questo è il motivo per cui l’inchiostro “sembra carta” anche sul web.

    Voi oggi disegnate con Canvas 2D e drawIncrementalSegment; è corretto, ma resta nel loop del browser. Le strade per avvicinarsi:

    getCoalescedEvents() su pointermove per non perdere punti tra un frame e l’altro (GoodNotes lo fa esplicitamente).

    navigator.ink.requestPresenter() quando disponibile (Edge/Windows): è un progressive enhancement, non funziona su Safari/iPad, ma su Windows/Edge migliora drasticamente.

    Doppio canvas: uno “live” a bassa persistenza per il tratto in corso, uno “committed” per tutti i tratti già confermati. Ridisegnare l’intera pagina ad ogni move è il collo di bottiglia principale su pagine con molti tratti.

    Valutare WebGL2 solo se il profiling mostra che il 2D è il limite: per 2D vettoriale il 2D è spesso sufficiente, ma con migliaia di tratti il fill dei trapezi può pesare.


# Ricerca e OCR: senza questo non è “professionale”
GoodNotes cerca contemporaneamente scrittura a mano, testo digitato e testo dentro i PDF, e ti dice in che pagina ha trovato la risposta. L’OCR di GoodNotes produce più candidati per parola (non una singola trascrizione) e li indicizza in un indice full-text.

Per una web app, l’OCR on-device è realistico con Tesseract.js o un modello WASM, ma la vera difficoltà è l’indicizzazione incrementale: ogni volta che aggiungi un tratto, non puoi ri-OCR-izzare l’intera pagina. La strategia corretta è:

OCR asincrono in background dopo il salvataggio (Web Worker), non durante il disegno.

Indice full-text separato dai dati delle pagine, così la ricerca non deve scorrere tutti gli stroke.

Per la scrittura a mano, l’OCR è molto meno affidabile che per il testo stampato: GoodNotes lo compensa con un modello addestrato. Sul web dovreste valutare se partire solo dal testo dei PDF importati e dalla conversione handwriting-to-text esplicita, rimandando l’OCR handwriting continuo.


# Organizzazione e account: la parte “noiosa” ma indispensabile
GoodNotes ha libreria, cartelle, ricerca globale, sincronizzazione via Goodnotes Cloud tra iPad/Android/Windows/Web, e condivide impostazioni e colori tra dispositivi.

Voi avete una libreria locale in IndexedDB, che è ottima per l’offline ma non è un’organizzazione documentale. Per un uso professionale servono almeno:

Cartelle/collezioni e tag.

Ricerca globale (titolo + contenuto OCR/tratti).

Duplicazione, esportazione selettiva, backup/ripristino.

Account e sync: qui la scelta architetturale è grossa. IndexedDB da solo non sincronizza. Le opzioni realistiche sono un backend con sync a operazioni e CRDT/merge per le annotazioni, oppure un modello “file-based” con un file di quaderno versionato e conflict resolution a livello di file. GoodNotes ha optato per un cloud proprietario; per una web app, un backend con outbox e merge a livello di stroke è il minimo per non perdere dati in conflitto.

