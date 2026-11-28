// ============================================================
// CATALOGO SCORCIATOIE DA TASTIERA (modulo puro, senza DOM)
// ============================================================

/**
 * Restituisce true se la piattaforma usa convenzioni Apple (Cmd ⌘)
 * anziché Ctrl (Windows / Linux / Android).
 *
 * @param {{ os?: string } | null | undefined} platformInfo
 * @returns {boolean}
 */
export function isMacStylePlatform(platformInfo) {
  const os = platformInfo?.os;
  return os === 'macos' || os === 'ipados';
}

/**
 * Restituisce l'etichetta del tasto modificatore principale per la piattaforma.
 *
 * @param {{ os?: string } | null | undefined} platformInfo
 * @returns {'⌘' | 'Ctrl'}
 */
export function getModifierKeyLabel(platformInfo) {
  return isMacStylePlatform(platformInfo) ? '⌘' : 'Ctrl';
}

/**
 * Restituisce i gruppi di scorciatoie effettivamente attive in editor.
 * Ogni voce contiene una lista di combinazioni (`combos`), dove ogni
 * combinazione è un array di tasti da premere insieme (es. `['Ctrl', 'Z']`).
 *
 * @param {{ os?: string } | null | undefined} platformInfo
 * @returns {Array<{
 *   id: string,
 *   title: string,
 *   items: Array<{ id: string, label: string, combos: string[][] }>
 * }>}
 */
export function getShortcutGroups(platformInfo) {
  const mod = getModifierKeyLabel(platformInfo);

  return [
    {
      id: 'tools',
      title: 'Strumenti',
      items: [
        { id: 'tool-marker', label: 'Penna', combos: [['M']] },
        { id: 'tool-pencil', label: 'Matita', combos: [['X']] },
        { id: 'tool-pen', label: 'Stilografica', combos: [['P']] },
        { id: 'tool-highlighter', label: 'Evidenziatore', combos: [['H']] },
        { id: 'tool-text', label: 'Testo', combos: [['T']] },
        { id: 'tool-lasso', label: 'Selezione / Lazo', combos: [['L']] },
        { id: 'tool-eraser', label: 'Gomma', combos: [['E']] }
      ]
    },
    {
      id: 'edit',
      title: 'Modifica e selezione',
      items: [
        { id: 'edit-undo', label: 'Annulla ultima azione', combos: [[mod, 'Z']] },
        { id: 'edit-redo', label: 'Ripristina', combos: [[mod, 'Y'], [mod, 'Shift', 'Z']] },
        { id: 'edit-copy', label: 'Copia selezione', combos: [[mod, 'C']] },
        { id: 'edit-cut', label: 'Taglia selezione', combos: [[mod, 'X']] },
        { id: 'edit-paste', label: 'Incolla selezione', combos: [[mod, 'V']] },
        { id: 'edit-duplicate', label: 'Duplica selezione', combos: [[mod, 'D']] },
        { id: 'edit-delete', label: 'Elimina selezione o testo', combos: [['Canc'], ['Backspace']] },
        { id: 'edit-escape', label: 'Chiudi menu o deseleziona', combos: [['Esc']] }
      ]
    },
    {
      id: 'view',
      title: 'Vista e file',
      items: [
        { id: 'view-save', label: 'Salva quaderno', combos: [[mod, 'S']] },
        { id: 'view-fullscreen', label: 'Schermo intero', combos: [['F']] },
        { id: 'view-zoom-in', label: 'Aumenta zoom', combos: [['+'], ['=']] },
        { id: 'view-zoom-out', label: 'Riduci zoom', combos: [['-']] },
        { id: 'view-zoom-reset', label: 'Ripristina zoom 100%', combos: [['0']] },
        { id: 'view-help', label: 'Mostra / nascondi questa guida', combos: [['?']] }
      ]
    }
  ];
}

/**
 * Determina se un KeyboardEvent deve aprire o chiudere (toggle) la guida
 * delle scorciatoie tramite il tasto `?`.
 *
 * Non esclude `shiftKey` perché su tastiere italiane, US e molte altre
 * il carattere `?` si digita tenendo premuto Shift.
 *
 * @param {KeyboardEvent | {
 *   key?: string,
 *   ctrlKey?: boolean,
 *   metaKey?: boolean,
 *   altKey?: boolean,
 *   defaultPrevented?: boolean,
 *   isComposing?: boolean,
 *   target?: { matches?: (sel: string) => boolean, isContentEditable?: boolean } | null
 * } | null | undefined} e
 * @returns {boolean}
 */
