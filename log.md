# InkNote Studio — Changelog

## v0.1.2 — 2026-11-26
- Segnalazione bug diretta su Firestore (`bug_reports`) tramite Auth anonima trasparente senza aprire il client email né esporre indirizzi.
- Controlli anti-spam su frontend e regole server (15–1500 caratteri, blocco duplicati/honeypot, cooldown atomico 5 min e limite 3 invii/24h).

## v0.1.1 — 2026-11-26
- Menu contestuale del lazo adattivo: mostra solo i controlli pertinenti per inchiostro, solo testo (colore, dimensione font `A- / px / A+`, modifica rapida) o selezione mista (colore unificato).
- Corretto il riquadro blu di selezione del lazo dopo duplicazione e incolla.

## v0.1.0 — 2026-11-26
- Disaccoppiate impostazioni app e anteprima curva pressione dal motore di disegno, con aggiornamento live su `state.settings`.
- Unificato il drag & drop orizzontale della toolbar in un componente condiviso riutilizzabile.
