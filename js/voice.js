import { db } from './db.js';

export const MAX_VOICE_MS = 5 * 60 * 1000;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];

// 32 kbit/s keeps a full 5-minute note around 1.2 MB.
export class VoiceRecorder extends EventTarget {
  #rec = null;
  #stream = null;
  #chunks = [];
  #timer = null;
  #done = null;
  startedAt = 0;

  get recording() { return this.#rec?.state === 'recording'; }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Este navegador no puede grabar audio');
    this.#stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported?.(m));
    this.#rec = new MediaRecorder(this.#stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
    this.#chunks = [];
    this.#rec.ondataavailable = (e) => { if (e.data.size) this.#chunks.push(e.data); };
    this.#done = new Promise((resolve) => { this.#rec.onstop = () => resolve(); });
    this.#rec.start(1000);
    this.startedAt = Date.now();
    this.#timer = setTimeout(() => this.dispatchEvent(new Event('limit')), MAX_VOICE_MS);
  }

  async stop() {
    if (!this.#rec) return null;
    clearTimeout(this.#timer);
    if (this.#rec.state !== 'inactive') this.#rec.stop();
    await this.#done;
    const duration = Math.min(MAX_VOICE_MS, Date.now() - this.startedAt);
    const blob = new Blob(this.#chunks, { type: this.#rec.mimeType || 'audio/webm' });
    this.#release();
    return { blob, duration };
  }

  cancel() {
    clearTimeout(this.#timer);
    if (this.#rec && this.#rec.state !== 'inactive') this.#rec.stop();
    this.#release();
  }

  #release() {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#rec = null;
  }
}

export async function saveVoice({ walkId, blob, duration, lat = null, lon = null }) {
  const note = { id: crypto.randomUUID(), walkId, blob, duration, t: Date.now(), lat, lon };
  await db.put('voice', note);
  return note;
}

export const voicesOf = (walkId) => db.byIndex('voice', 'walkId', walkId).then((v) => v.sort((a, b) => a.t - b.t));
export const deleteVoice = (id) => db.delete('voice', id);
export const deleteVoicesOf = (walkId) => db.deleteByIndex('voice', 'walkId', walkId);
