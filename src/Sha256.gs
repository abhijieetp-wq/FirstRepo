/**
 * SHA-256 and HMAC-SHA256, in plain JavaScript.
 *
 * Apps Script already has these — `Utilities.computeDigest` and
 * `Utilities.computeHmacSha256Signature` — and for one hash they are the right thing to call.
 * The password derivation does not do one hash. It does four thousand, each feeding the next,
 * and every one of those is a crossing from JavaScript into the Apps Script host runtime.
 * The crossing costs far more than the arithmetic, so signing in took several seconds of
 * almost pure overhead: the work was never the problem, the four thousand doorways were.
 *
 * Run inside V8 the same four thousand iterations are a few tens of milliseconds. So the
 * security parameter does not move — it is the same algorithm, the same salt and the same
 * iteration count, producing byte-for-byte the same hash as before — and the platform tax
 * goes away. Nobody's stored password is invalidated, because nothing about the derivation
 * changed except where it runs.
 *
 * Byte-for-byte is not a hope: sha256-test derives the same values through this code and
 * through a reference implementation and insists they match, for the empty string, for long
 * inputs, for keys longer than the block size, and across the whole iteration chain.
 */

/** The first thirty-two bits of the fractional parts of the cube roots of the first 64 primes. */
var SHA256_K_ = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

/** The first thirty-two bits of the fractional parts of the square roots of the first 8 primes. */
var SHA256_H_ = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];

var SHA256_BLOCK_BYTES_ = 64;

/**
 * SHA-256 of a byte array, returned as a byte array of 32 unsigned values.
 *
 * Written against FIPS 180-4 directly rather than adapted from anything: every operation is
 * on 32-bit words, and `| 0` after each addition is what keeps JavaScript's 53-bit numbers
 * behaving like the 32-bit registers the specification assumes.
 */
function sha256Bytes_(bytes) {
  var h = SHA256_H_.slice();
  var len = bytes.length;
  // The padding the specification requires: a single 1 bit, zeroes, then the message length
  // in bits as a 64-bit big-endian integer.
  var padded = bytes.slice();
  padded.push(0x80);
  while (padded.length % SHA256_BLOCK_BYTES_ !== 56) padded.push(0);
  var bitsHigh = Math.floor(len / 536870912);       // len * 8, divided by 2^32
  var bitsLow = (len * 8) >>> 0;
  padded.push((bitsHigh >>> 24) & 0xff, (bitsHigh >>> 16) & 0xff,
              (bitsHigh >>> 8) & 0xff, bitsHigh & 0xff);
  padded.push((bitsLow >>> 24) & 0xff, (bitsLow >>> 16) & 0xff,
              (bitsLow >>> 8) & 0xff, bitsLow & 0xff);

  var w = new Array(64);
  for (var pos = 0; pos < padded.length; pos += SHA256_BLOCK_BYTES_) {
    var i;
    for (i = 0; i < 16; i++) {
      w[i] = ((padded[pos + i * 4] << 24) | (padded[pos + i * 4 + 1] << 16) |
              (padded[pos + i * 4 + 2] << 8) | padded[pos + i * 4 + 3]) >>> 0;
    }
    for (i = 16; i < 64; i++) {
      var s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
               ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      var s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
               ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (((w[i - 16] + (s0 >>> 0)) >>> 0) + ((w[i - 7] + (s1 >>> 0)) >>> 0)) >>> 0;
    }

    var a = h[0], b = h[1], c = h[2], d = h[3];
    var e = h[4], f = h[5], g = h[6], hh = h[7];

    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + (S1 >>> 0)) >>> 0;
      t1 = (t1 + (ch >>> 0)) >>> 0;
      t1 = (t1 + SHA256_K_[i]) >>> 0;
      t1 = (t1 + w[i]) >>> 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = ((S0 >>> 0) + (maj >>> 0)) >>> 0;

      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  var out = [];
  for (var j = 0; j < 8; j++) {
    out.push((h[j] >>> 24) & 0xff, (h[j] >>> 16) & 0xff, (h[j] >>> 8) & 0xff, h[j] & 0xff);
  }
  return out;
}

/**
 * HMAC-SHA256, with the same argument order Apps Script uses: the message first, the key
 * second. Keeping that order means the call sites read identically before and after.
 */
function hmacSha256Bytes_(messageBytes, keyBytes) {
  var key = keyBytes.slice();
  // A key longer than the block is hashed down to fit; a shorter one is padded with zeroes.
  if (key.length > SHA256_BLOCK_BYTES_) key = sha256Bytes_(key);
  while (key.length < SHA256_BLOCK_BYTES_) key.push(0);

  var inner = [];
  var outer = [];
  for (var i = 0; i < SHA256_BLOCK_BYTES_; i++) {
    inner.push(key[i] ^ 0x36);
    outer.push(key[i] ^ 0x5c);
  }
  return sha256Bytes_(outer.concat(sha256Bytes_(inner.concat(messageBytes))));
}

/**
 * Apps Script hands out signed bytes (-128..127) where the maths wants unsigned (0..255).
 * Same eight bits either way; only the sign bit's interpretation differs.
 */
function toUnsignedBytes_(bytes) {
  var out = new Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
  return out;
}

var BASE64_ALPHABET_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Standard base64 with padding — the same output Utilities.base64Encode gives for the same
 * bytes. Done here rather than through Utilities so the whole derivation is one JavaScript
 * call and nothing crosses into the host runtime at all.
 */
function base64FromBytes_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET_.charAt(b0 >>> 2);
    out += BASE64_ALPHABET_.charAt(((b0 & 0x03) << 4) | (b1 >>> 4));
    out += i + 1 < bytes.length ? BASE64_ALPHABET_.charAt(((b1 & 0x0f) << 2) | (b2 >>> 6)) : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET_.charAt(b2 & 0x3f) : '=';
  }
  return out;
}

/**
 * The bytes of a string as UTF-8, which is what Utilities.newBlob(s).getBytes() returns.
 *
 * Passwords are typed by people and people type accented letters, so this cannot assume one
 * byte per character. Surrogate pairs are joined back into one code point before encoding,
 * or an emoji in a password would encode as two invalid halves.
 */
function utf8Bytes_(str) {
  var s = String(str);
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = ((c - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f),
               0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}
