# Model Context Protocol (MCP) Schema Generation

`wiz` provides compile-time type harvesting and code generation for Model Context Protocol (MCP) tool specifications.

## Harvesting MCP Tool Specs with `mcpSchema`

The `mcpSchema<[...]>()` macro harvests tool specifications, input JSON schemas, and output JSON schemas from TypeScript function signature types and service interfaces.

```ts
import { mcpSchema } from "wiz";

// 1. Function signature type
type CalculateTax = (amount: number, rate: number) => number;

// 2. Service object type
interface UserService {
  /** Search registered users */
  searchUsers(query: string): Promise<User[]>;

  /** @name get_user_by_id */
  getUser(id: string): Promise<User>;
}

export const tools = mcpSchema<[CalculateTax, UserService]>();
```

### Harvester Behavior

- **Function Types**: Extracted as single MCP tools. Tool names default to snake_case of the function/type name (`calculate_tax`), or JSDoc `@name` override.
- **Service Object Types**: All callable property methods are extracted. Tool names are namespaced as `${ServiceName}.${toSnakeCase(methodName)}` (e.g. `UserService.search_users`). A JSDoc `@name` tag on a member overrides the namespaced name.
- **Deduplication**: Service methods and MCP tool types are deduplicated cleanly by tool `name`.
- **0-Method Warning**: If an object type with 0 methods is passed to `mcpSchema`, a compiler warning (`no methods found on object type '<TypeName>' for mcpSchema`) is logged.
- **`@package` / `@service`**: `@service Users` renames the namespace, and `@package acme` prefixes it, so a tool becomes `acme.Users.search_users`. Both are read from the interface (applying to every method) or from a single method.
- **Other tags**: `@title`, `@summary`, `@audience` and `@priority` populate the tool's title, description and annotations; the doc comment's prose is the description.
