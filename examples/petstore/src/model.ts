/**
 * The domain, and the only place any of it is written down.
 *
 * Every wire format in this example is derived from these declarations at
 * compile time: the OpenAPI document, the AsyncAPI document, the OpenRPC
 * document, the `.proto` messages and the protobuf codec. Nothing here is
 * repeated in a schema file, because there are no schema files to repeat it in.
 *
 * `@fieldNumber` is the one thing the types cannot imply: protobuf field
 * numbers are the wire contract, so they have to be stated.
 */

/** What kind of animal. Ordinals are the protobuf enum values. */
export enum Species {
  Unknown = 0,
  Dog = 1,
  Cat = 2,
  Bird = 3,
}

/** Where a pet is in its journey through the store. */
export enum PetStatus {
  Available = 0,
  Pending = 1,
  Sold = 2,
}

export interface Owner {
  /**
   * @fieldNumber 1
   * @format uuid
   */
  id: string;

  /**
   * @fieldNumber 2
   * @minLength 1
   * @maxLength 120
   */
  name: string;

  /**
   * @fieldNumber 3
   * @format email
   */
  email: string;
}

export interface Pet {
  /**
   * @fieldNumber 1
   * @format int32
   * @minimum 1
   */
  id: number;

  /**
   * The pet's call name.
   * @fieldNumber 2
   * @minLength 1
   * @maxLength 80
   * @example "Ada"
   */
  name: string;

  /** @fieldNumber 3 */
  species: Species;

  /** @fieldNumber 4 */
  status: PetStatus;

  /**
   * Retail price in minor units, so no float ever touches money.
   * @fieldNumber 5
   * @format int64
   */
  priceCents: bigint;

  /**
   * @fieldNumber 6
   * @maxItems 16
   */
  tags: string[];

  /** Absent while the pet is still available. @fieldNumber 7 */
  owner?: Owner;

  /** @fieldNumber 8 */
  addedAt: Date;
}

/** The body accepted when creating a pet: the store assigns `id` and `addedAt`. */
export interface NewPet {
  /**
   * @fieldNumber 1
   * @minLength 1
   * @maxLength 80
   */
  name: string;

  /** @fieldNumber 2 */
  species: Species;

  /**
   * @fieldNumber 3
   * @format int64
   */
  priceCents: bigint;

  /** @fieldNumber 4 */
  tags?: string[];
}

/** The body accepted when selling a pet. */
export interface Sale {
  /**
   * @fieldNumber 1
   * @format uuid
   */
  ownerId: string;

  /**
   * @fieldNumber 2
   * @minLength 1
   */
  ownerName: string;

  /**
   * @fieldNumber 3
   * @format email
   */
  ownerEmail: string;
}

export interface PetQuery {
  /** Restrict to one status. */
  status?: PetStatus;

  /** Substring match on the name, case-insensitive. */
  q?: string;

  /**
   * @minimum 1
   * @maximum 100
   * @default 20
   */
  limit?: number;
}

export interface Problem {
  /** @minLength 1 */
  detail: string;

  /** @format int32 */
  status: number;
}

/** What changed. The discriminant of {@link PetChanged}. */
export enum ChangeKind {
  Created = 0,
  Updated = 1,
  Sold = 2,
}

/**
 * A change event, as published to the `petstore.pets.changed` topic and as
 * consumed back off it.
 *
 * The consumer feeds these to `PetStore.applyChange`, so one declaration is the
 * producer's payload, the consumer's parameter and the AsyncAPI message.
 */
export interface PetChanged {
  /**
   * @fieldNumber 1
   * @format uuid
   */
  eventId: string;

  /** @fieldNumber 2 */
  kind: ChangeKind;

  /**
   * @fieldNumber 3
   * @format int32
   */
  petId: number;

  /** The pet as it now stands. @fieldNumber 4 */
  pet: Pet;

  /** @fieldNumber 5 */
  occurredAt: Date;
}