export function shouldToggleShortcutsModalKey(e) {
  if (!e || e.defaultPrevented || e.isComposing) return false;
  const target = e.target;
  if (target) {
    if (target.isContentEditable) return false;
    if (typeof target.matches === 'function' && target.matches('input, textarea, select, [contenteditable="true"]')) {
      return false;
    }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key === '?';
}

export const HELP_MODAL_TABS = ['guide', 'shortcuts'];

/**
 * Normalizza il tab attivo della modale Guida & Scorciatoie.
 *
 * @param {string | null | undefined} tab
 * @returns {'guide' | 'shortcuts'}
 */
export function normalizeHelpTab(tab) {
  return tab === 'guide' ? 'guide' : 'shortcuts';
}

/**
 * Restituisce le sezioni della guida rapida e dei trucchi dell'app
 * (nessuna dipendenza dal DOM).
 *
 * @param {{ os?: string } | null | undefined} platformInfo
 * @returns {Array<{
 *   id: string,
 *   title: string,
 *   badge: string,
 *   items: Array<{ title: string, description: string }>
 * }>}
 */
export function getAppGuideSections(platformInfo) {
  const mod = getModifierKeyLabel(platformInfo);

  return [
    {
      id: 'drag-drop',
      title: 'Personalizzazione con Drag & Drop',
      badge: 'Pressione prolungata',
      items: [
        {
          title: 'Riordina o nascondi i menu in alto',
          description: 'Tieni premuto (~0,5s) su Scrittura, Testo, Selezione, Forme, Gomma o Foglio e trascina in orizzontale per spostarli, oppure verso il basso per nasconderli (li ritrovi nel menu Condividi).'
        },
        {
          title: 'Riordina gli strumenti di scrittura',
          description: 'Tieni premuto su Penna, Matita, Stilografica o Evidenziatore nel dock e trascina orizzontalmente per scegliere l\'ordine che preferisci.'
        },
        {
          title: 'Sposta Annulla e Ripristina',
          description: 'Trascina direttamente il pannello Annulla / Ripristina da qualsiasi punto per posizionarlo in qualsiasi angolo dello schermo.'
        }
      ]
    },
    {
      id: 'shapes-math',
      title: 'Forme, Simboli e Lettere Greche',
      badge: 'Menu Forme',
      items: [
        {
          title: 'Linee, cerchi, rettangoli e triangoli',
          description: 'Disegna la figura e tieni ferma la penna un istante prima di sollevarla. Le linee dritte si agganciano in orizzontale/verticale (se poi le sposti, restano libere su quel tratto).'
        },
        {
          title: 'Frecce, simboli matematici e greco',
          description: 'Frecce, parentesi (), [], {}, ∑, ⇒ e lettere greche (α, β, Δ, Ω…) vengono convertiti automaticamente al rilascio. Puoi attivare ogni categoria dal menu Forme.'
        }
      ]
    },
    {
      id: 'touch-ink',
      title: 'Touch, Penna e Calibrazione',
      badge: 'Impostazioni',
      items: [
        {
          title: 'Zoom e scorrimento a 2 dita',
          description: 'Usa 2 dita per spostarti e fare zoom sul foglio. Disattivando «Scrittura con il dito» in Impostazioni, 1 dito scorre la pagina mentre scrivi solo con la stilo.'
        },
        {
          title: 'Curva pressione su iPad e Surface',
          description: 'Nella sezione Inchiostro delle Impostazioni puoi calibrare sensibilità, spessore minimo/massimo e velocità con prova dal vivo (senza alterare i tratti già scritti).'
        }
      ]
    },
    {
      id: 'library-sync',
      title: 'Pagine, Backup e Condivisione',
      badge: 'Libreria & Editor',
      items: [
        {
          title: 'Barra pagine e stile del foglio',
          description: 'Apri la linguetta laterale per aggiungere o riordinare le pagine; dal menu Foglio puoi cambiare righe, quadretti, puntinato e colori personalizzati.'
        },
        {
          title: 'Raccolte, export e profilo Google',
          description: `Organizza in Raccolte, esporta in PDF o .inknote, e accedi con Google per inviare quaderni ad altri utenti. Premi ? o ${mod}+S per guida e salvataggio rapido.`
        }
      ]
    }
  ];
}
