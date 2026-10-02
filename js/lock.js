import { $, store } from './ui.js';

export const LOCK_COLORS = {
  white: { label: 'Blanco', value: '#f2f2f2' },
  grey: { label: 'Gris', value: '#9e9e9e' },
  red: { label: 'Rojo', value: '#ff4d4d' },
  green: { label: 'Verde', value: '#5fd37a' },
  blue: { label: 'Azul', value: '#5aa9ff' },
};

const TURNS_TO_UNLOCK = 3;
const MIN_RADIUS = 28;
const TOLERANCE = 0.9;
const PICKER_HIDE_MS = 30000;

// Unlock gesture: three continuous counter-clockwise circles. The angle is measured around the
// running centroid of the stroke, which converges on the circle centre after the first turn.
export class LockScreen extends EventTarget {
  locked = false;
  #pts = null;
  #sumX = 0;
  #sumY = 0;
  #angle = 0;
  #prev = null;
  #pickerTimer = null;

  constructor() {
    super();
    const el = $('#lockscreen');
    el.addEventListener('pointerdown', (e) => this.#start(e));
    el.addEventListener('pointermove', (e) => this.#move(e));
    el.addEventListener('pointerup', () => this.#reset());
    el.addEventListener('pointercancel', () => this.#reset());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    const swatches = $('#lock-colors');
    swatches.innerHTML = Object.entries(LOCK_COLORS)
      .map(([id, c]) => `<button type="button" data-color="${id}" title="${c.label}" aria-label="Color ${c.label.toLowerCase()}" style="background:${c.value}"></button>`)
      .join('');
    // Taps on the swatches must not start an unlock stroke.
    swatches.addEventListener('pointerdown', (e) => e.stopPropagation());
    swatches.addEventListener('click', (e) => {
      const id = e.target.closest('[data-color]')?.dataset.color;
      if (id) {
        this.setColor(id);
        this.#schedulePickerHide();
      }
    });
    this.setColor(store.get('lockColor') ?? 'red');
  }

  // The picker shows on every lock and hides 30 s after the last choice (or after locking).
  #schedulePickerHide() {
    clearTimeout(this.#pickerTimer);
    this.#pickerTimer = setTimeout(() => { $('#lock-colors').hidden = true; }, PICKER_HIDE_MS);
  }

  setColor(id) {
    const c = LOCK_COLORS[id] ?? LOCK_COLORS.red;
    $('#lockscreen').style.setProperty('--lock-fg', c.value);
    document.querySelectorAll('#lock-colors [data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === id));
    store.set('lockColor', id);
  }

  lock() {
    this.locked = true;
    $('#lockscreen').hidden = false;
    $('#lock-colors').hidden = false;
    this.#schedulePickerHide();
    this.#reset();
    this.dispatchEvent(new Event('lock'));
  }

  unlock() {
    this.locked = false;
    clearTimeout(this.#pickerTimer);
    $('#lockscreen').hidden = true;
    this.#reset();
    this.dispatchEvent(new Event('unlock'));
  }

  #start(e) {
    e.preventDefault();
    $('#lockscreen').setPointerCapture?.(e.pointerId);
    this.#pts = 0;
    this.#sumX = 0;
    this.#sumY = 0;
    this.#angle = 0;
    this.#prev = null;
    this.#add(e.clientX, e.clientY);
  }

  #move(e) {
    if (this.#pts == null) return;
    this.#add(e.clientX, e.clientY);
  }

  #add(x, y) {
    this.#pts++;
    this.#sumX += x;
    this.#sumY += y;
    const cx = this.#sumX / this.#pts;
    const cy = this.#sumY / this.#pts;
    const dx = x - cx;
    const dy = y - cy;
    if (Math.hypot(dx, dy) < MIN_RADIUS) return;
    // Screen y grows downwards; flipping it makes counter-clockwise on screen a positive angle.
    const a = Math.atan2(-dy, dx);
    if (this.#prev != null) {
      let d = a - this.#prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      this.#angle += d;
    }
    this.#prev = a;
    const turns = Math.max(0, this.#angle / (2 * Math.PI));
    this.#progress(turns);
    if (turns >= TURNS_TO_UNLOCK * TOLERANCE) this.unlock();
  }

  #reset() {
    this.#pts = null;
    this.#progress(0);
  }

  #progress(turns) {
    const done = Math.min(TURNS_TO_UNLOCK, Math.floor(turns + 0.1));
    document.querySelectorAll('#lock-progress i').forEach((dot, i) => dot.classList.toggle('on', i < done));
  }
}
