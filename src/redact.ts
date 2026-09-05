export function createRedactor(secrets: readonly (string | null | undefined)[]): (message: string) => string {
  const values = [...new Set(secrets.filter((value): value is string => typeof value === 'string' && value.length > 0))];
  if (values.length === 0) return (message) => message;
  values.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (message) => message.replace(pattern, '[REDACTED]');
}
