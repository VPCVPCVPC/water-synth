// camera.js — movement in front of the camera, for Animate's "steer by
// camera" (and, later, camera gestures). Everything stays on the device: the
// picture is shrunk to a tiny grey frame in this page and compared with the
// last one; nothing is recorded or sent anywhere.

import { motionFrom } from './animate.js';

const W = 32, H = 24; // the frames compared (enough to find where movement is)

export class CameraMotion {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.stream = null;
    this.starting = null;
    this.asks = 0;
    this.motion = { x: 0.5, y: 0.5, amount: 0 };
  }

  get on() { return Boolean(this.stream); }

  // Ask for the front camera. Resolves true when it's running, false if
  // stop() came while asking; throws (with the browser's reason) if the camera
  // isn't allowed or isn't there. A start after a stop asks afresh.
  async start() {
    if (this.stream) return true;
    if (this.starting) return this.starting;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('the camera needs the https link');
    const ask = ++this.asks;
    const run = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 160 }, height: { ideal: 120 } }, audio: false,
      });
      if (ask !== this.asks) { for (const t of stream.getTracks()) t.stop(); return false; } // stopped while asking
      this.stream = stream;
      this.video.srcObject = stream;
      this.video.play().catch(() => {}); // not awaited: it waits for the first frame
      this.prev = null;
      return true;
    })();
    this.starting = run;
    run.finally(() => { if (this.starting === run) this.starting = null; }).catch(() => {});
    return run;
  }

  stop() {
    this.asks++; // a start still waiting on permission is cancelled
    this.starting = null; // and the next start asks afresh
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.prev = null;
    this.motion = { x: 0.5, y: 0.5, amount: 0 };
  }

  // Look once (call each animation frame): where is the movement, how much?
  sample() {
    if (!this.stream || this.video.readyState < 2) return this.motion;
    this.ctx.drawImage(this.video, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data, cur = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) cur[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
    if (this.prev) {
      const m = motionFrom(this.prev, cur, W, H);
      // Smooth it a little: a flicker shouldn't yank the stones about.
      const k = 0.35;
      this.motion = m.amount > 0
        ? { x: this.motion.x + (m.x - this.motion.x) * k, y: this.motion.y + (m.y - this.motion.y) * k, amount: this.motion.amount + (m.amount - this.motion.amount) * k }
        : { ...this.motion, amount: this.motion.amount < 1e-3 ? 0 : this.motion.amount * (1 - k) };
    }
    this.prev = cur;
    return this.motion;
  }
}
