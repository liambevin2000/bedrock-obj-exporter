'use strict';
// Little-endian NBT reader (Bedrock's on-disk flavour). Returns plain JS values.

function readPayload(buf, type, pos) {
  switch (type) {
    case 1: return buf.readInt8(pos.p++);
    case 2: { const v = buf.readInt16LE(pos.p); pos.p += 2; return v; }
    case 3: { const v = buf.readInt32LE(pos.p); pos.p += 4; return v; }
    case 4: { const v = buf.readBigInt64LE(pos.p); pos.p += 8; return v; }
    case 5: { const v = buf.readFloatLE(pos.p); pos.p += 4; return v; }
    case 6: { const v = buf.readDoubleLE(pos.p); pos.p += 8; return v; }
    case 7: { const n = buf.readInt32LE(pos.p); pos.p += 4; const v = buf.subarray(pos.p, pos.p + n); pos.p += n; return v; }
    case 8: { const n = buf.readUInt16LE(pos.p); pos.p += 2; const v = buf.toString('utf8', pos.p, pos.p + n); pos.p += n; return v; }
    case 9: {
      const t = buf[pos.p++]; const n = buf.readInt32LE(pos.p); pos.p += 4;
      const out = new Array(Math.max(n, 0));
      for (let i = 0; i < n; i++) out[i] = readPayload(buf, t, pos);
      return out;
    }
    case 10: {
      const out = {};
      for (;;) {
        const t = buf[pos.p++];
        if (t === 0) return out;
        const n = buf.readUInt16LE(pos.p); pos.p += 2;
        const name = buf.toString('utf8', pos.p, pos.p + n); pos.p += n;
        out[name] = readPayload(buf, t, pos);
      }
    }
    case 11: { const n = buf.readInt32LE(pos.p); pos.p += 4; const v = new Int32Array(n); for (let i = 0; i < n; i++, pos.p += 4) v[i] = buf.readInt32LE(pos.p); return v; }
    case 12: { const n = buf.readInt32LE(pos.p); pos.p += 4; const v = new Array(n); for (let i = 0; i < n; i++, pos.p += 8) v[i] = buf.readBigInt64LE(pos.p); return v; }
    default: throw new Error('Bad NBT tag ' + type + ' at ' + pos.p);
  }
}

// Reads one named root tag starting at pos.p and advances pos.
function readNbt(buf, pos) {
  const type = buf[pos.p++];
  if (type === 0) return null;
  const n = buf.readUInt16LE(pos.p); pos.p += 2 + n;
  return readPayload(buf, type, pos);
}

module.exports = { readNbt };
