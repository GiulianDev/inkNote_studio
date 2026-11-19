# Analisi Architetturale e Audit Bug — InkNote Studio

Questo documento raccoglie la ricostruzione del flusso applicativo di **InkNote Studio** e l'elenco dei potenziali bug individuati durante l'analisi del codice, suddivisi per livello di gravità con relative indicazioni di intervento.

---

## 1. Flusso Completo dell'Applicazione

### 1.1 Bootstrap e Vista Libreria (`index_2.html` -> `main.js` -> `library_2.js`)
1. All'avvio l'utente visualizza `#libraryView` (`z-50`), che copre l'intero viewport sopra l'area di lavoro dell'editor.
2. `bindLibraryUI()` inizializza il listener di autenticazione Google (`onAuthChange` -> `updateAuthUI()`) e registra gli handler per:
   - Creazione nuovo quaderno (`#newNotebookModal`).
   - Importazione backup (`.inknote`).
   - Apertura impostazioni globali.
   - Gestione della modalità selezione multipla.
3. `renderLibraryView()` carica tutti i quaderni da IndexedDB tramite `loadAllNotebooksFromDB()`, li ordina per `updatedAt` decrescente e popola `#notebooksGrid`.
4. Una pressione prolungata su una card per `500 ms` (`LP_PRESS_MS`) attiva `_selectionMode` e mostra la barra contestuale `#librarySelectionBar` (Seleziona tutto, Duplica, Esporta, Elimina).

### 1.2 Apertura Quaderno ed Editor (`library_2.js` -> `editor.js` -> `pages.js` / `renderer.js`)
1. Il tap/click su una card chiama `openNotebook(nb.id)`, che recupera metadati e pagine da IndexedDB, nasconde `#libraryView`, monta la toolbar in `#toolbarMount` e renderizza le pagine dentro `#canvasContainer`.
2. Lo stato dell'editor (pagine, tratti, caselle di testo, strumento attivo, palm rejection, scrittura con il dito) viene condiviso tra i moduli tramite `state` e `viewport`.

### 1.3 Pipeline Input, Palm Rejection e Navigazione (`gestures_3.js` <-> `tools/dispatcher.js` & `transform_3.js`)
Tutti gli eventi `pointer*` su `#viewport` vengono intercettati in fase `capture` da `setupViewportGestures()`:

* **Penna / Gomma (`pointerType === 'pen' | 'eraser'`)**:
  - Aggiorna i flag di stato (`_penInRange`, `_penDown`) e i timestamp per le finestre di grazia del palm rejection.
  - Se era appena iniziato un pan (`< 400 ms`) o un pinch non ancora confermato, esegue il rollback della trasformazione e cancella i puntatori touch attivi, lasciando proseguire l'evento verso gli strumenti di disegno.
* **Tocco singolo (`1 dito`)**:
  - Se `state.palmRejection` è attivo, ignora i contatti con superficie ampia (`> 100 px` su iPadOS, `> 60 px` sugli altri dispositivi) e i tocchi che ricadono nelle finestre di grazia post-penna (`150 ms` dopo `pointerup`/`pointercancel`, `500 ms` dopo `pointerleave`).
  - Se `state.fingerWriting` è disattivo, avvia il pan con blocco opzionale sull'asse verticale (`_scrollAxisLocked`), inerzia al rilascio (`_startMomentum` tramite `requestAnimationFrame`) e *pull-to-add-page* quando si trascina oltre il margine inferiore partendo dal fondo (`_startedAtBottom`).
* **Doppio tocco (`2 dita`)**:
  - Entra in `isPinching` solo se il secondo dito arriva entro la finestra temporale ammessa (`350 ms` se vicino, `300 ms` su iOS / `200 ms` altrove se lontano) e a distanza valida (`30 px` - `850 px` su iOS).
  - Interrompe eventuali tratti in corso (`abortCurrentDrawing()`), attende la soglia di conferma del movimento (`_pinchConfirm`) e applica lo zoom attorno al baricentro tramite `applyPinchTransform()`.
* **Transform e Clamp (`transform_3.js`)**:
  - `clampViewport()` mantiene il foglio vincolato ai bordi del viewport sfruttando una cache calcolata a scala unitaria (`_clampCache`) per evitare reflow ad ogni frame di animazione.
  - Al termine della gesture viene invocato `scheduleResolutionRefresh()` per ridisegnare i canvas alla risoluzione corretta.

---

## 2. Potenziali Bug Individuati

### Livello Critico (Perdita dati o blocco interazione)

