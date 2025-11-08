// Minimal MD4 implementation in pure JavaScript.
// Returns a Buffer containing the 16-byte digest for the provided Buffer input.

function leftRotate(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function F(x, y, z) {
  return ((x & y) | (~x & z)) >>> 0;
}

function G(x, y, z) {
  return ((x & y) | (x & z) | (y & z)) >>> 0;
}

function H(x, y, z) {
  return (x ^ y ^ z) >>> 0;
}

function md4(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const originalLengthBytes = input.length;
  const bitLength = BigInt(originalLengthBytes) * 8n;

  const paddingLength = (56 - ((originalLengthBytes + 1) % 64) + 64) % 64;
  const totalLength = originalLengthBytes + 1 + paddingLength + 8;

  const padded = Buffer.alloc(totalLength);
  input.copy(padded, 0);
  padded[originalLengthBytes] = 0x80;
  padded.writeUInt32LE(Number(bitLength & 0xffffffffn), totalLength - 8);
  padded.writeUInt32LE(Number((bitLength >> 32n) & 0xffffffffn), totalLength - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let i = 0; i < padded.length; i += 64) {
    const x = new Array(16);
    for (let j = 0; j < 16; j++) {
      x[j] = padded.readUInt32LE(i + j * 4);
    }

    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    // Round 1
    a = leftRotate((a + F(b, c, d) + x[0]) >>> 0, 3);
    d = leftRotate((d + F(a, b, c) + x[1]) >>> 0, 7);
    c = leftRotate((c + F(d, a, b) + x[2]) >>> 0, 11);
    b = leftRotate((b + F(c, d, a) + x[3]) >>> 0, 19);

    a = leftRotate((a + F(b, c, d) + x[4]) >>> 0, 3);
    d = leftRotate((d + F(a, b, c) + x[5]) >>> 0, 7);
    c = leftRotate((c + F(d, a, b) + x[6]) >>> 0, 11);
    b = leftRotate((b + F(c, d, a) + x[7]) >>> 0, 19);

    a = leftRotate((a + F(b, c, d) + x[8]) >>> 0, 3);
    d = leftRotate((d + F(a, b, c) + x[9]) >>> 0, 7);
    c = leftRotate((c + F(d, a, b) + x[10]) >>> 0, 11);
    b = leftRotate((b + F(c, d, a) + x[11]) >>> 0, 19);

    a = leftRotate((a + F(b, c, d) + x[12]) >>> 0, 3);
    d = leftRotate((d + F(a, b, c) + x[13]) >>> 0, 7);
    c = leftRotate((c + F(d, a, b) + x[14]) >>> 0, 11);
    b = leftRotate((b + F(c, d, a) + x[15]) >>> 0, 19);

    // Round 2
    const round2Constant = 0x5a827999;
    a = leftRotate((a + G(b, c, d) + x[0] + round2Constant) >>> 0, 3);
    d = leftRotate((d + G(a, b, c) + x[4] + round2Constant) >>> 0, 5);
    c = leftRotate((c + G(d, a, b) + x[8] + round2Constant) >>> 0, 9);
    b = leftRotate((b + G(c, d, a) + x[12] + round2Constant) >>> 0, 13);

    a = leftRotate((a + G(b, c, d) + x[1] + round2Constant) >>> 0, 3);
    d = leftRotate((d + G(a, b, c) + x[5] + round2Constant) >>> 0, 5);
    c = leftRotate((c + G(d, a, b) + x[9] + round2Constant) >>> 0, 9);
    b = leftRotate((b + G(c, d, a) + x[13] + round2Constant) >>> 0, 13);

    a = leftRotate((a + G(b, c, d) + x[2] + round2Constant) >>> 0, 3);
    d = leftRotate((d + G(a, b, c) + x[6] + round2Constant) >>> 0, 5);
    c = leftRotate((c + G(d, a, b) + x[10] + round2Constant) >>> 0, 9);
    b = leftRotate((b + G(c, d, a) + x[14] + round2Constant) >>> 0, 13);

    a = leftRotate((a + G(b, c, d) + x[3] + round2Constant) >>> 0, 3);
    d = leftRotate((d + G(a, b, c) + x[7] + round2Constant) >>> 0, 5);
    c = leftRotate((c + G(d, a, b) + x[11] + round2Constant) >>> 0, 9);
    b = leftRotate((b + G(c, d, a) + x[15] + round2Constant) >>> 0, 13);

    // Round 3
    const round3Constant = 0x6ed9eba1;
    a = leftRotate((a + H(b, c, d) + x[0] + round3Constant) >>> 0, 3);
    d = leftRotate((d + H(a, b, c) + x[8] + round3Constant) >>> 0, 9);
    c = leftRotate((c + H(d, a, b) + x[4] + round3Constant) >>> 0, 11);
    b = leftRotate((b + H(c, d, a) + x[12] + round3Constant) >>> 0, 15);

    a = leftRotate((a + H(b, c, d) + x[2] + round3Constant) >>> 0, 3);
    d = leftRotate((d + H(a, b, c) + x[10] + round3Constant) >>> 0, 9);
    c = leftRotate((c + H(d, a, b) + x[6] + round3Constant) >>> 0, 11);
    b = leftRotate((b + H(c, d, a) + x[14] + round3Constant) >>> 0, 15);

    a = leftRotate((a + H(b, c, d) + x[1] + round3Constant) >>> 0, 3);
    d = leftRotate((d + H(a, b, c) + x[9] + round3Constant) >>> 0, 9);
    c = leftRotate((c + H(d, a, b) + x[5] + round3Constant) >>> 0, 11);
    b = leftRotate((b + H(c, d, a) + x[13] + round3Constant) >>> 0, 15);

    a = leftRotate((a + H(b, c, d) + x[3] + round3Constant) >>> 0, 3);
    d = leftRotate((d + H(a, b, c) + x[11] + round3Constant) >>> 0, 9);
    c = leftRotate((c + H(d, a, b) + x[7] + round3Constant) >>> 0, 11);
    b = leftRotate((b + H(c, d, a) + x[15] + round3Constant) >>> 0, 15);

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}

module.exports = { md4 };
