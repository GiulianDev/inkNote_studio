// ============================================================
// IMPOSTAZIONI UTENTE
// ============================================================

const DEFAULT_SETTINGS = {
    theme: 'auto',
    printTheme: 'light',
    handedness: 'right',
    smoothing: 50,
    subbarVisible: true,
    compactMode: false,
    pressureLight: 10,
    pressureHeavy: 340,
    pressureCurve: 60
};

let _pressureParamsCache = null;

function loadSettings() {
    try {
        const saved = localStorage.getItem('inknote_settings');
        return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : { ...DEFAULT_SETTINGS };
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings(settings) {
    localStorage.setItem('inknote_settings', JSON.stringify(settings));
    _pressureParamsCache = null;
}

// Cache dei parametri di pressione. Invalidata a ogni saveSettings.
function getPressureParams() {
    if (_pressureParamsCache) return _pressureParamsCache;
    const s = loadSettings();
    _pressureParamsCache = {
        lightMul: (s.pressureLight / 100) * 0.5,
        heavyMul: s.pressureHeavy / 100,
        curve: 0.5 + (s.pressureCurve / 100) * 2.5
    };
    return _pressureParamsCache;
}

function applySettings(settings) {
    let shouldBeDark = false;
    if (settings.theme === 'dark') {
        shouldBeDark = true;
    } else if (settings.theme === 'light') {
        shouldBeDark = false;
    } else {
        shouldBeDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    if (typeof setDarkMode === 'function') setDarkMode(shouldBeDark);

    document.body.classList.toggle('handed-left', settings.handedness === 'left');

    const smoothingValue = typeof settings.smoothing === 'number' ? settings.smoothing : 50;
    appState.smoothing = smoothingValue / 100;
    const slider = document.getElementById('smoothingSlider');
    const label = document.getElementById('smoothingValue');
    if (slider) slider.value = smoothingValue;
    if (label) label.innerText = smoothingValue;

    subbarVisible = settings.subbarVisible !== false;
    const subbar = document.getElementById('subbar');
    if (subbar) subbar.classList.toggle('collapsed', !subbarVisible);

    compactMode = !!settings.compactMode;
    document.body.classList.toggle('compact-mode', compactMode);
    const exitBtn = document.getElementById('compactExitBtn');
    if (exitBtn) exitBtn.classList.toggle('hidden', !compactMode);

    updateSubbarExpandBtnVisibility();
}

function updateSubbarExpandBtnVisibility() {
    const expandBtn = document.getElementById('subbarExpandBtn');
    if (!expandBtn) return;
    const showExpand = !subbarVisible && !compactMode;
    expandBtn.classList.toggle('hidden', !showExpand);
}

function initSettings() {
    applySettings(loadSettings());

    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            const s = loadSettings();
            if (s.theme === 'auto' && typeof setDarkMode === 'function') setDarkMode(e.matches);
        });
    }
}

function openSettingsModal() {
    const s = loadSettings();
    const elTheme = document.getElementById('settingTheme');
    const elPrint = document.getElementById('settingPrintTheme');
    const elHand = document.getElementById('settingHandedness');
    if (elTheme) elTheme.value = s.theme;
    if (elPrint) elPrint.value = s.printTheme;
    if (elHand) elHand.value = s.handedness;

    // Inizializza gli slider di pressione con i valori correnti
    const lightSlider = document.getElementById('pressureLightSlider');
    const heavySlider = document.getElementById('pressureHeavySlider');
    const curveSlider = document.getElementById('pressureCurveSlider');
    if (lightSlider) lightSlider.value = s.pressureLight;
    if (heavySlider) heavySlider.value = s.pressureHeavy;
    if (curveSlider) curveSlider.value = s.pressureCurve;
    _updatePressureLabels();
    _bindPressureSliders();

    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // Ridisegna la canvas di test con i parametri correnti
    requestAnimationFrame(() => _redrawPressureTest());
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    // Annulla: ripristina i parametri di pressione precedenti
    _pressureParamsCache = null;
}

function confirmSettings() {
    const current = loadSettings();
    const elTheme = document.getElementById('settingTheme');
    const elPrint = document.getElementById('settingPrintTheme');
    const elHand = document.getElementById('settingHandedness');
    const lightSlider = document.getElementById('pressureLightSlider');
    const heavySlider = document.getElementById('pressureHeavySlider');
    const curveSlider = document.getElementById('pressureCurveSlider');

    const settings = {
        theme: elTheme ? elTheme.value : current.theme,
        printTheme: elPrint ? elPrint.value : current.printTheme,
        handedness: elHand ? elHand.value : current.handedness,
        smoothing: current.smoothing,
        subbarVisible: current.subbarVisible,
        compactMode: current.compactMode,
        pressureLight: lightSlider ? parseInt(lightSlider.value) : current.pressureLight,
        pressureHeavy: heavySlider ? parseInt(heavySlider.value) : current.pressureHeavy,
        pressureCurve: curveSlider ? parseInt(curveSlider.value) : current.pressureCurve
    };
    saveSettings(settings);
    applySettings(settings);
    closeSettingsModal();
    showToast('Impostazioni salvate', '⚙️');
}

// ============================================================
// CALIBRAZIONE PRESSIONE (UI + canvas di test)
// ============================================================

