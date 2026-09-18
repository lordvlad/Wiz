# Java Model Generator

`wiz` provides a Java model code generator that emits Java Record or POJO class definitions from OpenAPI, AsyncAPI, and JSON Schema models.

## Usage

Via CLI:
```bash
wiz generate -g java openapi.json -o ./src/main/java/com/example/model
```

Programmatic:
```ts
import { generateJavaModels, javaGenerator } from "wiz";
import { generate } from "wiz";

const files = generateJavaModels(types, {
  style: "record", // "record" (default) | "pojo"
  package: "com.example.model",
  jackson: true,   // default: true
  validation: true, // default: true (Jakarta validation)
  lombok: true,    // default: false (when true on POJOs, skips explicit getters/setters/constructors)
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

## Notes & Verification Status

> **Note**: The Java generator currently performs code emission and shallow structural assertions. Generated Java code is not compiled or runtime-tested against the Java compiler / JVM in this test suite.
