// ============================================================
// IMPOSTAZIONI UTENTE (tema, stampa, mano dominante)
// ============================================================

const DEFAULT_SETTINGS = {
    theme: 'auto',          // 'auto' | 'light' | 'dark'
    printTheme: 'light',    // 'light' | 'dark'
    handedness: 'right'     // 'right' | 'left'
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
    setDarkMode(shouldBeDark);

    // 2. Mano dominante → specchia header/subbar
    document.body.classList.toggle('handed-left', settings.handedness === 'left');
}

function initSettings() {
    applySettings(loadSettings());

    // Se tema = auto, reagisci ai cambi di sistema
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            const s = loadSettings();
            if (s.theme === 'auto') setDarkMode(e.matches);
        });
    }
}

function openSettingsModal() {
    const s = loadSettings();
    document.getElementById('settingTheme').value = s.theme;
    document.getElementById('settingPrintTheme').value = s.printTheme;
    document.getElementById('settingHandedness').value = s.handedness;
    const modal = document.getElementById('settingsModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function confirmSettings() {
    const settings = {
        theme: document.getElementById('settingTheme').value,
        printTheme: document.getElementById('settingPrintTheme').value,
        handedness: document.getElementById('settingHandedness').value
    };
    saveSettings(settings);
    applySettings(settings);
    closeSettingsModal();
    showToast('Impostazioni salvate', '⚙️');
}