const _pressureTestState = {
    strokes: [],
    current: null,
    bound: false
};

function _updatePressureLabels() {
    const light = document.getElementById('pressureLightSlider');
    const heavy = document.getElementById('pressureHeavySlider');
    const curve = document.getElementById('pressureCurveSlider');
    const lightV = document.getElementById('pressureLightValue');
    const heavyV = document.getElementById('pressureHeavyValue');
    const curveV = document.getElementById('pressureCurveValue');
    if (light && lightV) lightV.innerText = light.value;
    if (heavy && heavyV) heavyV.innerText = heavy.value;
    if (curve && curveV) curveV.innerText = curve.value;
}

function _bindPressureSliders() {
    if (_pressureTestState.bound) return;
    _pressureTestState.bound = true;

    ['pressureLightSlider', 'pressureHeavySlider', 'pressureCurveSlider'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            // Applica live: salva temporaneamente, invalida cache, ridisegna
            const s = loadSettings();
            s.pressureLight = parseInt(document.getElementById('pressureLightSlider').value);
            s.pressureHeavy = parseInt(document.getElementById('pressureHeavySlider').value);
            s.pressureCurve = parseInt(document.getElementById('pressureCurveSlider').value);
            saveSettings(s);
            _updatePressureLabels();
            _redrawPressureTest();
        });
    });

    const canvas = document.getElementById('pressureTestCanvas');
    if (canvas) {
        canvas.addEventListener('pointerdown', _onPressureTestDown);
        canvas.addEventListener('pointermove', _onPressureTestMove);
        canvas.addEventListener('pointerup', _onPressureTestUp);
        canvas.addEventListener('pointercancel', _onPressureTestUp);
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
}

function _onPressureTestDown(e) {
    const canvas = document.getElementById('pressureTestCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const tool = (appState.activeTool === 'pen' || appState.activeTool === 'pencil')
        ? appState.activeTool
        : 'pen';
    const pt = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        pressure: Math.max(0.1, e.pressure || 0.5),
        tiltX: e.tiltX || 0,
        tiltY: e.tiltY || 0,
        speed: 0
    };
    _pressureTestState.current = {
        tool,
        size: appState.strokeWidth,
        points: [pt]
    };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    _redrawPressureTest();
}

function _onPressureTestMove(e) {
    if (!_pressureTestState.current) return;
    const canvas = document.getElementById('pressureTestCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const last = _pressureTestState.current.points[_pressureTestState.current.points.length - 1];
    const pt = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        pressure: Math.max(0.1, e.pressure || 0.5),
        tiltX: e.tiltX || 0,
        tiltY: e.tiltY || 0,
        speed: Math.hypot(e.clientX - rect.left - last.x, e.clientY - rect.top - last.y)
    };
    _pressureTestState.current.points.push(pt);
    _redrawPressureTest();
}

function _onPressureTestUp(e) {
    if (_pressureTestState.current && _pressureTestState.current.points.length > 1) {
        _pressureTestState.strokes.push(_pressureTestState.current);
    }
    _pressureTestState.current = null;
    const canvas = document.getElementById('pressureTestCanvas');
    if (canvas) { try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} }
    _redrawPressureTest();
}

function _redrawPressureTest() {
    const canvas = document.getElementById('pressureTestCanvas');
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Sfondo
    const isDark = document.body.classList.contains('dark');
    ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);

    const allStrokes = _pressureTestState.current
        ? [..._pressureTestState.strokes, _pressureTestState.current]
        : _pressureTestState.strokes;

    allStrokes.forEach(stroke => {
        const pts = stroke.points;
        if (pts.length < 2) return;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = isDark ? '#f8fafc' : '#0f172a';

        for (let i = 1; i < pts.length; i++) {
            const p1 = pts[i - 1];
            const p2 = pts[i];
            const tiltNorm = Math.min(1, Math.hypot(p2.tiltX, p2.tiltY) / 30);
            const speedNorm = Math.min(1, p2.speed / 8);
            const w = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure, tiltNorm, speedNorm, 1.0);
            ctx.lineWidth = Math.max(0.3, w);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }
        ctx.restore();
    });

    // Hint se vuota
    if (allStrokes.length === 0) {
        ctx.fillStyle = isDark ? '#475569' : '#94a3b8';
        ctx.font = '12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Disegna qui con la penna per calibrare', cssW / 2, cssH / 2);
    }
}

function resetPressureDefaults() {
    const s = loadSettings();
    s.pressureLight = DEFAULT_SETTINGS.pressureLight;
    s.pressureHeavy = DEFAULT_SETTINGS.pressureHeavy;
    s.pressureCurve = DEFAULT_SETTINGS.pressureCurve;
    saveSettings(s);
    const light = document.getElementById('pressureLightSlider');
    const heavy = document.getElementById('pressureHeavySlider');
    const curve = document.getElementById('pressureCurveSlider');
    if (light) light.value = s.pressureLight;
    if (heavy) heavy.value = s.pressureHeavy;
    if (curve) curve.value = s.pressureCurve;
    _updatePressureLabels();
    _redrawPressureTest();
    showToast('Valori di pressione ripristinati', '↩️');
}

function clearPressureTest() {
    _pressureTestState.strokes = [];
    _pressureTestState.current = null;
    _redrawPressureTest();
}