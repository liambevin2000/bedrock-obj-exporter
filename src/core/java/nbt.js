'use strict';
// Big-endian NBT reader (Java Edition's flavour). Returns plain JS values; longs are BigInt and long
// arrays are BigInt64Array, read in bulk because block data is stored in them.

function readPayload(buf, type, pos) {
  switch (type) {
    case 1: return buf.readInt8(pos.p++);
    case 2: { const v = buf.readInt16BE(pos.p); pos.p += 2; return v; }
    case 3: { const v = buf.readInt32BE(pos.p); pos.p += 4; return v; }
    case 4: { const v = buf.readBigInt64BE(pos.p); pos.p += 8; return v; }
    case 5: { const v = buf.readFloatBE(pos.p); pos.p += 4; return v; }
    case 6: { const v = buf.readDoubleBE(pos.p); pos.p += 8; return v; }
    case 7: { const n = buf.readInt32BE(pos.p); pos.p += 4; const v = buf.subarray(pos.p, pos.p + n); pos.p += n; return v; }
    case 8: { const n = buf.readUInt16BE(pos.p); pos.p += 2; const v = buf.toString('utf8', pos.p, pos.p + n); pos.p += n; return v; }
    case 9: {
      const t = buf[pos.p++]; const n = buf.readInt32BE(pos.p); pos.p += 4;
      const out = new Array(Math.max(n, 0));
      for (let i = 0; i < n; i++) out[i] = readPayload(buf, t, pos);
      return out;
    }
    case 10: {
      const out = {};
      for (;;) {
        const t = buf[pos.p++];
        if (t === 0 || t === undefined) return out;
        const n = buf.readUInt16BE(pos.p); pos.p += 2;
        const name = buf.toString('utf8', pos.p, pos.p + n); pos.p += n;
        out[name] = readPayload(buf, t, pos);
      }
    }
    case 11: { const n = buf.readInt32BE(pos.p); pos.p += 4; const v = new Int32Array(n); for (let i = 0; i < n; i++, pos.p += 4) v[i] = buf.readInt32BE(pos.p); return v; }
    case 12: {
      const n = buf.readInt32BE(pos.p); pos.p += 4;
      const v = new BigInt64Array(n);
      for (let i = 0; i < n; i++, pos.p += 8) v[i] = buf.readBigInt64BE(pos.p);
      return v;
    }
    default: throw new Error('Bad NBT tag ' + type + ' at ' + pos.p);
  }
}

// Reads one named root tag. Network-style unnamed roots (type byte then payload) are not used on disk.
function readNbt(buf, pos = { p: 0 }) {
  const type = buf[pos.p++];
  if (type === 0) return null;
  const n = buf.readUInt16BE(pos.p); pos.p += 2 + n;
  return readPayload(buf, type, pos);
}

// level.dat and friends: gzip compressed (sometimes plain).
function readNbtFile(file) {
  const fs = require('fs'), zlib = require('zlib');
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  else if (buf[0] === 0x78) buf = zlib.inflateSync(buf);
  return readNbt(buf, { p: 0 });
}

module.exports = { readNbt, readNbtFile };
