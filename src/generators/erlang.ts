import type { TypeIR } from "../types.ts";

/**
 * Generates Virtual Module code for `encodeErlangText` and `decodeErlangText`.
 */
export function generateErlangTextCode(_ir: TypeIR): string {
    return `
var __wizTextEnc;
var __wizTextDec;

function __wizParseTextAtomVal(atomName) {
  if (atomName === "true") return true;
  if (atomName === "false") return false;
  if (atomName === "nil" || atomName === "null") return null;
  if (atomName === "undefined") return undefined;
  return ":" + atomName;
}

export function __wizEncodeErlangTextUnknown(val, indent) {
  const indStr = typeof indent === "number" ? " ".repeat(indent) : (typeof indent === "string" ? indent : "");
  const isFormatted = Boolean(indStr);

  function formatVal(v, depth) {
    if (v === null) return "nil";
    if (v === undefined) return "undefined";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return v.toString();
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") {
      if (v.startsWith(":")) {
        const atomName = v.slice(1);
        if (/^[a-z][a-zA-Z0-9_@]*$/.test(atomName)) return atomName;
        return "'" + atomName.replace(/\\\\/g, "\\\\").replace(/'/g, "\\\\'") + "'";
      }
      return '"' + v.replace(/\\\\/g, "\\\\").replace(/"/g, '\\\\"')
        .replace(/\\n/g, "\\\\n").replace(/\\r/g, "\\\\r").replace(/\\t/g, "\\\\t") + '"';
    }
    if (v instanceof Uint8Array) {
      return "<<" + Array.from(v).join(", ") + ">>";
    }
    if (v instanceof Date) {
      return '"' + v.toISOString() + '"';
    }
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (!isFormatted) {
        return "[" + v.map((elem) => formatVal(elem, depth)).join(", ") + "]";
      }
      const childIndent = indStr.repeat(depth + 1);
      const currIndent = indStr.repeat(depth);
      const elems = v.map((elem) => childIndent + formatVal(elem, depth + 1)).join(",\\n");
      return "[\\n" + elems + "\\n" + currIndent + "]";
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length === 0) return "#{}";
      const entries = keys.map((k) => {
        const valStr = formatVal(v[k], depth + 1);
        let atomName = k;
        if (k.startsWith(":")) atomName = k.slice(1);
        let keyStr = atomName;
        if (!/^[a-z][a-zA-Z0-9_@]*$/.test(atomName)) {
          keyStr = "'" + atomName.replace(/\\\\/g, "\\\\").replace(/'/g, "\\\\'") + "'";
        }
        return { keyStr, valStr };
      });
      if (!isFormatted) {
        return "#{" + entries.map((e) => e.keyStr + " => " + e.valStr).join(", ") + "}";
      }
      const childIndent = indStr.repeat(depth + 1);
      const currIndent = indStr.repeat(depth);
      const body = entries.map((e) => childIndent + e.keyStr + " => " + e.valStr).join(",\\n");
      return "#{\\n" + body + "\\n" + currIndent + "}";
    }
    return String(v);
  }

  return formatVal(val, 0);
}

export function __wizDecodeErlangTextUnknown(raw) {
  if (typeof raw !== "string") return raw;
  let idx = 0;

  function skipWhitespace() {
    while (idx < raw.length) {
      const ch = raw[idx];
      if (/\\s/.test(ch)) {
        idx++;
      } else if (ch === "%") {
        while (idx < raw.length && raw[idx] !== "\\n") idx++;
      } else {
        break;
      }
    }
  }

  function parseTerm() {
    skipWhitespace();
    if (idx >= raw.length) throw new Error("Unexpected EOF in Erlang text");
    const ch = raw[idx];

    if (ch === "{") {
      idx++; // skip {
      skipWhitespace();
      const elems = [];
      if (raw[idx] !== "}") {
        while (idx < raw.length) {
          elems.push(parseTerm());
          skipWhitespace();
          if (raw[idx] === ",") {
            idx++;
            skipWhitespace();
          } else {
            break;
          }
        }
      }
      skipWhitespace();
      if (raw[idx] === "}") idx++;
      return elems;
    }

    if (ch === "[") {
      idx++; // skip [
      skipWhitespace();
      const elems = [];
      if (raw[idx] !== "]") {
        while (idx < raw.length) {
          elems.push(parseTerm());
          skipWhitespace();
          if (raw[idx] === ",") {
            idx++;
            skipWhitespace();
          } else if (raw[idx] === "|") {
            idx++;
            skipWhitespace();
            parseTerm(); // skip tail
            skipWhitespace();
          } else {
            break;
          }
        }
      }
      skipWhitespace();
      if (raw[idx] === "]") idx++;
      return elems;
    }

    if (ch === "#") {
      idx++; // skip #
      if (raw[idx] === "{") idx++; // skip {
      skipWhitespace();
      const pairs = [];
      if (raw[idx] !== "}") {
        while (idx < raw.length) {
          const keyMeta = parseTermMeta();
          skipWhitespace();
          if (raw.startsWith("=>", idx) || raw.startsWith(":=", idx)) {
            idx += 2;
          }
          skipWhitespace();
          const val = parseTerm();
          pairs.push({ keyMeta, val });
          skipWhitespace();
          if (raw[idx] === ",") {
            idx++;
            skipWhitespace();
          } else {
            break;
          }
        }
      }
      skipWhitespace();
      if (raw[idx] === "}") idx++;

      const allAtoms = pairs.length > 0 && pairs.every((p) => p.keyMeta.isAtom);
      const res = {};
      for (const p of pairs) {
        if (allAtoms) {
          res[p.keyMeta.atomName] = p.val;
        } else {
          const kStr = p.keyMeta.isAtom ? ":" + p.keyMeta.atomName : String(p.keyMeta.val);
          res[kStr] = p.val;
        }
      }
      return res;
    }

    if (ch === '"') {
      idx++; // skip opening quote
      let str = "";
      while (idx < raw.length) {
        const c = raw[idx++];
        if (c === '"') break;
        if (c === "\\\\") {
          const esc = raw[idx++];
          if (esc === "n") str += "\\n";
          else if (esc === "r") str += "\\r";
          else if (esc === "t") str += "\\t";
          else str += esc;
        } else {
          str += c;
        }
      }
      return str;
    }

    if (ch === "'") {
      idx++; // skip opening quote
      let atomName = "";
      while (idx < raw.length) {
        const c = raw[idx++];
        if (c === "'") break;
        if (c === "\\\\") {
          atomName += raw[idx++];
        } else {
          atomName += c;
        }
      }
      return __wizParseTextAtomVal(atomName);
    }

    if (ch === "<" && raw[idx + 1] === "<") {
      idx += 2; // skip <<
      skipWhitespace();
      if (raw[idx] === '"') {
        idx++; // skip "
        let str = "";
        while (idx < raw.length) {
          const c = raw[idx++];
          if (c === '"') break;
          if (c === "\\\\") str += raw[idx++];
          else str += c;
        }
        skipWhitespace();
        if (raw.startsWith(">>", idx)) idx += 2;
        return str;
      }
      const bytes = [];
      while (idx < raw.length && !raw.startsWith(">>", idx)) {
        const numStr = raw.slice(idx).match(/^-?\\d+/)?.[0];
        if (numStr) {
          bytes.push(parseInt(numStr, 10));
          idx += numStr.length;
        } else {
          idx++;
        }
        skipWhitespace();
        if (raw[idx] === ",") {
          idx++;
          skipWhitespace();
        }
      }
      if (raw.startsWith(">>", idx)) idx += 2;
      return new Uint8Array(bytes);
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const match = raw.slice(idx).match(/^-?\\d+(?:#\\w+|\\.\\d+)?(?:[eE][+-]?\\d+)?/);
      if (match) {
        const numStr = match[0];
        idx += numStr.length;
        if (numStr.includes("#")) {
          const [baseStr, valStr] = numStr.split("#");
          return parseInt(valStr, parseInt(baseStr, 10));
        }
        if (numStr.includes(".") || numStr.includes("e") || numStr.includes("E")) {
          return parseFloat(numStr);
        }
        const big = BigInt(numStr);
        if (big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return Number(big);
        }
        return big;
      }
    }

    if (/[a-z_]/.test(ch)) {
      const match = raw.slice(idx).match(/^[a-zA-Z0-9_@]+/);
      if (match) {
        const atomName = match[0];
        idx += atomName.length;
        return __wizParseTextAtomVal(atomName);
      }
    }

    throw new Error("Unexpected character in Erlang text: " + ch + " at index " + idx);
  }

  function parseTermMeta() {
    skipWhitespace();
    if (idx >= raw.length) throw new Error("Unexpected EOF in Erlang text");
    const ch = raw[idx];

    if (ch === "'") {
      idx++;
      let atomName = "";
      while (idx < raw.length) {
        const c = raw[idx++];
        if (c === "'") break;
        if (c === "\\\\") atomName += raw[idx++];
        else atomName += c;
      }
      return { isAtom: true, atomName, val: __wizParseTextAtomVal(atomName) };
    }

    if (/[a-z_]/.test(ch)) {
      const match = raw.slice(idx).match(/^[a-zA-Z0-9_@]+/);
      if (match) {
        const atomName = match[0];
        idx += atomName.length;
        return { isAtom: true, atomName, val: __wizParseTextAtomVal(atomName) };
      }
    }

    const val = parseTerm();
    return { isAtom: false, atomName: "", val };
  }

  return parseTerm();
}

export function encodeErlangText(val, indent) {
  return __wizEncodeErlangTextUnknown(val, indent);
}

export function decodeErlangText(raw) {
  return __wizDecodeErlangTextUnknown(raw);
}
`;
}

