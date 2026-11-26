# InkNote Studio

**InkNote Studio** è un'app web di note-taking a mano libera su canvas pensata per penna e stylus (Surface Pen, Apple Pencil e stilo Android), in stile GoodNotes. È sviluppata in Vanilla JS + ES Modules con Tailwind CSS, bundlata con Vite, funziona interamente in locale sul browser (IndexedDB) ed è predisposta anche per l'esecuzione desktop/offline.

### Funzionalità principali
- **Scrittura e inchiostro**: penna, matita, stilografica ed evidenziatore con supporto a pressione, inclinazione, stili di tratto personalizzati, levigatura adattiva, palm rejection e profili calibrati per Desktop/Surface, iPadOS e Android.
- **Forme, testo e lazo**: riconoscimento rapido di linee dritte, cerchi, rettangoli, triangoli e frecce, caselle di testo formattabili, gomma per tratto o precisa e selezione lazo mista (inchiostro + testo) per spostare, ridimensionare, ruotare o cambiare stile.
- **Libreria, export e condivisione**: gestione di quaderni multipagina e raccolte con ricerca e preferiti, esportazione in **PDF** e backup `.inknote`, più accesso Google opzionale per inviare quaderni agli amici.

## Versione online
[Apri InkNote Studio](https://inknote-studio.web.app/)

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

# build di produzione su singolo file html (in dist/)
npm run build:singlefile

# anteprima del build di produzione (NON durante lo sviluppo)
npm run preview
```

# firebase
firebase login
firebase init
firebase deploy


> ⚠️ **Durante lo sviluppo usa sempre `npm run dev`**, mai `npm run preview`.
> Apri sempre `http://localhost:5173/` e **mai** il file `index.html` da
> `file://` (i moduli ES non caricano da file system).
