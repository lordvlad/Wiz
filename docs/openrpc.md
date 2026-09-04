# OpenRPC Schema & Handlers

`wiz` provides compile-time type harvesting and code generation for OpenRPC 1.3 documents.

## Harvesting OpenRPC Schemas with `openRPCSchema`

The `openRPCSchema<[...]>()` macro harvests methods, parameter shapes, and return types from TypeScript type parameters.

```ts
import { openRPCSchema } from "wiz";

// 1. Function signature type
type GetUser = (id: string) => Promise<User>;

// 2. Service object type
interface UserService {
  /** @name user_search */
  searchUsers(query: string): Promise<User[]>;
  getUser(id: string): Promise<User>;
}

export const schema = openRPCSchema<[GetUser, UserService]>();
```

### Harvester Behavior

- **Function Types**: Extracted as single OpenRPC methods. Method names default to the type/symbol name (or JSDoc `@name` override).
- **Service Object Types**: All callable property methods are extracted. Method names are namespaced as `${ServiceName}.${methodName}` (e.g. `UserService.getUser`). A JSDoc `@name` tag on a member overrides the namespaced name.
- **0-Method Warning**: If an object type with 0 methods is passed to `openRPCSchema`, a compiler warning (`no methods found on object type '<TypeName>' for openRPCSchema`) is logged.
- **`@package` / `@service`**: `@service Users` renames the namespace, and `@package acme` prefixes it, so a method becomes `acme.Users.getUser`. Both are read from the interface (applying to every method) or from a single method.
- **Other tags**: `@summary` and the doc comment's prose become the method's summary and description; `@deprecated` marks it deprecated.
- **Payload types**: A service interface contributes methods only; it is not
  emitted as a `components.schemas` entry, since an interface of methods is not
  a payload.

## The generated client

`wiz generate -g tsClient openrpc.json --outdir src/api` emits `model.ts` and
`api.ts`, and a method is one `POST` of a JSON-RPC envelope to `baseUrl`:

```ts
async calcAdd(params, callOptions) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "Calc.add", params });
  const res = (await send(config, {
    method: "POST",
    url: config.baseUrl,
    headers: { "content-type": "application/json" },
    body,
  }, callOptions)) as JsonRpcResponse;
  if (res?.error) throw new RpcError(res.error);
  return res?.result as number;
}
```

It is the same `send` an HTTP client uses, so a JSON-RPC call carries the same
`interceptors.http` chain, the same `signal`/`timeoutMs` per call and the same
`transport` override; there is no second transport to configure. The id counts
per client, starting from 1. An `error` member becomes an `RpcError` with the
JSON-RPC `code` and `data` on it — the transport succeeded, so there is no
status to report.
