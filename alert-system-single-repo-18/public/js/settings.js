import { DEFAULTS as ENGINE_DEFAULTS } from './engine.js';

export const DEFAULT_SETTINGS = {
  v: 1,
  backendUrl: '', apiKey: '',
  market: 'NIFTY', tf: 1, // minutes
  ...structuredClone(ENGINE_DEFAULTS),
  alerts: { sound: true, vibrate: true, notify: true, push: true, keepAwake: true, volume: 0.8 },
};

const KEY = 'idxalert.settings';
const merge = (a, b) => {
  const o = Array.isArray(a) ? [...a] : { ...a };
  for (const k of Object.keys(b || {})) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k];
  return o;
};
export function loadSettings() {
  try { return merge(DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return structuredClone(DEFAULT_SETTINGS); }
}
export function saveSettings(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
export function engineCfg(s) {
  const { rsi1, rsi2, dema, sync, sequenceTimeout, readyTimeout, restartOnNewExtreme, relaxedOrder } = s;
  return { rsi1, rsi2, dema, sync, sequenceTimeout, readyTimeout, restartOnNewExtreme, relaxedOrder };
}
