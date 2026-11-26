
# InkNote Studio

App di note-taking con canvas per penna/stylus, in stile GoodNotes.
Vanilla JS + ES Modules, bundlata con Vite. Predisposta per essere
compilata come eseguibile desktop con Tauri.

# online version
[Link all'app funzionante](https://inknote-studio.web.app/)

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
