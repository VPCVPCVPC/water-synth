// smf.js — the mocopi app's UDP stream ("mocopi (UDP)", Sony Motion Format).
//
// Every field is a chunk: a 4-byte little-endian length (of the value only),
// a 4-byte ASCII name, then the value, which for a parent holds its
// children's chunks. A packet is head + sndf + either skdf (the skeleton:
// each bone's id, parent and rest transform — sent at the start and every
// few seconds) or fram (a frame: each bone's current transform).
//
//   head  ftyp "sony motion format", vrsn u8
//   sndf  ipad u64, rcvp u16
//   skdf  bons → bndt × 27 → bnid u16, pbid u16, tran 7 × f32
//   fram  fnum u32, time u32, btrs → btdt × 27 → bnid u16, tran 7 × f32
//
// tran is a rotation quaternion (x, y, z, w) then a position (x, y, z), both
// local to the bone's parent. Sources: Sony's mocopi TechSpec (bone names),
// the open-source mocopi_parser and mcp-receiver (layout) — unofficial, so
// parse() is forgiving: unknown chunks are skipped, a broken packet returns
// null, never throws.
//
// Runs in Node and the browser (DataView only).

export const BONES = 27;

// Read the chunks in bytes [start, end): name → value [offset, length]; a
// name seen more than once (bndt, btdt) collects into a list.
function chunks(view, start, end) {
  const out = new Map();
  let o = start;
  while (o + 8 <= end) {
    const len = view.getUint32(o, true);
    const name = String.fromCharCode(view.getUint8(o + 4), view.getUint8(o + 5), view.getUint8(o + 6), view.getUint8(o + 7));
    const at = o + 8;
    if (at + len > end) return null; // truncated
    const entry = { at, len };
    if (out.has(name)) {
      const prev = out.get(name);
      if (Array.isArray(prev)) prev.push(entry); else out.set(name, [prev, entry]);
    } else out.set(name, entry);
    o = at + len;
  }
  return out;
}
const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function tran(view, e) {
  if (!e || e.len < 28) return null;
  const t = new Float64Array(7);
  for (let i = 0; i < 7; i++) {
    t[i] = view.getFloat32(e.at + 4 * i, true);
    if (!Number.isFinite(t[i])) return null; // a bad value skips the bone, never poisons the body
  }
  return t; // rx, ry, rz, rw, px, py, pz
}

// Parse one UDP packet (ArrayBuffer, or a Uint8Array / Node Buffer).
// → { kind: 'skeleton', bones: [{ id, parent, tran }] }
//   { kind: 'frame', fnum, time, bones: [{ id, tran }] }
//   or null (not a packet we understand).
export function parse(packet) {
  const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = chunks(view, 0, bytes.byteLength);
  if (!top) return null;
  const sk = top.get('skdf'), fr = top.get('fram');
  if (sk && !Array.isArray(sk)) {
    const inner = chunks(view, sk.at, sk.at + sk.len);
    const bons = inner && inner.get('bons');
    if (!bons || Array.isArray(bons)) return null;
    const entries = chunks(view, bons.at, bons.at + bons.len);
    if (!entries) return null;
    const bones = [];
    for (const b of list(entries.get('bndt'))) {
      const f = chunks(view, b.at, b.at + b.len);
      const id = f && f.get('bnid'), parent = f && f.get('pbid'), t = tran(view, f && f.get('tran'));
      if (!id || !t || id.len < 2) continue;
      bones.push({ id: view.getUint16(id.at, true), parent: parent && parent.len >= 2 ? view.getUint16(parent.at, true) : -1, tran: t });
    }
    return bones.length ? { kind: 'skeleton', bones } : null;
  }
  if (fr && !Array.isArray(fr)) {
    const inner = chunks(view, fr.at, fr.at + fr.len);
    if (!inner) return null;
    const fnum = inner.get('fnum'), time = inner.get('time'), btrs = inner.get('btrs');
    if (!btrs || Array.isArray(btrs)) return null;
    const entries = chunks(view, btrs.at, btrs.at + btrs.len);
    if (!entries) return null;
    const bones = [];
    for (const b of list(entries.get('btdt'))) {
      const f = chunks(view, b.at, b.at + b.len);
      const id = f && f.get('bnid'), t = tran(view, f && f.get('tran'));
      if (!id || !t || id.len < 2) continue;
      bones.push({ id: view.getUint16(id.at, true), tran: t });
    }
    return bones.length ? {
      kind: 'frame',
      fnum: fnum && fnum.len >= 4 ? view.getUint32(fnum.at, true) : 0,
      time: time && time.len >= 4 ? view.getUint32(time.at, true) : 0,
      bones,
    } : null;
  }
  return null;
}

// ---- encoding (for the demo dancer and the checks; the app does this for real) ----

function chunk(name, value) {
  const out = new Uint8Array(8 + value.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, value.length, true);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(value, 8);
  return out;
}
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u16 = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const f32s = (t) => { const b = new Uint8Array(28); const v = new DataView(b.buffer); for (let i = 0; i < 7; i++) v.setFloat32(4 * i, t[i], true); return b; };
const header = () => join(
  chunk('head', join(chunk('ftyp', new TextEncoder().encode('sony motion format')), chunk('vrsn', Uint8Array.of(1)))),
  chunk('sndf', join(chunk('ipad', new Uint8Array(8)), chunk('rcvp', u16(12351)))),
);

// bones: [{ id, parent, tran }] → a skdf packet.
export function encodeSkeleton(bones) {
  const entries = bones.map((b) => chunk('bndt', join(
    chunk('bnid', u16(b.id)),
    chunk('pbid', u16(b.parent < 0 ? 0xffff : b.parent)),
    chunk('tran', f32s(b.tran)),
  )));
  return join(header(), chunk('skdf', chunk('bons', join(...entries))));
}

// { fnum, time, bones: [{ id, tran }] } → a fram packet.
export function encodeFrame({ fnum = 0, time = 0, bones }) {
  const entries = bones.map((b) => chunk('btdt', join(chunk('bnid', u16(b.id)), chunk('tran', f32s(b.tran)))));
  return join(header(), chunk('fram', join(chunk('fnum', u32(fnum)), chunk('time', u32(time)), chunk('btrs', join(...entries)))));
}
