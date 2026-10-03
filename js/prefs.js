import { store } from './ui.js';

// A display profile tunes the base map (CSS filter on its tiles, overlays untouched) and the track.
export const PRESETS = {
  original: { name: 'Original', sat: 1, bright: 1, contrast: 1, gray: 0, track: '#d6452f', width: 5, byGrade: true },
  soft: { name: 'Suave', sat: 0.45, bright: 1.08, contrast: 0.95, gray: 0, track: '#1565c0', width: 5, byGrade: false },
  grey: { name: 'Gris claro', sat: 1, bright: 1.12, contrast: 0.9, gray: 1, track: '#d6452f', width: 5, byGrade: true },
  contrast: { name: 'Contraste', sat: 0.6, bright: 0.92, contrast: 1.25, gray: 0, track: '#00b8d4', width: 6, byGrade: false },
};

export const TRACK_COLORS = [
  ['#d6452f', 'Rojo'], ['#1565c0', 'Azul'], ['#c2185b', 'Magenta'], ['#111111', 'Negro'], ['#ffd600', 'Amarillo'], ['#00b8d4', 'Cian'],
];

const customs = () => store.get('profiles') ?? {};

export function allProfiles() {
  return { ...Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, { ...p, preset: true }])), ...customs() };
}

export function activeId() {
  const id = store.get('profile') ?? 'original';
  return allProfiles()[id] ? id : 'original';
}

export const activeProfile = () => allProfiles()[activeId()];

export function setActive(id) { store.set('profile', id); }

// Editing a preset never changes it: the edit goes to a "Personalizado" profile instead.
export function editActive(change) {
  const id = activeId();
  const current = activeProfile();
  const list = customs();
  const targetId = current.preset ? 'custom' : id;
  list[targetId] = { ...current, ...change, preset: undefined, name: current.preset ? 'Personalizado' : current.name };
  store.set('profiles', list);
  setActive(targetId);
}

export function saveAs(name) {
  const list = customs();
  const id = `p${Date.now().toString(36)}`;
  list[id] = { ...activeProfile(), preset: undefined, name };
  store.set('profiles', list);
  setActive(id);
  return id;
}

export function remove(id) {
  const list = customs();
  delete list[id];
  store.set('profiles', list);
  if (activeId() === id || !allProfiles()[store.get('profile')]) setActive('original');
}

export const cssFilter = (p) => `saturate(${p.sat}) brightness(${p.bright}) contrast(${p.contrast}) grayscale(${p.gray})`;
