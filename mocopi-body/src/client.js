// client.js — the browser side: the bridge's stream → a body, and its features.
//
//   import { MocopiBody } from './mocopi-body/src/client.js';
//   const body = new MocopiBody({ url: 'http://localhost:12352' });
//   body.onframe = (b) => { b.features.energy; b.skeleton.world[...]; };
//   body.start();
//   // each animation frame: body.tick(); if (body.features.lost) …
//
// The bridge (bridge/bridge.mjs) passes each mocopi packet on as it came,
// stamped with when it arrived; this parses it with the same parser.

import { parse } from './smf.js';
import { Skeleton } from './skeleton.js';
import { BodyFeatures } from './features.js';

export class MocopiBody {
  constructor({ url = 'http://localhost:12352', features = {} } = {}) {
    this.url = url.replace(/\/$/, '');
    this.skeleton = new Skeleton();
    this.features = new BodyFeatures(features);
    this.onframe = null; // (this) => …, after each frame
    this.onstatus = null; // (text) => …
    this.source = null;
    this.clockOffset = null; // bridge time − page time (s)
    this.frames = 0;
  }

  start() {
    if (this.source) return;
    const es = new EventSource(`${this.url}/events`);
    this.source = es;
    es.onopen = () => this.say('connected to the bridge');
    es.onerror = () => {
      this.say('no bridge — is bridge.mjs running?');
      // The browser retries by itself, unless the answer wasn't a stream
      // at all: then it gives up, so start again in a moment.
      if (es.readyState === EventSource.CLOSED && this.source === es) {
        this.source = null;
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.start(), 2000);
      }
    };
    es.addEventListener('packet', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg.b !== 'string' || !Number.isFinite(msg.t)) return;
      let bytes;
      try { bytes = base64(msg.b); } catch { return; }
      this.receive(bytes, msg.t);
    });
  }

  stop() {
    clearTimeout(this.retry);
    if (this.source) this.source.close();
    this.source = null;
  }

  // One packet (bytes) that arrived at time t (seconds, the bridge's clock).
  receive(bytes, t) {
    const p = parse(bytes);
    if (!p) return;
    if (p.kind === 'skeleton') { this.skeleton.setSkeleton(p.bones); return; }
    this.skeleton.setFrame(p.bones);
    const now = performance.now() / 1000;
    // The bridge's clock against this page's: the least delayed packet
    // gives it (a late one would make "lost" late); a jump of over a
    // second means the bridge restarted.
    const off = t - now;
    if (this.clockOffset === null || Math.abs(off - this.clockOffset) > 1 || off > this.clockOffset) this.clockOffset = off;
    this.features.update(this.skeleton.world, t);
    this.frames++;
    if (this.onframe) this.onframe(this);
  }

  // Call often (each animation frame): marks the body lost when frames stop.
  tick() {
    if (this.clockOffset !== null) this.features.tick(performance.now() / 1000 + this.clockOffset);
    return this.features;
  }

  say(text) { if (this.onstatus) this.onstatus(text); }
}

function base64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
