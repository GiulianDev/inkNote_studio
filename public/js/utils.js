// ============================================================
// UTILITY PURE
// ============================================================

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hexToRgbA(hex, alpha) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function getEffectiveColor(color, forceDark = appState.isDarkMode) {
    if (!color) return '#000000';
    const isDarkColor = (color === '#000000' || color === '#0f172a' || color === '#090d16' || color === 'black');
    if (forceDark && isDarkColor) return '#FFFFFF';
    if (!forceDark && (color === '#FFFFFF' || color === '#ffffff')) return '#000000';
    return color;
}

function showStatusBadge(txt) {
    const el = document.getElementById('statusBadge');
    if (el) el.innerText = txt;
}

function showToast(msg, icon = 'ℹ️') {
    const toast = document.getElementById('toastNotification');
    if (!toast) return;
    const msgEl = document.getElementById('toastMessage');
    const iconEl = document.getElementById('toastIcon');
    if (msgEl) msgEl.innerText = msg;
    if (iconEl) iconEl.innerText = icon;

    toast.classList.remove('translate-y-2', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-2', 'opacity-0');
    }, 2500);
}