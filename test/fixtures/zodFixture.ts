import { zodSchema } from '../../src/index.ts';

export interface ZodUser {
  /** @minLength 2 */
  id: string;
  age?: number;
  tags: string[];
  kind: 'a' | 'b';
}

export const userZod = zodSchema<ZodUser>();
