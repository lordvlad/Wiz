import type { TypeIR } from '../ir/types.ts';

/**
 * Generates Virtual Module code for `encodeCbor` and `decodeCbor`.
 *
 * CBOR (RFC 8949) is self-describing: the wire format carries its own type
 * information, so the codec is dynamic and ignores the IR.
 */
export function generateCborCode(_ir: TypeIR): string {
  return `
var __wizCborEnc;
var __wizCborDec;

export function __wizEncodeCborUnknown(val) {
  __wizCborEnc ??= new TextEncoder();
  const bytes = [];

  function pushBytes(arr) { for (let i = 0; i < arr.length; i++) bytes.push(arr[i]); }

  function head(major, n) {
    const base = major << 5;
    if (typeof n === "bigint") {
      if (n < 24n) { bytes.push(base | Number(n)); return; }
      if (n < 0x100n) { bytes.push(base | 24, Number(n)); return; }
      if (n < 0x10000n) { bytes.push(base | 25, Number((n >> 8n) & 0xffn), Number(n & 0xffn)); return; }
      if (n < 0x100000000n) {
        bytes.push(base | 26, Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn));
        return;
      }
      bytes.push(base | 27);
      for (let s = 56n; s >= 0n; s -= 8n) bytes.push(Number((n >> s) & 0xffn));
      return;
    }
    if (n < 24) { bytes.push(base | n); return; }
    if (n < 0x100) { bytes.push(base | 24, n & 0xff); return; }
    if (n < 0x10000) { bytes.push(base | 25, (n >> 8) & 0xff, n & 0xff); return; }
    if (n < 0x100000000) {
      bytes.push(base | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      return;
    }
    const big = BigInt(n);
    bytes.push(base | 27);
    for (let s = 56n; s >= 0n; s -= 8n) bytes.push(Number((big >> s) & 0xffn));
  }

  function bigMagnitudeBytes(mag) {
    const b = [];
    let m = mag;
    while (m > 0n) {
      b.unshift(Number(m & 0xffn));
      m >>= 8n;
    }
    if (b.length === 0) b.push(0);
    return b;
  }

  function float64(v) {
    bytes.push(0xfb);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, v, false);
    pushBytes(new Uint8Array(buf));
  }

  function encodeText(s) {
    const b = __wizCborEnc.encode(s);
    head(3, b.length);
    pushBytes(b);
  }

  function encodeVal(v) {
    if (v === null) { bytes.push(0xf6); return; }
    if (v === undefined) { bytes.push(0xf7); return; }
    if (typeof v === "boolean") { bytes.push(v ? 0xf5 : 0xf4); return; }
    if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
        if (v >= 0) head(0, v);
        else head(1, -1 - v);
        return;
      }
      float64(v);
      return;
    }
    if (typeof v === "bigint") {
      if (v >= 0n && v <= 0xffffffffffffffffn) { head(0, v); return; }
      if (v < 0n && v >= -0x10000000000000000n) { head(1, -1n - v); return; }
      const neg = v < 0n;
      const mag = neg ? -1n - v : v;
      bytes.push(neg ? 0xc3 : 0xc2);
      const mb = bigMagnitudeBytes(mag);
      head(2, mb.length);
      pushBytes(mb);
      return;
    }
    if (typeof v === "string") { encodeText(v); return; }
    if (v instanceof Uint8Array) { head(2, v.length); pushBytes(v); return; }
    if (v instanceof Date) { bytes.push(0xc0); encodeText(v.toISOString()); return; }
    if (Array.isArray(v)) {
      head(4, v.length);
      for (const elem of v) encodeVal(elem);
      return;
    }
    if (v instanceof Map) {
      head(5, v.size);
      for (const [k, val] of v) { encodeVal(k); encodeVal(val); }
      return;
    }
    if (typeof v === "object") {
      const entries = Object.entries(v);
      head(5, entries.length);
      for (const [k, val] of entries) { encodeText(k); encodeVal(val); }
      return;
    }
    throw new TypeError("wiz: cannot encode " + typeof v + " to CBOR");
  }

  encodeVal(val);
  return new Uint8Array(bytes);
}

export function __wizDecodeCborUnknown(raw) {
  if (raw === undefined || raw === null) return raw;
  __wizCborDec ??= new TextDecoder();
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;

  const BREAK = Symbol("break");
  const INDEFINITE = Symbol("indefinite");

  function need(n) {
    if (offset + n > buf.length) throw new Error("wiz: unexpected end of CBOR buffer");
  }

  function f16(u) {
    const exp = (u >> 10) & 0x1f, mant = u & 0x3ff, sign = (u & 0x8000) ? -1 : 1;
    if (exp === 0) return sign * mant * Math.pow(2, -24);
    if (exp === 31) return mant ? NaN : sign * Infinity;
    return sign * (mant + 1024) * Math.pow(2, exp - 25);
  }

  function readArg(ai) {
    if (ai < 24) return ai;
    if (ai === 24) { need(1); return buf[offset++]; }
    if (ai === 25) { need(2); const n = view.getUint16(offset); offset += 2; return n; }
    if (ai === 26) { need(4); const n = view.getUint32(offset); offset += 4; return n; }
    if (ai === 27) {
      need(8);
      const n = view.getBigUint64(offset); offset += 8;
      return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
    }
    if (ai === 31) return INDEFINITE;
    throw new Error("wiz: reserved CBOR additional information " + ai);
  }

  function readChunks(major) {
    const parts = [];
    let total = 0;
    for (;;) {
      need(1);
      if (buf[offset] === 0xff) { offset++; break; }
      const ib = buf[offset++];
      if ((ib >> 5) !== major) throw new Error("wiz: invalid CBOR indefinite-length chunk");
      const len = readArg(ib & 0x1f);
      if (typeof len !== "number") throw new Error("wiz: invalid CBOR chunk length");
      need(len);
      parts.push(buf.subarray(offset, offset + len));
      offset += len;
      total += len;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  function decodeItem() {
    need(1);
    const ib = buf[offset++];
    const major = ib >> 5;
    const ai = ib & 0x1f;

    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      if (ai === 25) { need(2); const u = view.getUint16(offset); offset += 2; return f16(u); }
      if (ai === 26) { need(4); const n = view.getFloat32(offset); offset += 4; return n; }
      if (ai === 27) { need(8); const n = view.getFloat64(offset); offset += 8; return n; }
      if (ai === 31) return BREAK;
      return readArg(ai);
    }

    const arg = readArg(ai);

    if (major === 0) return arg;
    if (major === 1) {
      if (arg === INDEFINITE) throw new Error("wiz: reserved CBOR additional information 31");
      return typeof arg === "bigint" ? -1n - arg : -1 - arg;
    }
    if (major === 2) {
      if (arg === INDEFINITE) return readChunks(2);
      const len = Number(arg);
      need(len);
      const out = buf.slice(offset, offset + len);
      offset += len;
      return out;
    }
    if (major === 3) {
      if (arg === INDEFINITE) return __wizCborDec.decode(readChunks(3));
      const len = Number(arg);
      need(len);
      const out = __wizCborDec.decode(buf.subarray(offset, offset + len));
      offset += len;
      return out;
    }
    if (major === 4) {
      const items = [];
      if (arg === INDEFINITE) {
        for (;;) {
          const item = decodeItem();
          if (item === BREAK) break;
          items.push(item);
        }
        return items;
      }
      const len = Number(arg);
      for (let i = 0; i < len; i++) items.push(decodeItem());
      return items;
    }
    if (major === 5) {
      const entries = [];
      if (arg === INDEFINITE) {
        for (;;) {
          const k = decodeItem();
          if (k === BREAK) break;
          entries.push([k, decodeItem()]);
        }
      } else {
        const len = Number(arg);
        for (let i = 0; i < len; i++) {
          const k = decodeItem();
          entries.push([k, decodeItem()]);
        }
      }
      if (entries.every((e) => typeof e[0] === "string")) {
        const res = {};
        for (const [k, v] of entries) res[k] = v;
        return res;
      }
      return new Map(entries);
    }
    if (major === 6) {
      const inner = decodeItem();
      const t = Number(arg);
      if (t === 0) return new Date(inner);
      if (t === 1) return new Date(Number(inner) * 1000);
      if (t === 2 || t === 3) {
        let n = 0n;
        if (inner instanceof Uint8Array) {
          for (let i = 0; i < inner.length; i++) n = (n << 8n) | BigInt(inner[i]);
        } else {
          n = BigInt(inner);
        }
        return t === 2 ? n : -1n - n;
      }
      return inner;
    }

    throw new Error("wiz: unsupported CBOR major type " + major);
  }

  return decodeItem();
}

export function encodeCbor(val) {
  return __wizEncodeCborUnknown(val);
}

export function decodeCbor(raw) {
  return __wizDecodeCborUnknown(raw);
}
`;
}