#### 1. Perdita di contenuti nella duplicazione dei quaderni
* **File**: `library_2.js` — funzione `handleDuplicateSelection()`
* **Descrizione del problema**:
  Durante la duplicazione, le pagine vengono ricreate copiando esclusivamente `pageId` e `strokes`:
  ```js
  const newPages = (src.pages || []).map(p => ({
    pageId: generatePageId(),
    strokes: _deepClone(p.strokes || [])
  }));
  ```
  Qualsiasi altra proprietà presente sull'oggetto pagina (caselle di testo, sfondi PDF, pattern per singola pagina, immagini) o campi aggiuntivi del quaderno vengono persi nel duplicato.
* **Soluzione consigliata**:
  Clonare l'intero oggetto pagina sovrascrivendo solo `pageId` (`{ ..._deepClone(p), pageId: generatePageId() }`) e clonare l'intero oggetto quaderno sovrascrivendo solo identificativi, titolo e timestamp.

---

#### 2. Possibile blocco permanente del touch (`_gestureBlocked`) se un puntatore resta orfano
* **File**: `gestures_3.js` — funzioni `onPointerDown` (`count >= 3`) e `onPointerEnd`
* **Descrizione del problema**:
  Quando vengono rilevati 3 o più tocchi simultanei (ad esempio palmo + dita), `_gestureBlocked` viene impostato a `true` e viene resettato **unicamente** quando `viewport.activePointers.size === 0` in `onPointerEnd`. Su iPadOS/Safari il sistema operativo può sopprimere gli eventi `pointerup` o `pointercancel` di un tocco scartato dal palm rejection di sistema: se anche un solo `pointerId` rimane in `activePointers`, `size` non torna mai a `0` e **tutte le gesture touch (pan e pinch) restano bloccate** fino a un evento `window blur`.
* **Soluzione consigliata**:
  Svuotare `viewport.activePointers` (rilasciando le relative pointer capture) non appena `count >= 3` attiva `_gestureBlocked`, oppure introdurre un timer di pulizia di sicurezza per puntatori rimasti attivi senza eventi.

---

#### 3. Stato sporco in `activePointers` quando `state.fingerWriting === true`
* **File**: `gestures_3.js` — funzione `onPointerDown` (`count === 1`)
* **Descrizione del problema**:
  `viewport.activePointers.set(e.pointerId, ...)` viene eseguito **prima** del controllo `if (state.fingerWriting) return;`, ma in questo ramo non viene chiamato `setPointerCapture`. Se l'utente scrive con il dito, esce dai bordi di `#viewport` e solleva il dito, `#viewport` può non ricevere `pointerup`: il puntatore resta registrato in `activePointers`, così al tocco successivo `count` risulta pari a `2` e innesca un pinch involontario che chiama `abortCurrentDrawing()`, impedendo la scrittura.
* **Soluzione consigliata**:
  Rimuovere immediatamente `e.pointerId` da `viewport.activePointers` prima del `return` quando `state.fingerWriting` è attivo (oppure inserirlo solo dopo aver verificato che `state.fingerWriting` sia disattivo).

---

### Livello Alto (UX compromessa in scenari reali)

#### 4. Impossibile passare da pan a 1 dito a pinch a 2 dita dopo $300\text{ ms}$
* **File**: `gestures_3.js` — funzione `onPointerDown` (`count === 2`)
* **Descrizione del problema**:
  `_firstTouchDownTime` viene memorizzato all'appoggio del primo dito e confrontato con `maxTime` (`300 ms` su iOS, `200 ms` altrove). Se l'utente scorre la pagina con un dito per più di $0.3\text{ s}$ e poi appoggia il secondo dito per zoomare senza sollevare il primo, il secondo tocco viene ignorato (`activePointers.delete`). Lo stesso accade in modalità `fingerWriting` se si scrive con un dito per più di $0.3\text{ s}$ e si appoggia il secondo dito per spostare il foglio.
* **Soluzione consigliata**:
  Applicare il vincolo temporale `timeSinceFirst > maxTime` solo ai tocchi fermi o a grande distanza (tipici di un palmo appoggiato durante la scrittura), consentendo invece la transizione al pinch quando il primo dito è già in pan attivo.

---

#### 5. Cache dei limiti di scroll (`_clampCache`) non invalidata al cambio quaderno o dimensione pagina
* **File**: `transform_3.js` — funzione `_computeClampBounds()`
* **Descrizione del problema**:
  La chiave di cache è `${state.pages.length}|${window.innerWidth}|${window.innerHeight}`. Se l'utente chiude un quaderno di 1 pagina e ne apre un altro sempre di 1 pagina ma con dimensioni diverse (ad esempio un PDF importato o un orientamento diverso), oppure se l'altezza di `#viewport` cambia senza alterare `window.innerHeight` (es. apertura/chiusura della toolbar), `_clampCache` restituisce i limiti precedenti tagliando fuori porzioni del foglio.
