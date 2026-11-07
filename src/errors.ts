export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
