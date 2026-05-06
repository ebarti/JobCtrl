export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminant: ${String(value)}`);
}
