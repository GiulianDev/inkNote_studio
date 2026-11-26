// File generato automaticamente da scripts/sync-release.mjs durante il build.
// NON modificare manualmente: viene rigenerato ad ogni `npm run build`.

export const RELEASE_INFO = Object.freeze({
  "version": "0.1.2",
  "builtAt": "2026-11-26T14:11:58.355Z",
  "date": "2026-11-26",
  "currentNotes": [
    "Segnalazione bug diretta su Firestore (`bug_reports`) tramite Auth anonima trasparente senza aprire il client email né esporre indirizzi.",
    "Controlli anti-spam su frontend e regole server (15–1500 caratteri, blocco duplicati/honeypot, cooldown atomico 5 min e limite 3 invii/24h)."
  ],
  "notesSourceVersion": "0.1.2",
  "hasExactChangelog": true,
  "releases": [
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
