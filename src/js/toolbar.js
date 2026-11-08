// ============================================================
// TOOLBAR E TEMA
// ============================================================

const RECENT_COLORS_MAX = 8;
const RECENT_COLORS_KEY = 'inknote_recent_colors';

function loadRecentColors() {
    try {
        const saved = localStorage.getItem(RECENT_COLORS_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch (e) {
        return [];
    }
}

function saveRecentColor(colorHex) {
    // Normalizza hex (lowercase)
    const color = colorHex.toLowerCase();
    let recent = loadRecentColors();
    // Rimuovi duplicato se presente
    recent = recent.filter(c => c !== color);
    // Aggiungi in testa
    recent.unshift(color);
    // Tronca
    if (recent.length > RECENT_COLORS_MAX) recent = recent.slice(0, RECENT_COLORS_MAX);
    try {
        localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(recent));
    } catch (e) {}
    renderRecentColors();
}

function renderRecentColors() {
    const container = document.getElementById('recentColorsContainer');
    if (!container) return;
    const recent = loadRecentColors();
    if (recent.length === 0) {
        container.classList.add('hidden');
        container.classList.remove('flex');
        return;
    }
    container.classList.remove('hidden');
    container.classList.add('flex');
    container.innerHTML = '';
    recent.forEach(color => {
        const btn = document.createElement('button');
        btn.className = 'w-4 h-4 rounded-full border border-white dark:border-slate-800 cursor-pointer transition hover:scale-110';
        btn.style.backgroundColor = color;
        btn.title = color;
        btn.addEventListener('click', () => {
            selectColor(color, btn);
        });
        container.appendChild(btn);
    });
}

function selectColor(colorHex, element) {
    appState.currentColor = colorHex;
    document.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('ring-2', 'ring-indigo-500', 'scale-105'));
    if (element && element.classList.contains('color-swatch')) element.classList.add('ring-2', 'ring-indigo-500', 'scale-105');
    if (appState.activeTool === 'eraser' || appState.activeTool === 'lasso') setTool('pen');
    // Salva come recente (solo se non è il nero di default? No, salva sempre)
    saveRecentColor(colorHex);
}

function updateStrokeWidth(val) {
    appState.strokeWidth = parseInt(val);
    const label = document.getElementById('strokeWidthValue');
    if (label) label.innerText = val;
}

function toggleAutoShape() {
    appState.autoShapeEnabled = !appState.autoShapeEnabled;
    updateAutoShapeButtonUI();
    showToast(
        appState.autoShapeEnabled ? 'Auto-Forme ATTIVE: le forme disegnate verranno raddrizzate' : 'Auto-Forme DISATTIVATE: disegno libero',
        appState.autoShapeEnabled ? '✨' : '✏️'
    );
}

function updateAutoShapeButtonUI() {
    const btn = document.getElementById('btnToggleAutoShape');
    if (!btn) return;
    const icon = document.getElementById('autoShapeIcon');
    const label = document.getElementById('autoShapeLabel');
    if (appState.autoShapeEnabled) {
        btn.classList.add('auto-shape-on');
        btn.classList.remove('auto-shape-off');
        if (icon) icon.innerText = '✨';
        if (label) label.innerText = 'Auto-Forme';
        btn.title = 'Auto-Forme ATTIVE: clicca per disattivare';
    } else {
        btn.classList.remove('auto-shape-on');
        btn.classList.add('auto-shape-off');
        if (icon) icon.innerText = '🚫';
        if (label) label.innerText = 'Auto-Forme OFF';
        btn.title = 'Auto-Forme DISATTIVATE: clicca per attivare';
    }
}

function toggleTheme() {
    const newDark = !appState.isDarkMode;
    setDarkMode(newDark);

    const s = loadSettings();
    s.theme = newDark ? 'dark' : 'light';
    saveSettings(s);
}

function setDarkMode(isDark) {
    appState.isDarkMode = isDark;
    document.body.classList.toggle('dark', isDark);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.innerText = isDark ? '☀️' : '🌙';
    // Ridisegna solo le pagine visibili. Le pagine fuori viewport vengono
    // ridisegnate automaticamente quando entrano nel viewport (via
    // refreshCanvasResolution al resize/pan).
    appState.pages.forEach(p => {
        if (isPageVisible(p)) {
            redrawPageCanvas(p);
        } else {
            // Marca la pagina come "da ridisegnare" quando diventa visibile
            p._wasVisible = false;
        }
    });
}

function updateSmoothing(val) {
    const intVal = parseInt(val);
    appState.smoothing = intVal / 100;
    const label = document.getElementById('smoothingValue');
    if (label) label.innerText = intVal;

    const s = loadSettings();
    s.smoothing = intVal;
    saveSettings(s);
}

function toggleSubbar() {
    subbarVisible = !subbarVisible;

    const subbar = document.getElementById('subbar');
    if (subbar) subbar.classList.toggle('collapsed', !subbarVisible);

    updateSubbarExpandBtnVisibility();

    const s = loadSettings();
    s.subbarVisible = subbarVisible;
    saveSettings(s);

    // Aspetta la fine dell'animazione prima di ricalcolare la viewport
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
    }, 320);
}

function toggleCompactMode() {
    compactMode = !compactMode;

    document.body.classList.toggle('compact-mode', compactMode);
    const exitBtn = document.getElementById('compactExitBtn');
    if (exitBtn) exitBtn.classList.toggle('hidden', !compactMode);

    updateSubbarExpandBtnVisibility();

    const s = loadSettings();
    s.compactMode = compactMode;
    saveSettings(s);

    showToast(
        compactMode ? 'Modalità compatta: solo dock disegno' : 'Modalità completa ripristinata',
        compactMode ? '🎯' : '↩️'
    );

    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        centerViewport();
    }, 50);
}