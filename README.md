

# COMMAND
- npm run dev
- npm run build → build classica multi-file (usata da Tauri e Capacitor)
- npm run build:singlefile → build a file singolo (per la versione online)
- npm run build:singlefileoffline → build a file singolo (per la versione offline)



# ToDO
[] fix sulle dimensioni del blocco note che mi sembra troppo piccolo
[x] dopo la selezione con in lazo potremmo aggiungere gli angoli attivi della selezione per effettuare un resize o un ruota

# REFACTORING ES
src/
├── main.js                                    ← composition root
├── style.css
├── core/
│   ├── state.js                               ← state + viewport
│   └── utils.js                               ← costanti + helper + bus + toast
├── services/
│   ├── db.js                                  ← IndexedDB puro
│   ├── auth.js                                ← login mock
│   └── settings.js                            ← logica settings + pressure cache
└── features/
    ├── library/library.js                     ← view + modale creazione
    ├── settings/settings.js                   ← modale impostazioni + calibrazione
    └── editor/
        ├── session.js                         ← currentNotebook
        ├── autosave.js                        ← debounce 500ms
        ├── editor.js                          ← open/close/sync
        ├── header.js                          ← page counter
        ├── history.js                         ← undo/redo
        ├── pages.js                           ← createNewPageDOM + resolution
        ├── transform.js                       ← applyTransform + pinch
        ├── gestures.js                        ← pan/pinch/pull-to-add
        ├── toolbar.js                         ← toolbar + subbar + theme
        ├── keyboard.js                        ← shortcuts
        ├── input.js                           ← pointer + batching rAF
        ├── render.js                          ← rendering + geometry bbox
        ├── shapes.js                          ← riconoscimento forme
        ├── scribble.js                        ← scribble-to-erase
        ├── lasso.js                           ← lasso + resize + menu
        └── export.js                          ← PDF + fullscreen
    
# Piano d'azione proposto
Oggi (in ordine):

Blocco 1 — fix rapidi e micro-ottimizzazioni (~1 ora)

Blocco 2 — drag/resize overlay (~mezza giornata)

Blocco 3 — sprint UX (~2 ore)

Totale: ~1 giorno di lavoro sul codice attuale.

Poi: refactoring ES modules (2-3 giorni), poi Tauri (1 giorno), poi Capacitor (1 giorno).




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


# Smart Ink: la funzione che separa “disegno” da “editing”
GoodNotes non si limita a raddrizzare linee e riconoscere forme. Ha Smart Ink: raddrizza la scrittura, inserisce spazio tra note, ridimensiona una sezione e fa reflow delle parole sulle righe. Inoltre gesture come Scribble to Erase e Circle to Lasso.

Voi avete già lazo e auto-forme, che è una base. I prossimi passi realistici:

[x] Lasso → sposta/ridimensiona/ruota il gruppo di tratti (non solo spostare).

[x] Lasso → cambia colore/spessore a posteriori.

[] Riconoscimento di gesture: scarabocchio = cancella, cerchio = seleziona. Sono euristiche geometriche, non ML, e valgono molto in usabilità.
    - da testare sul tablet

[] Il reflow del handwriting è molto più complesso: richiede segmentazione in parole/righe e un modello di layout. È un progetto a sé, non un “dettaglio”.


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

