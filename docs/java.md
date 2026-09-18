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

---

## Type Mapping & Schemas

### 1. Enums
OpenAPI string/number enums are emitted as type-safe Java enums equipped with Jackson serialization and creator methods:
- `@JsonValue` on `getValue()` guarantees exact wire value preservation.
- `@JsonCreator` on `fromValue(...)` handles dynamic parsing and deserialization.

```java
package com.example.model;

import com.fasterxml.jackson.annotation.JsonValue;
import com.fasterxml.jackson.annotation.JsonCreator;

public enum Status {
  ACTIVE("active"),
  PENDING("pending"),
  ARCHIVED("archived");

  private final Object value;

  Status(Object value) {
    this.value = value;
  }

  @JsonValue
  public Object getValue() {
    return this.value;
  }

  @JsonCreator
  public static Status fromValue(Object value) {
    for (Status b : Status.values()) {
      if (java.util.Objects.equals(b.value, value)) {
        return b;
      }
    }
    throw new IllegalArgumentException("Unexpected value '" + value + "'");
  }
}
```

### 2. Unions & Polymorphism
TypeScript and OpenAPI union types (`oneOf`, `anyOf`) and discriminated unions map to Java type hierarchies:

#### Untyped / Ad-hoc Unions
Unions of arbitrary unrelated types (e.g. `string | number`) map to `Object` or container classes to allow heterogeneous JSON payloads.

#### Discriminated Polymorphism
When models define an OpenAPI `discriminator.propertyName` across `oneOf` schemas (e.g. `Pet` with `Cat` and `Dog` variants), polymorphism is expressed using Jackson sub-type annotations or sealed interfaces:
- **Base Type**: Decorated with Jackson `@JsonTypeInfo` and `@JsonSubTypes`.
- **Subtypes**: Extended or implemented by the variant Records or POJOs.

```java
// Base interface / class
@JsonTypeInfo(
  use = JsonTypeInfo.Id.NAME,
  include = JsonTypeInfo.As.PROPERTY,
  property = "petType"
)
@JsonSubTypes({
  @JsonSubTypes.Type(value = Dog.class, name = "dog"),
  @JsonSubTypes.Type(value = Cat.class, name = "cat")
})
public sealed interface Pet permits Dog, Cat {
  String name();
}

// Sealed variant record
public record Dog(String name, Double barkVolume) implements Pet {}
```

---

## Client Operations & HTTP Behaviors

### 1. Multiple Media Types & Variant Method Naming

When an OpenAPI operation declares multiple request or response content representations (e.g. `application/json` and `application/xml` under `responses.200.content`, or `multipart/form-data` vs `application/json` under `requestBody.content`), `wiz` generates distinct, type-safe method variants:

#### Method Naming Convention
- **Single Representation**: Uses the standard operation name (e.g. `getPetById(...)`, `uploadFile(...)`).
- **Multiple Representations**: Appends a media-type suffix (`AsJson`, `AsXml`, `AsYaml`, `AsFormData`, `AsOctetStream`, `AsText`, etc.) to distinguish the variants:
  - `getPetByIdAsJson(...)` — Requests `Accept: application/json`
  - `getPetByIdAsXml(...)` — Requests `Accept: application/xml`

#### Jakarta REST Client Implementation
In Jakarta REST clients, the request builder applies the exact target `Accept` header and `Entity` content type:
```java
// JSON variant
public Pet getPetByIdAsJson(String petId) {
  WebTarget resource = this.target.path("/pets/{petId}").resolveTemplate("petId", petId);
  return resource.request("application/json").get(Pet.class);
}

// XML variant
public Pet getPetByIdAsXml(String petId) {
  WebTarget resource = this.target.path("/pets/{petId}").resolveTemplate("petId", petId);
  return resource.request("application/xml").get(Pet.class);
}
```

#### MicroProfile REST Client Implementation
In MicroProfile REST client interfaces (`@RegisterRestClient`), separate method declarations are generated with their respective `@Produces` and `@Consumes` annotations:
```java
@RegisterRestClient
public interface PetStoreClient {
  @GET
  @Path("/pets/{petId}")
  @Produces("application/json")
  Pet getPetByIdAsJson(@PathParam("petId") String petId);

  @GET
  @Path("/pets/{petId}")
  @Produces("application/xml")
  Pet getPetByIdAsXml(@PathParam("petId") String petId);
}
```

### 2. Status Codes & Error Handling
OpenAPI responses define both success codes and error responses:
- **Success Statuses (`200 OK`, `201 Created`, `202 Accepted`)**: Unwrapped directly into the declared return type (`Pet`, `List<Pet>`, etc.).
- **No-Content Statuses (`204 No Content`)**: Generated with `void` return type using `Response.class` consumption and automatic stream closure.
- **Error Statuses (`400`, `404`, `500`)**:
  - In Jakarta REST client: Responses with HTTP status `>= 400` can be captured via `WebApplicationException` or inspected directly on standard `Response`.
  - In MicroProfile REST client: Exceptions are mapped using MicroProfile `ResponseExceptionMapper` providers or standard `WebApplicationException` sub-classes (`NotFoundException`, `BadRequestException`, etc.).

---

## Client Styles

### 1. Jakarta REST Client (`client: "jakarta"`, default)
Emits a typed implementation class implementing `java.lang.AutoCloseable`:
- Built on standard Jakarta REST Client APIs (`jakarta.ws.rs.client.Client`, `ClientBuilder`, `WebTarget`, `Entity`, `GenericType`).
- Automatically manages path template resolution, query parameters, headers, and request bodies.
- Handles generic and collection responses (`java.util.List<T>`, etc.) using `new GenericType<...>() {}`.

```java
try (PetStoreClient client = new PetStoreClient("https://api.petstore.com")) {
  List<Pet> pets = client.listPets(10.0);
  Pet created = client.createPet(new NewPet("Fido"));
}
```

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

---

## Verification Status

> **Note**: Test suite runs structural/emission unit tests in Bun. One-off compilation and execution has been verified with Java 25 (`javac` and `java` 25.0.4) against standard Jackson, Jakarta Validation, Jakarta WS-RS client, and MicroProfile REST Client APIs.
