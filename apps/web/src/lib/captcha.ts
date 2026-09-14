/** Ported from ZollTool.
 *
 * Client side of the proof-of-work CAPTCHA. Fetches a challenge from the server
 * and finds a solution whose SHA-256(nonce:i) starts with N zero bits. Uses a
 * synchronous SHA-256 (WebCrypto is async-only and far too slow for the loop)
 * that matches the server's node:crypto output byte-for-byte.
 */

const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

// Indexed typed-array maths, written before noUncheckedIndexedAccess; the loop bounds keep every read in range.
/* eslint-disable @typescript-eslint/no-non-null-assertion */
function sha256(msg: Uint8Array): Uint8Array {
  const H = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const l = msg.length;
  const bl = (((l + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(bl);
  bytes.set(msg);
  bytes[l] = 0x80;
  const bitLen = l * 8;
  bytes[bl - 4] = (bitLen >>> 24) & 255;
  bytes[bl - 3] = (bitLen >>> 16) & 255;
  bytes[bl - 2] = (bitLen >>> 8) & 255;
  bytes[bl - 1] = bitLen & 255;
  const w = new Int32Array(64);
  for (let o = 0; o < bl; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[o + i * 4]! << 24) | (bytes[o + i * 4 + 1]! << 16) | (bytes[o + i * 4 + 2]! << 8) | bytes[o + i * 4 + 3]!;
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15]!, 7) ^ rr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rr(w[i - 2]!, 17) ^ rr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0]! + a) | 0; H[1] = (H[1]! + b) | 0; H[2] = (H[2]! + c) | 0; H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0; H[5] = (H[5]! + f) | 0; H[6] = (H[6]! + g) | 0; H[7] = (H[7]! + h) | 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (H[i]! >>> 24) & 255; out[i * 4 + 1] = (H[i]! >>> 16) & 255; out[i * 4 + 2] = (H[i]! >>> 8) & 255; out[i * 4 + 3] = H[i]! & 255;
  }
  return out;
}

function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) { bits += 8; continue; }
    for (let m = 7; m >= 0; m--) { if ((b >> m) & 1) return bits; bits++; }
    break;
  }
  return bits;
}

/** Solve a challenge → the solution string the server will accept. */
export function solveChallenge(nonce: string, difficulty: number): string {
  const enc = new TextEncoder();
  for (let i = 0; ; i++) {
    if (leadingZeroBits(sha256(enc.encode(`${nonce}:${i}`))) >= difficulty) return String(i);
  }
}
