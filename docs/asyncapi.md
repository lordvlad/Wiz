# AsyncAPI Support

`wiz` provides extractors, schema generators, and client code generators for AsyncAPI 2.x and 3.x event-driven architecture specifications.

## 1. Spec Generator (`asyncapiSchema`)

Symmetric to OpenAPI's `openapiSchema`, `wiz` builds AsyncAPI documents from
TypeScript types and service interfaces. Channels and their direction are
declared with JSDoc on the interface's methods. The macro emits AsyncAPI
**3.0**; 2.6 is supported on the input side, where `extractAsyncApiIR` detects
the declared version, and by `generateAsyncApiSchemaCode(types, "2.6", service)`
when a 2.6 document is wanted from a generator of your own.

```ts
import { asyncapiSchema } from "wiz";

export interface UserSignupEvent {
  userId: string;
  email: string;
  timestamp: Date;
}

export interface UserLoginEvent {
  userId: string;
  at: Date;
}

export interface UserLogoutEvent {
  userId: string;
}

/** @service UserEvents */
export interface UserEvents {
  /**
   * The application produces these, and a producer is a listener
   * registration: what the listener receives is the channel's payload.
   *
   * @producer
   * @channel user/signup
   */
  onSignup(listener: (event: UserSignupEvent) => void): void;

  /**
   * A stream says the same thing, for a producer that is pulled rather than
   * pushed.
   *
   * @producer
   * @channel user/login
   */
  logins(): AsyncIterable<UserLoginEvent>;

  /**
   * A consumer is the other direction, so it takes the payload straight.
   *
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

The message payload is read off the signature, in whichever of the three
spellings the method uses: the parameter of a listener the method registers
(`onSignup(listener: (event: E) => void)`), the element of an `AsyncIterable`,
`AsyncIterator`, `AsyncGenerator` or `ReadableStream` the method returns
(`logins(): AsyncIterable<E>`), or the first parameter itself
(`logout(event: E)`). `Promise` is unwrapped first, so a method that resolves
to a stream reads the same as one that returns it.

A channel operation needs an explicit direction, and it is never guessed: a
member carrying neither `@producer`, `@consumer` nor a usable `@action` is not
an operation, so a class whose other members serve HTTP or nothing at all can
be handed to `asyncapiSchema` directly. A type argument whose members yield no
operation is reported as a warning naming the type.

A type passed to `asyncapiSchema` that has no callable members is a plain
message type: it contributes a component schema and a message, and no channel.
A service type contributes channels and operations only — it is not itself a
message.

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
