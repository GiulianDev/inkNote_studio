// ============================================================
// COSTANTI, HELPER PURI, EVENT BUS, NOTIFICHE UI
// ============================================================

import { openModalOverlay } from '../components/modal.js';

export const PAGE_WIDTH  = 794;
export const PAGE_HEIGHT = 1123;
export const PULL_THRESHOLD = 80;
export const SHAPE_CAPABLE_TOOLS = ['pen', 'pencil', 'marker'];

export function generatePageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'pg_' + crypto.randomUUID();
  }
  return 'pg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function hexToRgbA(hex, alpha) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const num = parseInt(c, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function parseHexRgb(hex) {
  if (typeof hex !== 'string') return null;
  let c = hex.trim().replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(c)) return null;
  const num = parseInt(c, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

export function isDarkColorHex(hex) {
  const rgb = parseHexRgb(hex);
  if (!rgb) return false;
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) < 128;
}

export function isPaperDark(themeDark, paperColor = null) {
  if (paperColor) {
    const rgb = parseHexRgb(paperColor);
    if (rgb) return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) < 128;
  }
  return !!themeDark;
}

export function getEffectiveColor(color, forceDark) {
  if (!color) return '#000000';
  const isDarkColor = (color === '#000000' || color === '#0f172a' || color === '#090d16' || color === 'black');
  if (forceDark && isDarkColor) return '#FFFFFF';
  if (!forceDark && (color === '#FFFFFF' || color === '#ffffff')) return '#000000';
  return color;
}

const _baseSizeCache = { raw: -1, size: 0 };
export function sliderToBaseSize(rawSliderValue) {
  const v = Math.max(1, Math.min(25, rawSliderValue || 3));
  if (_baseSizeCache.raw === v) return _baseSizeCache.size;
  let mapped;
  if (v === 1) mapped = 1;
  else if (v === 2) mapped = 1.5;
  else if (v === 3) mapped = 2;
  else mapped = v;
  const s = 0.5 * Math.pow(mapped, 0.75);
  _baseSizeCache.raw = v;
  _baseSizeCache.size = s;
  return s;
}

export function fastHypot(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

// --- Event bus (solo per broadcast UI, mai sul hot path) ---
const _bus = new EventTarget();
export const emit = (name, detail) => _bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on   = (name, fn)     => _bus.addEventListener(name, e => fn(e.detail));

// --- Notifiche UI ---
export function showToast(msg, icon = 'ℹ️', durationMs = 2800) {
  const toast = document.getElementById('toastNotification');
  if (!toast) return;
  const msgEl  = document.getElementById('toastMessage');
  const iconEl = document.getElementById('toastIcon');
  if (msgEl)  msgEl.innerText  = msg;
  if (iconEl) iconEl.innerText = icon;
  toast.classList.remove('translate-y-2', 'opacity-0');
  toast.classList.add('translate-y-0', 'opacity-100');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove('translate-y-0', 'opacity-100');
    toast.classList.add('translate-y-2', 'opacity-0');
  }, durationMs);
}

export function showStatusBadge(txt) {
  const el = document.getElementById('statusBadge');
  if (el) el.innerText = txt;
}

export function showConfirmDialog({
  title = 'Conferma',
  message = '',
  confirmText = 'Conferma',
  cancelText = 'Annulla',
  danger = false,
  checkbox = null
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const confirmClasses = danger
      ? 'bg-rose-600 hover:bg-rose-700 text-white'
      : 'bg-indigo-600 hover:bg-indigo-700 text-white';

    const hasCheckbox = !!(checkbox && typeof checkbox === 'object' && checkbox.label);
    const initialChecked = hasCheckbox ? !!checkbox.checked : false;
    const initialMessage = (hasCheckbox && initialChecked && checkbox.checkedMessage)
      ? checkbox.checkedMessage
      : message;
    const initialConfirmText = (hasCheckbox && initialChecked && checkbox.checkedConfirmText)
      ? checkbox.checkedConfirmText
      : confirmText;

    overlay.innerHTML = `
      <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-sm w-full shadow-2xl border border-slate-200 dark:border-slate-800 p-5">
        <h3 class="text-sm font-bold text-slate-900 dark:text-white">${escapeHtml(title)}</h3>
        ${initialMessage ? `<p data-confirm-message class="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">${escapeHtml(initialMessage)}</p>` : ''}
        ${hasCheckbox ? `
          <label style="touch-action: manipulation;"
            class="mt-3.5 flex items-start gap-2.5 p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 cursor-pointer select-none">
            <input type="checkbox" data-confirm-checkbox ${initialChecked ? 'checked' : ''}
              style="touch-action: manipulation;"
              class="mt-0.5 w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus:ring-indigo-500 cursor-pointer shrink-0">
            <span class="text-xs font-medium text-slate-700 dark:text-slate-200 leading-snug">${escapeHtml(checkbox.label)}</span>
          </label>
        ` : ''}
        <div class="flex items-center justify-end gap-2 mt-5">
          <button type="button" data-confirm-cancel style="touch-action: manipulation;"
            class="px-3.5 py-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold text-xs transition cursor-pointer">
            ${escapeHtml(cancelText)}
          </button>
          <button type="button" data-confirm-ok style="touch-action: manipulation;"
            class="px-3.5 py-2 rounded-xl font-semibold text-xs shadow-sm transition cursor-pointer ${confirmClasses}">
            ${escapeHtml(initialConfirmText)}
          </button>
        </div>
      </div>
    `;

    const msgEl = overlay.querySelector('[data-confirm-message]');
    const okBtn = overlay.querySelector('[data-confirm-ok]');
    const checkboxEl = overlay.querySelector('[data-confirm-checkbox]');

    if (hasCheckbox && checkboxEl) {
      checkboxEl.addEventListener('change', () => {
        const isChecked = !!checkboxEl.checked;
        if (msgEl) {
          msgEl.textContent = (isChecked && checkbox.checkedMessage) ? checkbox.checkedMessage : message;
        }
        if (okBtn) {
          okBtn.textContent = (isChecked && checkbox.checkedConfirmText) ? checkbox.checkedConfirmText : confirmText;
        }
      });
    }

    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      const checked = !!(checkboxEl && checkboxEl.checked);
      resolve(hasCheckbox ? { confirmed, checked } : confirmed);
    };

    const modalCtrl = openModalOverlay(overlay, {
      id: 'confirmDialog',
      ariaLabel: title,
      onClose: () => finish(false)
    });

    const close = (confirmed) => {
      finish(confirmed);
      modalCtrl.close(confirmed ? 'confirm' : 'cancel');
    };

    overlay.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => close(false));
    okBtn?.addEventListener('click', () => close(true));
  });
}