/**
 * Generates Virtual Module code for `encodeErlangBinary` and `decodeErlangBinary`.
 */
export function generateErlangBinaryCode(_ir: TypeIR): string {
    return `
var __wizBinEnc;
var __wizBinDec;

export function __wizEncodeErlangBinaryUnknown(val) {
  __wizBinEnc ??= new TextEncoder();
  const bytes = [131];

  function u8(n) { bytes.push(n & 0xff); }
  function u16BE(n) { bytes.push((n >> 8) & 0xff, n & 0xff); }
  function u32BE(n) { bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
  function pushBytes(arr) { for (let i = 0; i < arr.length; i++) bytes.push(arr[i]); }

  function encodeVal(v) {
    if (v === null) {
      u8(119); u8(3); pushBytes([110, 105, 108]);
      return;
    }
    if (v === undefined) {
      u8(119); u8(9); pushBytes([117, 110, 100, 101, 102, 105, 110, 101, 100]);
      return;
    }
    if (typeof v === "boolean") {
      if (v) {
        u8(119); u8(4); pushBytes([116, 114, 117, 101]);
      } else {
        u8(119); u8(5); pushBytes([102, 97, 108, 115, 101]);
      }
      return;
    }
    if (typeof v === "number") {
      if (Number.isInteger(v)) {
        if (v >= 0 && v <= 255) {
          u8(97); u8(v);
          return;
        }
        if (v >= -2147483648 && v <= 2147483647) {
          u8(98); u32BE(v);
          return;
        }
      }
      u8(70);
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, v, false);
      pushBytes(new Uint8Array(buf));
      return;
    }
    if (typeof v === "bigint") {
      const sign = v < 0n ? 1 : 0;
      let absVal = v < 0n ? -v : v;
      const b = [];
      while (absVal > 0n) {
        b.push(Number(absVal & 0xffn));
        absVal >>= 8n;
      }
      if (b.length === 0) b.push(0);
      if (b.length <= 255) {
        u8(110); u8(b.length); u8(sign); pushBytes(b);
      } else {
        u8(111); u32BE(b.length); u8(sign); pushBytes(b);
      }
      return;
    }
    if (typeof v === "string") {
      if (v.startsWith(":")) {
        const atomName = v.slice(1);
        const aBytes = __wizBinEnc.encode(atomName);
        if (aBytes.length <= 255) {
          u8(119); u8(aBytes.length); pushBytes(aBytes);
        } else {
          u8(118); u16BE(aBytes.length); pushBytes(aBytes);
        }
        return;
      }
      const sBytes = __wizBinEnc.encode(v);
      u8(109); u32BE(sBytes.length); pushBytes(sBytes);
      return;
    }
    if (v instanceof Uint8Array) {
      u8(109); u32BE(v.length); pushBytes(v);
      return;
    }
    if (v instanceof Date) {
      const sBytes = __wizBinEnc.encode(v.toISOString());
      u8(109); u32BE(sBytes.length); pushBytes(sBytes);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        u8(106);
        return;
      }
      u8(108); u32BE(v.length);
      for (const elem of v) encodeVal(elem);
      u8(106);
      return;
    }
    if (typeof v === "object") {
      const entries = Object.entries(v);
      u8(116); u32BE(entries.length);
      for (const [k, val] of entries) {
        let atomName = k;
        if (k.startsWith(":")) atomName = k.slice(1);
        const aBytes = __wizBinEnc.encode(atomName);
        if (aBytes.length <= 255) {
          u8(119); u8(aBytes.length); pushBytes(aBytes);
        } else {
          u8(118); u16BE(aBytes.length); pushBytes(aBytes);
        }
        encodeVal(val);
      }
      return;
    }
    u8(106);
  }

  encodeVal(val);
  return new Uint8Array(bytes);
}

export function __wizDecodeErlangBinaryUnknown(raw) {
  if (!raw) return raw;
  __wizBinDec ??= new TextDecoder();
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (buf[0] !== 131) throw new Error("Invalid ETF 131 magic byte: " + buf[0]);
  let offset = 1;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  function parseAtomVal(atomName) {
    if (atomName === "true") return true;
    if (atomName === "false") return false;
    if (atomName === "nil" || atomName === "null") return null;
    if (atomName === "undefined") return undefined;
    return ":" + atomName;
  }

  function decodeTerm() {
    if (offset >= buf.length) throw new Error("Unexpected end of ETF buffer");
    const tag = buf[offset++];

    if (tag === 97) {
      return { val: buf[offset++], isAtom: false };
    }
    if (tag === 98) {
      const val = view.getInt32(offset); offset += 4;
      return { val, isAtom: false };
    }
    if (tag === 70) {
      const val = view.getFloat64(offset); offset += 8;
      return { val, isAtom: false };
    }
    if (tag === 99) {
      const b = buf.subarray(offset, offset + 31); offset += 31;
      const str = __wizBinDec.decode(b).replace(/\\0/g, "");
      return { val: parseFloat(str), isAtom: false };
    }
    if (tag === 110) {
      const len = buf[offset++];
      const sign = buf[offset++];
      const b = buf.subarray(offset, offset + len); offset += len;
      let n = 0n;
      for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
      if (sign === 1) n = -n;
      const val = (n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(n) : n;
      return { val, isAtom: false };
    }
    if (tag === 111) {
      const len = view.getUint32(offset); offset += 4;
      const sign = buf[offset++];
      const b = buf.subarray(offset, offset + len); offset += len;
      let n = 0n;
      for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
      if (sign === 1) n = -n;
      const val = (n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(n) : n;
      return { val, isAtom: false };
    }
    if (tag === 119 || tag === 115) {
      const len = buf[offset++];
      const atomName = __wizBinDec.decode(buf.subarray(offset, offset + len)); offset += len;
      return { val: parseAtomVal(atomName), isAtom: true, atomName };
    }
    if (tag === 118 || tag === 100) {
      const len = view.getUint16(offset); offset += 2;
      const atomName = __wizBinDec.decode(buf.subarray(offset, offset + len)); offset += len;
      return { val: parseAtomVal(atomName), isAtom: true, atomName };
    }
    if (tag === 109) {
      const len = view.getUint32(offset); offset += 4;
      const bytes = buf.subarray(offset, offset + len); offset += len;
      const val = __wizBinDec.decode(bytes);
      return { val, isAtom: false };
    }
    if (tag === 107) {
      const len = view.getUint16(offset); offset += 2;
      const bytes = buf.subarray(offset, offset + len); offset += len;
      const val = __wizBinDec.decode(bytes);
      return { val, isAtom: false };
    }
    if (tag === 106) {
      return { val: [], isAtom: false };
    }
    if (tag === 108) {
      const len = view.getUint32(offset); offset += 4;
      const elems = [];
      for (let i = 0; i < len; i++) elems.push(decodeTerm().val);
      decodeTerm();
      return { val: elems, isAtom: false };
    }
    if (tag === 104) {
      const arity = buf[offset++];
      const elems = [];
      for (let i = 0; i < arity; i++) elems.push(decodeTerm().val);
      return { val: elems, isAtom: false };
    }
    if (tag === 105) {
      const arity = view.getUint32(offset); offset += 4;
      const elems = [];
      for (let i = 0; i < arity; i++) elems.push(decodeTerm().val);
      return { val: elems, isAtom: false };
    }
    if (tag === 116) {
      const arity = view.getUint32(offset); offset += 4;
      const entries = [];
      for (let i = 0; i < arity; i++) {
        const k = decodeTerm();
        const v = decodeTerm();
        entries.push({ k, v });
      }
      const allAtoms = entries.length > 0 && entries.every((e) => e.k.isAtom);
      const res = {};
      for (const e of entries) {
        if (allAtoms) {
          res[e.k.atomName] = e.v.val;
        } else {
          const kStr = e.k.isAtom ? ":" + e.k.atomName : String(e.k.val);
          res[kStr] = e.v.val;
        }
      }
      return { val: res, isAtom: false };
    }

    throw new Error("Unknown ETF tag: " + tag + " at offset " + (offset - 1));
  }

  return decodeTerm().val;
}

export function encodeErlangBinary(val) {
  return __wizEncodeErlangBinaryUnknown(val);
}

export function decodeErlangBinary(raw) {
  return __wizDecodeErlangBinaryUnknown(raw);
}
`;
}
