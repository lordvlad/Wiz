import {
  decodeProto,
  encodeProto,
  is,
  keysOf,
  openapiSchema,
  optionalKeysOf,
  protobufSchema,
  requiredKeysOf,
  jsonSchema,
  validate,
  type ValidationError,
} from '../../src/index.ts';

export interface User {
  id: string;
  /**
   * @minLength 2
   */
  name: string;
  /**
   * @minimum 0
   */
  age?: number;
  /**
   * @format email
   */
  email: string;
}
export interface Book {
  id: string;
  title: string;
}
export interface ProtoUser {
  /**
   * A plain `number` is a double; `@format` narrows it to a compact int.
   * @fieldNumber 1
   * @format int32
   */
  id: number;
  /** @fieldNumber 2 */
  name: string;
}

export const userKeys = keysOf<User>();
export const userReqKeys = requiredKeysOf<User>();
export const userOptKeys = optionalKeysOf<User>();
export const userSchema = jsonSchema<User>();
export const apiOpenApiSchema = openapiSchema<[User, Book], '3.0'>({
  info: {
    title: 'Library API',
    version: '1.0.0',
    server: 'http://books.com',
  },
});
export const protoSchemaString = protobufSchema<[ProtoUser]>({ indent: '    ' });

export function checkUserIs(user: unknown): boolean {
  return is<User>(user);
}

export function checkUserValidate(user: unknown): ValidationError[] {
  return validate<User>(user);
}
export function encodeProtoUser(user: ProtoUser, buf: Uint8Array): number {
  return encodeProto<ProtoUser>(user, buf);
}

export function decodeProtoUser(buf: Uint8Array): ProtoUser {
  return decodeProto<ProtoUser>(buf);
}
