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
