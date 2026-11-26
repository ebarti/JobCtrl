/** A private browser transport cursor pairs the database instance and event position. */
export function isStreamCursor(cursor: string): boolean {
  return /^(?:[a-f0-9]{64}:)?[0-9]{1,19}$/.test(cursor);
}

export function cursorDatabase(cursor: string): string | undefined {
  return cursor.length > 64 ? cursor.slice(0, 64) : undefined;
}
