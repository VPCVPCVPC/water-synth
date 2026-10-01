// check-lib.mjs — measuring tools shared by the checks (FFT, spectrum, pitch).

export const cents = (a, b) => 1200 * Math.log2(a / b);

// In-place radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Magnitude spectrum, Hann-windowed and zero-padded to `size`.
export function spectrum(x, size) {
  const re = new Float64Array(size), im = new Float64Array(size);
  const len = Math.min(x.length, size);
  for (let i = 0; i < len; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

// Measure the pitch near `target`: the strongest peak within ±60 cents
// (parabolic interpolation on log magnitude). Fails loudly rather than
// misreporting if the peak sits at the window's edge, or if anything between
// 0.15× (or 20 Hz) and 0.9× the target comes within 20 dB of it (so the measured peak
// really is the lowest partial — an octave-low bell can't pass via its 2nd).
export function measurePitch(x, fs, target, size) {
  const mag = spectrum(x, size), bin = fs / size;
  const lo = Math.floor((target * Math.pow(2, -60 / 1200)) / bin), hi = Math.ceil((target * Math.pow(2, 60 / 1200)) / bin);
  let k = lo;
  for (let i = lo; i <= hi; i++) if (mag[i] > mag[k]) k = i;
  if (k <= lo || k >= hi) return { error: 'peak outside ±60¢ window' };
  let below = 0;
  for (let i = Math.max(1, Math.floor(Math.max(20, 0.15 * target) / bin)); i <= Math.ceil((0.9 * target) / bin); i++) below = Math.max(below, mag[i]);
  if (below > mag[k] * 0.1) {
    const db = 20 * Math.log10(below / mag[k]);
    return { error: db >= 0 ? `a peak below the target is ${db.toFixed(1)} dB louder than it` : `a peak below the target is only ${(-db).toFixed(1)} dB quieter` };
  }
  const a = Math.log(mag[k - 1]), b = Math.log(mag[k]), c = Math.log(mag[k + 1]);
  return { hz: (k + (0.5 * (a - c)) / (a - 2 * b + c)) * bin };
}
export const fftSize = (fs) => (fs > 100000 ? 1 << 20 : 1 << 19);
