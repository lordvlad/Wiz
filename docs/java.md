# Java Code Generator

`wiz` provides a Java code generator that emits Java Records/POJOs, Jakarta REST client classes, and MicroProfile REST client interfaces from OpenAPI, AsyncAPI, and JSON Schema definitions.

## Usage

Via CLI:
```bash
# Generate Java records and default Jakarta REST client
wiz generate -g java openapi.json -o ./src/main/java/com/example

# Generate MicroProfile @RegisterRestClient interfaces
wiz generate -g java openapi.json -o ./src/main/java/com/example
```

Programmatic:
```ts
import { generateJavaFiles, javaGenerator } from "wiz";
import { generate } from "wiz";

// Default configuration (Records + Jakarta REST client)
const files = generate(apiIR, javaGenerator, {
  style: "record",       // "record" (default) | "pojo"
  package: "com.example",
  jackson: true,         // default: true
  validation: true,      // default: true (Jakarta validation annotations)
  lombok: false,         // default: false (when true on POJOs, omits explicit getters/setters/constructors)
  client: "jakarta",     // "jakarta" (default) | "mp" | "off" | false
});

// MicroProfile REST Client interface generation
const mpFiles = generate(apiIR, javaGenerator, {
  package: "com.example",
  client: "mp",          // emits @RegisterRestClient interface for CDI injection (@RestClient)
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
| `client` | `"jakarta"` \| `"mp"` \| `"off"` \| `false` | `"jakarta"` | Generates a Jakarta REST client class (`"jakarta"`), a MicroProfile `@RegisterRestClient` interface (`"mp"`), or disables client generation (`"off"` / `false`). |
| `clientName` | `string` | `undefined` | Custom client class name override (defaults to `<ServiceName>Client` or `ApiClient`). |

## Client Styles

### 1. Jakarta REST Client (`client: "jakarta"`, default)
Emits a typed implementation class implementing `java.lang.AutoCloseable`:
- Built on standard Jakarta REST Client APIs (`jakarta.ws.rs.client.Client`, `ClientBuilder`, `WebTarget`, `Entity`, `GenericType`).
- Automatically manages path template resolution, query parameters, headers, and request bodies.
- Handles generic and collection responses (`java.util.List<T>`, etc.) using `new GenericType<...>() {}`.

### 2. MicroProfile REST Client (`client: "mp"`)
Emits a declarative `@RegisterRestClient` interface designed for CDI injection via `@RestClient`:
- Annotated with `@RegisterRestClient` from `org.eclipse.microprofile.rest.client.inject.RegisterRestClient`.
- Uses standard Jakarta REST annotations on method signatures (`@GET`, `@POST`, `@Path`, `@Produces`, `@Consumes`, `@PathParam`, `@QueryParam`, `@HeaderParam`).
- Ideal for Quarkus, Helidon, Open Liberty, or WildFly applications.

```java
package com.example;

import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;

@RegisterRestClient
public interface PetStoreClient {
  @GET
  @Path("/pets")
  @Produces(MediaType.APPLICATION_JSON)
  java.util.List<Pet> listPets(@QueryParam("limit") Double limit);

  @POST
  @Path("/pets")
  @Produces(MediaType.APPLICATION_JSON)
  @Consumes("application/json")
  Pet createPet(NewPet body);
}
```

## Verification Status

> **Note**: Test suite runs structural/emission unit tests in Bun. One-off compilation and execution has been verified with Java 25 (`javac` and `java` 25.0.4) against standard Jackson, Jakarta Validation, Jakarta WS-RS client, and MicroProfile REST Client APIs.
