# Erlang Codecs (Text & ETF 131 Binary)

`wiz` provides compile-time and runtime support for Erlang term encoding and decoding in both Erlang Text (`encodeErlangText`, `decodeErlangText`) and Erlang Binary External Term Format (ETF 131: `encodeErlangBinary`, `decodeErlangBinary`).

```ts
import {
  encodeErlangText,
  decodeErlangText,
  encodeErlangBinary,
  decodeErlangBinary,
} from "wiz";

export interface User {
  name: string;
  status: string; // e.g. ":ok" for atom 'ok'
  age: number;
}

const user: User = { name: "Alice", status: ":ok", age: 30 };

// Encode to Erlang Text format
const text = encodeErlangText<User>(user);
// → '#{name => "Alice", status => ok, age => 30}'

// Formatted Erlang Text
const formatted = encodeErlangText<User>(user, 2);
/* →
#{
  name => "Alice",
  status => ok,
  age => 30
}
*/

// Decode from Erlang Text format
const restoredUser = decodeErlangText<User>(text);
// → { name: "Alice", status: ":ok", age: 30 }

// Encode to Erlang External Term Format (ETF 131) binary
const binary = encodeErlangBinary<User>(user);
// Uint8Array starting with magic byte 131 (0x83)

// Decode from ETF 131 binary
const restoredFromBinary = decodeErlangBinary<User>(binary);
// → { name: "Alice", status: ":ok", age: 30 }
```

## Features & Capabilities

- **Atom & String Representation**:
  - A string starting with `:` (e.g. `":ok"`, `":error"`, `":foo"`) is encoded as an **atom** (`ok`, `error`, `foo`).
  - A string without `:` (e.g. `"hello"`) is encoded as an Erlang string (charlist or binary).
  - Decoding an atom produces a colon-prefixed string (e.g. atom `ok` $\rightarrow$ `":ok"`).
- **Map & Object Representation**:
  - When decoding an Erlang map (`#{...}` in Text or `MAP_EXT` 116 in ETF binary):
    - If **ALL** keys are atoms (e.g. atom `name` and atom `age`): decodes into a plain JS object `{ name: "Alice", age: 30 }` with un-prefixed keys.
    - If **NOT all** keys are atoms (e.g. mixed keys or integer keys): decodes atom keys prefixed with a colon (`{ ":name": "Alice", 1: "one" }`).
  - When encoding a plain JS object `{ name: "Alice", age: 30 }` or `{ ":foo": "bar" }`:
    - Encodes as an Erlang map where object keys are written as atoms (`#{name => "Alice", age => 30}`).
- **Formatted Text Encoding (`indent`)**:
  - `encodeErlangText(val, indent)` accepts an optional `indent` parameter (`string | number`).
  - Passing a number `N` formats with `N` spaces per depth level.
  - Passing a string uses that string per depth level.
  - Omitting `indent` or passing a falsy value formats as compact single-line Erlang text.
- **`unknown` Type Parameter Best-Effort Codecs**:
  - When `T` is `unknown` or `any`, `wiz` emits dynamic best-effort runtime encoders and decoders that parse and encode arbitrary JS values and Erlang terms.

## Function Signatures

### `encodeErlangText<T>(val: T, indent?: string | number): string`

Encodes a value `val` of type `T` into an Erlang Text string.

### `decodeErlangText<T>(raw: string): T`

Parses an Erlang Text format string `raw` into a TypeScript value of type `T`.

### `encodeErlangBinary<T>(val: T): Uint8Array`

Encodes a value `val` of type `T` into an Erlang External Term Format (ETF 131) byte buffer (`Uint8Array`), beginning with magic byte `131` (`0x83`).

### `decodeErlangBinary<T>(raw: Uint8Array): T`

Decodes an ETF 131 binary buffer `raw` (`Uint8Array`) into a TypeScript value of type `T`.

## External Term Format (ETF 131) Details

The binary encoder and decoder implement Erlang OTP External Term Format version 131:

| Tag | Name | Type / Representation |
|---|---|---|
| 131 (`0x83`) | Magic Byte | Version header |
| 97 (`0x61`) | `SMALL_INTEGER_EXT` | 8-bit unsigned integer |
| 98 (`0x62`) | `INTEGER_EXT` | 32-bit signed integer (big-endian) |
| 70 (`0x46`) | `NEW_FLOAT_EXT` | IEEE 754 64-bit float (big-endian) |
| 119 (`0x77`) | `SMALL_ATOM_UTF8_EXT` | UTF-8 atom (1-byte length prefix) |
| 118 (`0x76`) | `ATOM_UTF8_EXT` | UTF-8 atom (2-byte BE length prefix) |
| 100 (`0x64`) | `ATOM_EXT` | Atom (2-byte BE length prefix) |
| 109 (`0x6d`) | `BINARY_EXT` | Binary data / string (4-byte BE length prefix) |
| 107 (`0x6b`) | `STRING_EXT` | Charlist string (2-byte BE length prefix) |
| 106 (`0x6a`) | `NIL_EXT` | Empty list `[]` / list tail |
| 108 (`0x6c`) | `LIST_EXT` | List (4-byte BE length prefix + elements + tail) |
| 104 (`0x68`) | `SMALL_TUPLE_EXT` | Tuple (1-byte arity prefix) |
| 105 (`0x69`) | `LARGE_TUPLE_EXT` | Tuple (4-byte BE arity prefix) |
| 116 (`0x74`) | `MAP_EXT` | Map (4-byte BE arity prefix + key-value pairs) |
| 110 / 111 | `SMALL_BIG_EXT` / `LARGE_BIG_EXT` | Arbitrary precision integers / BigInt |
