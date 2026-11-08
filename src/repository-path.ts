export function normalizeRepositoryPath(value: string) {
  return value.replaceAll('\\', '/');
}

export function isRepositoryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0') ||
      value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
