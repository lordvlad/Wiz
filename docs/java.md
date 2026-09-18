# Java Code Generator

`wiz` provides a Java code generator that emits Java Records/POJOs and Jakarta REST client classes from OpenAPI, AsyncAPI, and JSON Schema definitions.

## Usage

Via CLI:
```bash
wiz generate -g java openapi.json -o ./src/main/java/com/example
```

Programmatic:
```ts
import { generateJavaFiles, javaGenerator } from "wiz";
import { generate } from "wiz";

const files = generate(apiIR, javaGenerator, {
  style: "record",       // "record" (default) | "pojo"
  package: "com.example",
  jackson: true,         // default: true
  validation: true,      // default: true (Jakarta validation annotations)
  lombok: false,         // default: false (when true on POJOs, omits explicit getters/setters/constructors)
  client: "jakarta",     // "jakarta" (default) | "off" | false
});
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `style` | `"record"` \| `"pojo"` | `"record"` | Emits Java 17+ Records or traditional POJO classes. |
| `package` | `string` | `undefined` | Package declaration header for generated files. |
| `jackson` | `boolean` | `true` | Emits `@JsonProperty`, `@JsonInclude`, `@JsonValue`, `@JsonCreator` annotations. |
| `validation` | `boolean` | `true` | Emits `@jakarta.validation.constraints.*` (`@NotNull`, `@Size`, `@Min`, `@Max`, `@Pattern`, etc.). |
| `lombok` | `boolean` | `false` | Emits `@Data`, `@Builder`, `@NoArgsConstructor`, `@AllArgsConstructor`, `@Jacksonized` on POJOs and omits hand-written getters/setters. |
| `client` | `"jakarta"` \| `"off"` \| `false` | `"jakarta"` | Generates a Jakarta REST client (`jakarta.ws.rs.client.*`) implementing `AutoCloseable`. |
| `clientName` | `string` | `undefined` | Custom client class name override (defaults to `<ServiceName>Client` or `ApiClient`). |

## Jakarta REST Client

When `client: "jakarta"` (default) is enabled on an API document containing HTTP operations, a typed client class is emitted implementing `AutoCloseable`:
- Uses standard Jakarta REST Client APIs (`jakarta.ws.rs.client.Client`, `ClientBuilder`, `WebTarget`, `Entity`, `GenericType`).
- Automatically resolves path templates, query parameters, headers, and request bodies.
- Handles generic return types (such as `java.util.List<Pet>`) using `new GenericType<...>() {}`.

## Verification Status

> **Note**: Test suite runs structural/emission unit tests in Bun. One-off compilation and execution has been verified with Java 25 (`javac` and `java` 25.0.4) against standard Jackson, Jakarta Validation, and Jakarta WS-RS client libraries.
