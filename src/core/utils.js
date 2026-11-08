// ============================================================
// COSTANTI, HELPER PURI, EVENT BUS, NOTIFICHE UI
// ============================================================

export const PAGE_WIDTH  = 794;
export const PAGE_HEIGHT = 1123;
export const PULL_THRESHOLD = 80;
export const SHAPE_CAPABLE_TOOLS = ['pen', 'pencil', 'marker'];

export function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  // Mappatura: più granularità nella parte bassa dello slider.
  //   v=1 → size(1)    (invariato)
  //   v=2 → size(1.5)  (nuovo livello intermedio)
  //   v=3 → size(2)    (ex size del 2)
  //   v>=4 → size(v)   (invariato)
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

// --- Event bus (solo per broadcast UI, mai sul hot path) ---
const _bus = new EventTarget();
export const emit = (name, detail) => _bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on   = (name, fn)     => _bus.addEventListener(name, e => fn(e.detail));

// --- Notifiche UI ---
export function showToast(msg, icon = 'ℹ️') {
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
  }, 2500);
}

export function showStatusBadge(txt) {
  const el = document.getElementById('statusBadge');
  if (el) el.innerText = txt;
}