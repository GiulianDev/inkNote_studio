// ============================================================
// TOOLBAR E TEMA
// ============================================================

function setTool(toolName) {
    appState.activeTool = toolName;
    clearSelection();
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.remove('bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
    });
    const activeBtn = document.getElementById(`btnTool-${toolName}`);
    if (activeBtn) activeBtn.classList.add('bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
}

function selectColor(colorHex, element) {
    appState.currentColor = colorHex;
    document.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('ring-2', 'ring-indigo-500', 'scale-105'));
    if (element && element.classList.contains('color-swatch')) element.classList.add('ring-2', 'ring-indigo-500', 'scale-105');
    if (appState.activeTool === 'eraser' || appState.activeTool === 'lasso') setTool('pen');
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
    appState.pages.forEach(p => redrawPageCanvas(p));
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