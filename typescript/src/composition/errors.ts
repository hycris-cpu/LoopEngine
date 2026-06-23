/**
 * Python-compatible error types for the composition layer.
 *
 * These preserve the exception names from the Python implementation so that
 * callers can distinguish ValueError / KeyError from generic Errors when
 * migrating code or comparing behavior.
 */

/** Error raised when an operation receives an argument with an invalid value. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Error raised when a mapping key is not found. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}
