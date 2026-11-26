// File generato automaticamente da scripts/sync-release.mjs durante il build.
// NON modificare manualmente: viene rigenerato ad ogni `npm run build`.

export const RELEASE_INFO = Object.freeze({
  "version": "0.1.4",
  "builtAt": "2026-11-26T19:27:29.357Z",
  "date": "2026-11-26",
  "currentNotes": [
    "Centralizzato il calcolo di `visualViewport` e del clamping ai margini in `floating-menu-position.js` e `floating-menu.js` (rilevando anche resize/scroll della tastiera virtuale e pinch-zoom su iPadOS).",
    "Uniformati `#textSelectionMenu`, `#selectionMenu`, `#selectionStylePopover`, `#colorPickerPopover` e il dock trascinabile `#undoRedoContainer` sull'helper condiviso con flip automatico sotto l'header/dock e ripristino della posizione salvata alla chiusura della tastiera."
  ],
  "notesSourceVersion": "0.1.4",
  "hasExactChangelog": true,
  "releases": [
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
