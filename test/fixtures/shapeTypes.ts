import type { NumberedUnion } from '../../src/index.ts';

export interface Circle {
  /** @fieldNumber 1 */
  kind: 'circle';
  /**
   * @fieldNumber 2
   * @format float
   */
  radius: number;
}

export interface Square {
  /** @fieldNumber 1 */
  kind: 'square';
  /**
   * @fieldNumber 2
   * @format float
   */
  side: number;
}

/** Imported by name elsewhere, so the alias must be followed across modules. */
export type Shape = NumberedUnion<{ 2: Circle; 3: Square }>;