* **Soluzione consigliata**:
  Invocare `invalidateClampCache()` all'apertura/chiusura di ogni quaderno, al cambio dimensioni pagina e al toggle della toolbar, oppure includere l'ID del quaderno corrente nella `cacheKey`.

---

#### 6. Zoom da trackpad o rotella (`wheel`) lascia i canvas a bassa risoluzione
* **File**: `gestures_3.js` — listener `wheel` con `e.ctrlKey`
* **Descrizione del problema**:
  Lo zoom eseguito tramite gesture pinch su trackpad o `Ctrl + Rotella` invoca `applyPinchTransform()`, ma a differenza del pinch touch non chiama mai `scheduleResolutionRefresh()`. Di conseguenza il contenuto rimane renderizzato alla densità pixel precedente allo zoom.
* **Soluzione consigliata**:
  Aggiungere una chiamata debounced a `scheduleResolutionRefresh()` al termine dello zoom via `wheel`.

---

### Livello Medio / Basso

#### 7. File `.inknote` non selezionabili nel file picker di iPadOS
* **File**: `index_2.html` — elemento `<input type="file" id="importFileInput" accept=".inknote" hidden>`
* **Descrizione del problema**:
  Su iPadOS Safari, specificare esclusivamente un'estensione custom come `.inknote` senza un MIME type standard di fallback fa sì che i file risultino grigi e non selezionabili nell'app File / iCloud Drive.
* **Soluzione consigliata**:
  Estendere l'attributo a `accept=".inknote,application/json,application/octet-stream"` (oppure rimuovere `accept` e delegare la validazione al parser in `importNotebooks`).

---

#### 8. Tocco sullo sfondo della libreria per scorrere chiude la modalità selezione
* **File**: `library_2.js` — funzione `bindLibraryUI()`, listener globale su `document` (`pointerdown`)
* **Descrizione del problema**:
  Su dispositivi touch, se l'utente è in `_selectionMode` e appoggia il dito in uno spazio vuoto tra le card per scorrere la griglia, l'evento `pointerdown` chiude immediatamente la modalità selezione prima ancora che inizi lo scroll.
* **Soluzione consigliata**:
  Sostituire l'uscita su `pointerdown` con un controllo su `click` (tap breve senza trascinamento), verificando che il target non appartenga a una card né a `#librarySelectionBar`.

---

#### 9. Doppio tap su "Crea Quaderno" e race condition in `renderLibraryView()`
* **File**: `library_2.js` — funzioni `confirmCreateNotebook()` e `renderLibraryView()`
* **Descrizione del problema**:
  * `confirmCreateNotebook()` non disabilita il pulsante `#confirmCreateNbBtn` durante `await saveNotebookToDB(...)` e genera l'ID con `'nb_' + Date.now()` privo di suffisso casuale: un doppio tap rapido può creare due quaderni duplicati con rischio di collisione sull'ID.
  * `renderLibraryView()` non utilizza un contatore di richiesta per scartare risposte asincrone obsolete di `loadAllNotebooksFromDB()` in caso di chiamate ravvicinate.
* **Soluzione consigliata**:
  Disabilitare `#confirmCreateNbBtn` durante il salvataggio, aggiungere un suffisso casuale all'ID del nuovo quaderno e introdurre un token incrementale in `renderLibraryView()`.

---

#### 10. Posizionamento iniziale di `#undoRedoContainer` su viewport stretti
* **File**: `index_2.html` — elemento `#undoRedoContainer` (`style="top: 140px; left: 80px;"`)
* **Descrizione del problema**:
  Su smartphone o finestre iPad in Split View ridotto, un offset fisso `left: 80px` abbinato a due pulsanti da $56 \times 56\text{ px}$ (`w-14 h-14`) posiziona il widget flottante quasi al centro dell'area di scrittura.
* **Soluzione consigliata**:
  Ridurre l'offset orizzontale iniziale (es. `left: 16px` o `left: 24px`) o calcolarlo dinamicamente in base alla larghezza del viewport.

---

## 3. Aree Critiche da Verificare nei Restanti Moduli

Per completare la revisione sull'intera codebase, si consiglia di verificare anche:
1. **`services/db.js` <-> `editor.js`**: gestione della concorrenza tra salvataggio automatico debounced e chiusura rapida del quaderno (`closeNotebookIfOpen`), oltre alla rimozione delle pagine orfane in IndexedDB.
2. **`tools/dispatcher.js` <-> `text/text-editor.js`**: transizione del focus e dei puntatori tra disegno a penna, selezione lazo (`lazo.js`) e caselle di testo su iPadOS durante l'apertura/chiusura della tastiera virtuale.
3. **`pdf/pdf-import.js` e `backup/backup-import.js`**: gestione dell'allocazione memoria con PDF multi-pagina ad alta risoluzione e retrocompatibilità dello schema `.inknote`.