/**
 * @module features/toolbar/tool-dock
 *
 * Componente globale riutilizzabile per i dock contestuali dei tool
 * (`<ink-tool-dock>` / `.ui-dock`):
 *   - Uniforma tutti i pannelli dei singoli tool (Scrittura, Testo, Selezione,
 *     Forme, Gomma) allo stesso linguaggio visivo di Foglio (`#pagePopover`),
 *     `<ink-menu>` e delle barre flottanti di selezione.
 *   - Aggiunge automaticamente le classi e gli attributi ARIA standard senza
 *     modificare la logica dei singoli tool.
 */

export function ensureToolDockAttributes(el) {
  if (!el || !el.classList) return;
  el.classList.add('ui-dock', 'context-dock');
  if (typeof el.hasAttribute === 'function' && !el.hasAttribute('role')) {
    el.setAttribute('role', 'toolbar');
  }
}

const BaseHTMLElement = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

export class InkToolDockElement extends BaseHTMLElement {
  connectedCallback() {
    ensureToolDockAttributes(this);
  }
}

export function registerToolDockElement(registry = typeof customElements !== 'undefined' ? customElements : null) {
  if (registry && !registry.get('ink-tool-dock')) {
    registry.define('ink-tool-dock', InkToolDockElement);
  }
}

registerToolDockElement();
