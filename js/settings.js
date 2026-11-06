// ============================================================
// IMPOSTAZIONI UTENTE
// ============================================================

const DEFAULT_SETTINGS = {
    theme: 'auto',
    printTheme: 'light',
    handedness: 'right',
    smoothing: 50,
    subbarVisible: true,
    compactMode: false
};

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
}

function applySettings(settings) {
    // 1. Tema visualizzazione
    let shouldBeDark = false;
    if (settings.theme === 'dark') {
        shouldBeDark = true;
    } else if (settings.theme === 'light') {
        shouldBeDark = false;
    } else {
        shouldBeDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    if (typeof setDarkMode === 'function') setDarkMode(shouldBeDark);

    // 2. Mano dominante
    document.body.classList.toggle('handed-left', settings.handedness === 'left');

    // 3. Smoothing
    const smoothingValue = typeof settings.smoothing === 'number' ? settings.smoothing : 50;
    appState.smoothing = smoothingValue / 100;
    const slider = document.getElementById('smoothingSlider');
    const label = document.getElementById('smoothingValue');
    if (slider) slider.value = smoothingValue;
    if (label) label.innerText = smoothingValue;

    // 4. Subbar
    subbarVisible = settings.subbarVisible !== false;
    const subbar = document.getElementById('subbar');
    if (subbar) subbar.classList.toggle('collapsed', !subbarVisible);

    // 5. Compact mode
    compactMode = !!settings.compactMode;
    document.body.classList.toggle('compact-mode', compactMode);
    const exitBtn = document.getElementById('compactExitBtn');
    if (exitBtn) exitBtn.classList.toggle('hidden', !compactMode);

    // 6. Pulsante expand subbar
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
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function confirmSettings() {
    const current = loadSettings();
    const elTheme = document.getElementById('settingTheme');
    const elPrint = document.getElementById('settingPrintTheme');
    const elHand = document.getElementById('settingHandedness');
    const settings = {
        theme: elTheme ? elTheme.value : current.theme,
        printTheme: elPrint ? elPrint.value : current.printTheme,
        handedness: elHand ? elHand.value : current.handedness,
        smoothing: current.smoothing,
        subbarVisible: current.subbarVisible,
        compactMode: current.compactMode
    };
    saveSettings(settings);
    applySettings(settings);
    closeSettingsModal();
    showToast('Impostazioni salvate', '⚙️');
}