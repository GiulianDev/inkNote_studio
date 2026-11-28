/**
 * @module shared/core/ui-icons
 *
 * Registro centralizzato di icone SVG monocromatiche a tratto uniforme (1.75px)
 * per toast, stati vuoti e indicatori di stato, sostituendo le emoji di sistema.
 */

function _svg(body, cls = 'w-4 h-4') {
  return `<svg class="${cls} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const SVG_SPECS = {
  info: {
    cls: 'w-4 h-4 text-sky-400 dark:text-sky-600',
    body: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'
  },
  warning: {
    cls: 'w-4 h-4 text-amber-400 dark:text-amber-600',
    body: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
  },
  error: {
    cls: 'w-4 h-4 text-rose-400 dark:text-rose-600',
    body: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'
  },
  success: {
    cls: 'w-4 h-4 text-emerald-400 dark:text-emerald-600',
    body: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'
  },
  save: {
    cls: 'w-4 h-4 text-emerald-400 dark:text-emerald-600',
    body: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>'
  },
  trash: {
    cls: 'w-4 h-4 text-rose-400 dark:text-rose-600',
    body: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
  },
  search: {
    cls: 'w-4 h-4',
    body: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'
  },
  sparkles: {
    cls: 'w-4 h-4 text-indigo-400 dark:text-indigo-600',
    body: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'
  },
  eraser: {
    cls: 'w-4 h-4',
    body: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'
  },
  pen: {
    cls: 'w-4 h-4',
    body: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>'
  },
  highlighter: {
    cls: 'w-4 h-4',
    body: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'
  },
  hand: {
    cls: 'w-4 h-4',
    body: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'
  },
  scissors: {
    cls: 'w-4 h-4',
    body: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>'
  },
  palette: {
    cls: 'w-4 h-4',
    body: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>'
  },
  ruler: {
    cls: 'w-4 h-4',
    body: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>'
  },
  wave: {
    cls: 'w-4 h-4',
    body: '<path d="M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 4-3 5-1"/>'
  },
  copy: {
    cls: 'w-4 h-4',
    body: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'
  },
  duplicate: {
    cls: 'w-4 h-4',
    body: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/><path d="M15 12v6"/><path d="M12 15h6"/>'
  },
  circle: {
    cls: 'w-4 h-4',
    body: '<circle cx="12" cy="12" r="9"/>'
  },
  square: {
    cls: 'w-4 h-4',
    body: '<rect width="16" height="16" x="4" y="4" rx="2"/>'
  },
  triangle: {
    cls: 'w-4 h-4',
    body: '<path d="m12 4 9 16H3Z"/>'
  },
  arrowRight: {
    cls: 'w-4 h-4',
    body: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'
  },
  ban: {
    cls: 'w-4 h-4 text-slate-400 dark:text-slate-500',
    body: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'
  },
  plus: {
    cls: 'w-4 h-4',
    body: '<path d="M5 12h14"/><path d="M12 5v14"/>'
  },
  moveH: {
    cls: 'w-4 h-4',
    body: '<path d="M18 8 22 12 18 16"/><path d="M6 8 2 12 6 16"/><line x1="2" x2="22" y1="12" y2="12"/>'
  },
  lock: {
    cls: 'w-4 h-4 text-amber-400 dark:text-amber-600',
    body: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
  },
  eye: {
    cls: 'w-4 h-4',
    body: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'
  },
  reset: {
    cls: 'w-4 h-4',
    body: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'
  },
  starFilled: {
    cls: 'w-4 h-4 text-amber-400 dark:text-amber-500',
    body: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/>'
  },
  starOutline: {
    cls: 'w-4 h-4',
    body: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
  },
  folder: {
    cls: 'w-4 h-4',
    body: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
  },
  undo: {
    cls: 'w-4 h-4',
    body: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>'
  },
  user: {
    cls: 'w-4 h-4',
    body: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>'
  },
  users: {
    cls: 'w-4 h-4',
    body: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
  },
  file: {
    cls: 'w-4 h-4',
    body: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'
  },
  book: {
    cls: 'w-4 h-4',
    body: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>'
  },
  settings: {
    cls: 'w-4 h-4',
    body: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'
  },
  maximize: {
    cls: 'w-4 h-4',
    body: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'
  },
  bell: {
    cls: 'w-4 h-4',
    body: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'
  },
  bellOff: {
    cls: 'w-4 h-4',
    body: '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>'
  },
  inbox: {
    cls: 'w-4 h-4',
    body: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
  },
  send: {
    cls: 'w-4 h-4',
    body: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>'
  },
  link: {
    cls: 'w-4 h-4',
    body: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
  },
  cloud: {
    cls: 'w-4 h-4 text-sky-400 dark:text-sky-600',
    body: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'
  },
  arrowUp: {
    cls: 'w-4 h-4',
    body: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'
  },
  checkCircle: {
    cls: 'w-4 h-4',
    body: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'
  }
};

const TOKEN_TO_SPEC = {
  info: 'info',
  'ℹ️': 'info',
  warning: 'warning',
  '⚠️': 'warning',
  error: 'error',
  '❌': 'error',
  success: 'success',
  '✅': 'success',
  save: 'save',
  '💾': 'save',
  trash: 'trash',
  '🗑️': 'trash',
  search: 'search',
  '🔍': 'search',
  sparkles: 'sparkles',
  '✨': 'sparkles',
  eraser: 'eraser',
  '🧹': 'eraser',
  pen: 'pen',
  '✏️': 'pen',
  highlighter: 'highlighter',
  '🖍️': 'highlighter',
  hand: 'hand',
  '🖐️': 'hand',
  scissors: 'scissors',
  '✂️': 'scissors',
  palette: 'palette',
  '🎨': 'palette',
  ruler: 'ruler',
  '📏': 'ruler',
  wave: 'wave',
  '〰️': 'wave',
  copy: 'copy',
  '📋': 'copy',
  duplicate: 'duplicate',
  '⧉': 'duplicate',
  circle: 'circle',
  '⭕': 'circle',
  square: 'square',
  '⬛': 'square',
  '◻️': 'square',
  triangle: 'triangle',
  '🔺': 'triangle',
  'arrow-right': 'arrowRight',
  '➡️': 'arrowRight',
  ban: 'ban',
  '🚫': 'ban',
  plus: 'plus',
  '➕': 'plus',
  'move-h': 'moveH',
  '↔️': 'moveH',
  lock: 'lock',
  '🔒': 'lock',
  eye: 'eye',
  '👁️': 'eye',
  reset: 'reset',
  '↺': 'reset',
  star: 'starFilled',
  '⭐': 'starFilled',
  'star-outline': 'starOutline',
  '☆': 'starOutline',
  folder: 'folder',
  '🗂️': 'folder',
  undo: 'undo',
  '↩️': 'undo',
  user: 'user',
  '👋': 'user',
  users: 'users',
  '🤝': 'users',
  file: 'file',
  '📄': 'file',
  book: 'book',
  '📖': 'book',
  '📓': 'book',
  settings: 'settings',
  '⚙️': 'settings',
  maximize: 'maximize',
  '⛶': 'maximize',
  bell: 'bell',
  '🔔': 'bell',
  'bell-off': 'bellOff',
  '🔕': 'bellOff',
  inbox: 'inbox',
  '📥': 'inbox',
  send: 'send',
  '📤': 'send',
  link: 'link',
  '🔗': 'link',
  cloud: 'cloud',
  '☁️': 'cloud',
  'arrow-up': 'arrowUp',
  '⬆️': 'arrowUp',
  'check-circle': 'checkCircle'
};

function _escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Converte un token icona (nome semantico, emoji legacy o simbolo matematico/greco)
 * in HTML pulito basato su SVG monocromatici da 1.75px (o glifo tipografico per simboli/greco).
 *
 * @param {string} [icon='info']
 * @returns {string}
 */
export function resolveToastIconHtml(icon = 'info') {
  const key = typeof icon === 'string' ? icon.trim() : '';
  const specName = TOKEN_TO_SPEC[key] || (SVG_SPECS[key] ? key : null);
  if (specName && SVG_SPECS[specName]) {
    const spec = SVG_SPECS[specName];
    return _svg(spec.body, spec.cls);
  }

  // Preserva glifi matematici / lettere greche (es. ∑, Σ, α, ⇒, ∈, ∞) in badge tipografico pulito
  if (key && key.length <= 4 && !/[\u{1F300}-\u{1FAFF}]/u.test(key)) {
    return `<span class="inline-flex items-center justify-center w-4 h-4 text-[13px] font-bold leading-none text-indigo-400 dark:text-indigo-600" aria-hidden="true">${_escapeHtml(key)}</span>`;
  }

  const fallback = SVG_SPECS.info;
  return _svg(fallback.body, fallback.cls);
}

/**
 * Restituisce un'icona SVG 40×40 (tratto 1.75px) per gli stati vuoti o di errore della libreria.
 *
 * @param {'notebook'|'folder'|'search'|'star'|'warning'} [kind='notebook']
 * @returns {string}
 */
export function getEmptyStateIconSvg(kind = 'notebook') {
  const map = {
    search: SVG_SPECS.search.body,
    star: SVG_SPECS.starOutline.body,
    folder: SVG_SPECS.folder.body,
    warning: SVG_SPECS.warning.body,
    notebook: SVG_SPECS.book.body
  };
  const body = map[kind] || map.notebook;
  return _svg(body, 'w-11 h-11 text-slate-400 dark:text-slate-500');
}

/**
 * Restituisce l'icona SVG per l'indicatore pull-to-add-page.
 *
 * @param {boolean} isReady
 * @returns {string}
 */
export function getPullIndicatorIconSvg(isReady) {
  const spec = isReady ? SVG_SPECS.checkCircle : SVG_SPECS.arrowUp;
  return _svg(spec.body, 'w-4 h-4');
}
