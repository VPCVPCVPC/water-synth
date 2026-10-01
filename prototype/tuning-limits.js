// tuning-limits.js — what the page lets you choose, kept out of the DOM code
// so check-tuning.mjs can prove every reachable setting gives playable stones
// (audible, below 0.45 × 44.1 kHz, at most 128).

export const RANGE_LOW = 24; // C1
export const RANGE_HIGH = 108; // C8
export const REF_MIN_HZ = 400; // A4 in Hz; the tuning core itself takes any frequency
export const REF_MAX_HZ = 480;
