/** A failure the user can act on. `status` maps to the HTTP response. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} was not found.`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const invalid = (message: string, details?: unknown) => new AppError(422, 'invalid', message, details);
export const forbidden = (message = 'You do not have access to this.') => new AppError(403, 'forbidden', message);

/** Turns PostgreSQL constraint errors into readable conflicts instead of 500s. */
export function fromDbError(e: unknown): AppError | null {
  const err = e as { code?: string; message?: string; constraint?: string };
  if (!err || typeof err.code !== 'string') return null;
  const msg = err.message ?? 'The change conflicts with existing data.';
  switch (err.code) {
    case '23505': return conflict('duplicate', 'This record already exists.', { constraint: err.constraint });
    case '23P01': return conflict('overlap', 'This period overlaps an existing one.', { constraint: err.constraint });
    case '23503': return conflict('reference', 'This refers to something that does not exist or is still in use.', { constraint: err.constraint });
    case '23514': return conflict('rule', msg.replace(/^.*?: /, ''), { constraint: err.constraint });
    case '40001': return conflict('retry', 'Someone else changed this at the same time. Please try again.');
    // A value in the wrong form: an ID that is not one (from an address or a stale link) is simply
    // not found; anything else (a date, a number) is the caller's to correct.
    case '22P02': return /uuid/i.test(msg) ? new AppError(404, 'not_found', 'Not found. The link may be old or mistyped.') : invalid('A value is not in the right form.');
    case '22007': case '22008': return invalid('A date is not valid.');
    case '22003': return invalid('A number is too large.');
    case '22001': return invalid('A value is too long.');
    default: return null;
  }
}
