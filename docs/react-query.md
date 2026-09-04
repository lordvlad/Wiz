# React Query Client Generator

`wiz generate -g reactQuery` turns an OpenAPI document into a React Query client library built on top of `wiz`'s TypeScript HTTP client (`tsClient`).

It emits TanStack React Query (`@tanstack/react-query`) hooks and standalone options getters supporting multi-tenancy, custom options overrides, path/query default `queryKey`s, and cancellation signals.

## Running it

```bash
wiz generate -g reactQuery openapi.json --outdir src/api
```

Or using stdin / stdout:

```bash
cat openapi.yaml | wiz generate -g reactQuery --outdir src/api
```

## What comes out

Running `-g reactQuery` emits five files in your target output directory:

- `model.ts`: TypeScript models for types declared in the document.
- `api.ts`: Base HTTP client, `Client` interface, `createClient`, and interceptor runtime.
- `codec.ts`: Encoders and decoders for JSON payloads.
- `queries.ts`: Options getters and hooks for `GET`, `HEAD`, and `OPTIONS` operations.
- `mutations.ts`: Options getters and hooks for `POST`, `PUT`, `PATCH`, and `DELETE` operations.

`reactQuery` builds on `tsClient`, so its flags apply here too — including
[`--validate`](./typescript-client.md#runtime-validation---validate), which adds
runtime checks to the `api.ts` the hooks call through. A failed check surfaces
as the hook's `error`, so `ClientValidationError` reaches the component the same
way an `ApiError` does. Note the performance tradeoff before enabling
`response`: it walks every payload on every fetch, which is the expensive half.

```bash
wiz generate -g reactQuery openapi.json --outdir src/api --validate path,query,headers,body
```

---

## Query Operations (`queries.ts`)

For operations with read-only HTTP methods (`GET`, `HEAD`, `OPTIONS`), `queries.ts` emits:

1. **Options Getter (`get<OperationName>QueryOptions`)**:
   Returns a `@tanstack/react-query` query options object `{ queryKey, queryFn, ...queryOptions }`. Can be used directly with `queryClient.fetchQuery` or `useQuery`.
   - `queryKey`: `[pathTemplate, options] as const` (e.g. `["/pets/{petId}", options]`).
   - `queryFn`: Automatically forwards request parameters and passes `AbortSignal` for request cancellation.

2. **Query Hook (`use<OperationName>`)**:
   Calls `useQuery(get<OperationName>QueryOptions(options, queryOptions, client))`.

3. **Factory `createQueries(client)`**:
   Returns an object with all query options getters and query hooks pre-bound to a custom `Client` instance.

4. **Multi-Tenancy Factory `createHooks(client)`**:
   Combines `createQueries(client)` and `createMutations(client)` to provide full hook suite pre-bound to a tenant client instance.

Every getter and hook takes the client as a trailing parameter, defaulting to
`defaultClient()` from `api.ts` — the one instance `configure()` maintains.
A default of `createClient()` would build a client per invocation, so a hook
would render against a fresh client and never see `configure()`.

### Query Usage Example

```ts
import { useGetPetByPetId, getGetPetByPetIdQueryOptions, createHooks } from "./queries.ts";
import { createClient } from "./api.ts";

// 1. Direct Hook Usage
function PetView({ petId }: { petId: string }) {
  const { data: pet, isLoading, error } = useGetPetByPetId(
    { path: { petId } },
    { enabled: Boolean(petId), staleTime: 5000 }
  );

  if (isLoading) return <div>Loading...</div>;
  return <div>{pet?.name}</div>;
}

// 2. Standalone Query Options (e.g. for prefetching)
async function prefetchPet(queryClient: QueryClient, petId: string) {
  await queryClient.prefetchQuery(
    getGetPetByPetIdQueryOptions({ path: { petId } })
  );
}

// 3. Multi-Tenancy Client Binding
const tenantClient = createClient({
  baseUrl: "https://tenant-a.api.example.com",
  headers: { "x-tenant-id": "tenant-a" },
});

const tenantHooks = createHooks(tenantClient);

function TenantPetView({ petId }: { petId: string }) {
  const { data } = tenantHooks.useGetPetByPetId({ path: { petId } });
  return <div>{data?.name}</div>;
}
```

---

## Mutation Operations (`mutations.ts`)

For operations with state-changing HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`), `mutations.ts` emits:

1. **Options Getter (`get<OperationName>MutationOptions`)**:
   Returns a `@tanstack/react-query` mutation options object `{ mutationKey, mutationFn, ...mutationOptions }`.
   - `mutationKey`: `[pathTemplate, method] as const` (e.g. `["/pets", "POST"]`).

2. **Mutation Hook (`use<OperationName>`)**:
   Calls `useMutation(get<OperationName>MutationOptions(mutationOptions, client))`.

3. **Factory `createMutations(client)`**:
   Returns an object with all mutation options getters and hooks pre-bound to a custom `Client` instance.

### Mutation Usage Example

```ts
import { useCreatePet, useDeletePet } from "./mutations.ts";

function CreatePetForm() {
  const createPet = useCreatePet({
    onSuccess: (newPet) => {
      console.log("Pet created successfully:", newPet);
    },
    onError: (err) => {
      console.error("Failed to create pet:", err);
    },
  });

  const handleSubmit = (name: string) => {
    createPet.mutate({ body: { name } });
  };

  return (
    <button
      disabled={createPet.isPending}
      onClick={() => handleSubmit("Fido")}
    >
      {createPet.isPending ? "Saving..." : "Add Pet"}
    </button>
  );
}
```
