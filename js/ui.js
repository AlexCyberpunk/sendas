export const $ = (sel, root = document) => root.querySelector(sel);

export const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`sendas.${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`sendas.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

let toastTimer;
export function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function ask(dialog, values = {}) {
  const form = dialog.querySelector('form');
  form.reset();
  for (const [k, v] of Object.entries(values)) form.elements[k].value = v;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve({ action: dialog.returnValue, data: Object.fromEntries(new FormData(form)) }), { once: true });
  });
}

let audio;
export function alertUser(pattern = [300, 120, 300]) {
  navigator.vibrate?.(pattern);
  // iOS has no vibration API, so also beep.
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, t + i * 0.35);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.35 + 0.25);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.35);
      o.stop(t + i * 0.35 + 0.3);
    }
  } catch { /* audio unavailable */ }
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}

export function loadStyle(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}
