# AsyncAPI Support

`wiz` provides extractors, schema generators, and client code generators for AsyncAPI 2.x and 3.x event-driven architecture specifications.

## 1. Spec Generator (`asyncapiSchema`)

Symmetric to OpenAPI's `openapiSchema`, `wiz` builds AsyncAPI 2.6 and 3.0
documents from TypeScript types and service interfaces. Channels and their
direction are declared with JSDoc on the interface's methods.

```ts
import { asyncapiSchema } from "wiz";

export interface UserSignupEvent {
  userId: string;
  email: string;
  timestamp: Date;
}

export interface UserLogoutEvent {
  userId: string;
}

/** @service UserEvents */
export interface UserEvents {
  /**
   * @producer
   * @channel user/signup
   */
  signup(event: UserSignupEvent): void;

  /**
   * @consumer
   * @channel user/logout
   */
  logout(event: UserLogoutEvent): void;
}

export const document = asyncapiSchema<[UserEvents]>({
  info: { title: "User Event Service", version: "1.0.0" },
});
```

### JSDoc tags

- `@producer` (or `@publish`, `@send`): a send operation on the channel.
- `@consumer` (or `@subscribe`, `@receive`): a receive operation on the channel.
- `@action send` / `@action receive`: the same choice spelled as one tag.
- `@channel`: the channel address; defaults to the method name.
- `@name`: overrides the operation id.
- `@package` / `@service`: emitted as `x-package` / `x-service` on both the
  channel and the operation, and prefixed onto the channel key
  (`package.service.channel`, or `service.channel` when there is no package).
- `@summary`, and the doc comment's prose as `description`.

The message payload is the first parameter's type, or the return type for a
method that takes none. A type passed to `asyncapiSchema` that has no callable
members is a plain message type: it contributes a component schema and a
message, and no channel.

## 2. Client Generator (`asyncapiClient` / `tsClient`)

When generating a client from an AsyncAPI specification, `wiz` emits **only `model.ts` and `codec.ts`** (no HTTP transport or send function runtime, as AsyncAPI specifies message and payload data contracts rather than REST/HTTP endpoints).

```bash
wiz generate -g asyncapiClient asyncapi.yaml --outdir src/events
```

### Emitted Files

- **`model.ts`**: TypeScript interfaces and types for all AsyncAPI messages and schema components.
- **`codec.ts`**: Encoders (`encode<Message>`) and decoders (`decode<Message>`) for all message payloads.

```ts
import { decodeUserSignupEvent, encodeUserSignupEvent } from "./codec";

// Decode incoming raw payload
const event = decodeUserSignupEvent(rawJsonOrText);

// Encode outgoing payload
const text = encodeUserSignupEvent(event);
```
