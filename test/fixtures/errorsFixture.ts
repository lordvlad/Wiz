import { openapiDocument } from '../../src/index.ts';

export interface User {
  id: number;
  name: string;
}

export interface NotFound {
  message: string;
}

export interface RateLimited {
  retryAfter: number;
}

export interface UserService {
  /**
   * @get /users/{id}
   * @response 200 User
   * @response 404 No such user NotFound
   * @response 429 Slow down RateLimited
   * @response default Anything else
   */
  getUser(params: { path: { id: number } }): Promise<User>;
}

/** Resolved at build time; the test reads it from here. */
export const document = openapiDocument<[UserService]>({
  openapi: '3.1.0',
  info: { title: 'Users', version: '1.0.0' },
});
