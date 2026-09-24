import { openapiSchema } from '../../src/index.ts';

export interface User {
  id: number;
  /**
   * @minLength 2
   */
  name: string;
  email?: string;
}

export interface UserQuery {
  /**
   * Free text search
   */
  q?: string;
  limit?: number;
}

export interface UserPathParams {
  id: number;
}

export const apiDoc = openapiSchema<[], '3.0'>(
  {
    info: { title: 'Users API', version: '1.0.0' },
    servers: [{ url: 'http://books.com' }],
  },
  [
    openapiSchema.get<never, UserQuery, User[], never>('/users'),
    openapiSchema.get<UserPathParams, never, User, never>('/users/:id'),
    openapiSchema.patch<UserPathParams, never, User, Partial<User>>('/users/:id', {
      tags: ['User'],
      description: 'Patch a user',
    }),
    openapiSchema.delete<UserPathParams, never, never, never>('/users/:id'),
  ]
);
