// camera.js — movement in front of the camera, for camera ripples
// (motion.js) and Animate's "steer by camera". Everything stays on the device: the
// picture is shrunk to a tiny grey frame in this page and compared with the
// last one; nothing is recorded or sent anywhere.

import { motionFrom } from './animate.js';

// The frames compared (enough to find where movement is): 32 × 24, or
// 24 × 32 for a camera giving a portrait picture (a phone held upright), so
// neither direction is squashed.
const LONG = 32, SHORT = 24;

export class CameraMotion {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.w = LONG; this.h = SHORT;
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null; this.cur = null; this.spare = null;
    this.frameTime = -1; this.lastAt = 0; this.dt = 0; this.fresh = false;
    // Where the browser says when each new video frame arrives (and its
    // capture time), use that: exact freshness and timing.
    this.frames = 0; this.seenFrames = 0; this.mediaTime = 0; this.lastMediaTime = -1; this.frameCb = 0; this.startedAt = 0;
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
      this.startedAt = performance.now(); this.frames = 0; this.seenFrames = 0;
      this.watchFrames();
      this.prev = null; this.cur = null; this.frameTime = -1; this.lastAt = 0;
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
    if (this.frameCb && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frameCb);
    this.frameCb = 0;
    this.video.srcObject = null;
    this.prev = null; this.cur = null; this.frameTime = -1; this.lastAt = 0; this.fresh = false; this.lastMediaTime = -1;
    this.motion = { x: 0.5, y: 0.5, amount: 0 };
  }

  // Look once (call each animation frame): where is the movement, how much?
  // Only a new video frame is looked at (the screen redraws faster than the
  // camera delivers); `fresh` says whether this call saw one, and
  // `prev`/`cur` are the two latest grey frames (W × H) for motion.js.
  watchFrames() {
    if (!this.video.requestVideoFrameCallback) return;
    const cb = (now, meta) => {
      if (!this.stream) return;
      this.frames++;
      this.mediaTime = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : 0;
      this.frameCb = this.video.requestVideoFrameCallback(cb);
    };
    this.frameCb = this.video.requestVideoFrameCallback(cb);
  }

  sample() {
    this.fresh = false;
    if (!this.stream || this.video.readyState < 2) return this.motion;
    // A new frame? (The browser's frame callback where there is one, else the
    // video's clock.)
    // (If the frame callback hasn't fired a second in, the browser isn't
    // delivering it: go by the clock instead.)
    const byCallback = this.frameCb && (this.frames > 0 || performance.now() - this.startedAt < 1000);
    if (byCallback) {
      if (this.frames === this.seenFrames) return this.motion;
      this.seenFrames = this.frames;
    } else {
      const t = this.video.currentTime;
      if (t === this.frameTime) return this.motion;
      this.frameTime = t;
    }
    // The picture's shape: a portrait camera gets a portrait thumbnail.
    const portrait = this.video.videoHeight > this.video.videoWidth;
    const w = portrait ? SHORT : LONG, h = portrait ? LONG : SHORT;
    if (w !== this.w) {
      this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h;
      this.prev = null; this.cur = null; this.spare = null; // start comparing afresh
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
    const px = this.ctx.getImageData(0, 0, w, h).data;
    const cur = this.spare && this.spare.length === w * h ? this.spare : new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) cur[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
    // Time between frames: when they were captured, where the browser says.
    const now = performance.now();
    if (byCallback && this.mediaTime > 0 && this.lastMediaTime >= 0 && this.mediaTime > this.lastMediaTime) {
      this.dt = this.mediaTime - this.lastMediaTime;
    } else this.dt = this.lastAt ? (now - this.lastAt) / 1000 : 0;
    this.lastAt = now;
    this.lastMediaTime = this.mediaTime;
    if (this.cur) {
      const m = motionFrom(this.cur, cur, w, h);
      // Smooth it a little: a flicker shouldn't yank the stones about.
      const k = 0.35;
      this.motion = m.amount > 0
        ? { x: this.motion.x + (m.x - this.motion.x) * k, y: this.motion.y + (m.y - this.motion.y) * k, amount: this.motion.amount + (m.amount - this.motion.amount) * k }
        : { ...this.motion, amount: this.motion.amount < 1e-3 ? 0 : this.motion.amount * (1 - k) };
      this.fresh = true;
    }
    this.spare = this.prev; // the oldest frame's buffer is reused
    this.prev = this.cur;
    this.cur = cur;
    return this.motion;
  }
}
