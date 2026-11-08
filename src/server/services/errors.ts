export interface ErrorBody {
  error: { code: string; message: string };
}

export interface ServiceResult<T> {
  status: number;
  body: T | ErrorBody;
  /** true when the response is an idempotent replay of a stored result. */
  replayed?: boolean;
}

export function failure(status: number, code: string, message: string): ServiceResult<never> {
  return { status, body: { error: { code, message } } };
}
