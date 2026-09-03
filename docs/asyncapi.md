# AsyncAPI Support

`wiz` provides extractors, schema generators, and client code generators for AsyncAPI 2.x and 3.x event-driven architecture specifications.

## 1. Spec Generator (`asyncapiSchema`, `producer`, `consumer`)

Symmetric to OpenAPI's `openapiSchema` and `op`, `wiz` supports building AsyncAPI 2.6 and 3.0 schema documents directly from TypeScript types and operation descriptors.

```ts
import { asyncapiSchema, producer, consumer } from "wiz";

export interface UserSignupEvent {
  userId: string;
  email: string;
  timestamp: Date;
}

export interface UserLogoutEvent {
  userId: string;
}

// Declare channels and operations using producer (send/publish) and consumer (receive/subscribe)
export const document = asyncapiSchema<[UserSignupEvent, UserLogoutEvent]>(
  {
    info: { title: "User Event Service", version: "1.0.0" },
  },
  [
    producer<{ channel: "user/signup"; payload: UserSignupEvent }>(),
    consumer<{ channel: "user/logout"; payload: UserLogoutEvent }>(),
  ]
);
```

### Operation Descriptors

- **`producer<TSpec>(channelOrHandler?, options?)`**: Represents a publish/send operation on an AsyncAPI channel.
- **`consumer<TSpec>(channelOrHandler?, options?)`**: Represents a subscribe/receive operation on an AsyncAPI channel.

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
