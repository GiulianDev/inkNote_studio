/**
 * Dialog di progresso modale. Riusato per export e import.
 */
export function showProgressDialog(title = 'Elaborazione...') {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-sm w-full shadow-2xl border border-slate-200 dark:border-slate-800 p-6">
      <h3 class="text-sm font-bold text-slate-900 dark:text-white mb-3">${title}</h3>
      <div class="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
        <div class="h-full bg-indigo-600 transition-all duration-150" style="width: 0%" id="progressBar"></div>
      </div>
      <p class="text-xs text-slate-500 mt-2" id="progressLabel">Preparazione...</p>
    </div>
  `;
  document.body.appendChild(overlay);

  const bar = overlay.querySelector('#progressBar');
  const label = overlay.querySelector('#progressLabel');

  return {
    update({ done, total, label: text }) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      bar.style.width = `${pct}%`;
      label.innerText = text ? `${text} — ${done}/${total}` : `${done}/${total}`;
    },
    close() {
      try { document.body.removeChild(overlay); } catch (e) {}
    }
  };
}