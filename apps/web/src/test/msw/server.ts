import type { RequestHandler } from "msw";
import { setupServer } from "msw/node";

let defaultHandlers: readonly RequestHandler[] = [];
let resetFixtureState: (() => void) | undefined;

export const server = setupServer();

export function installDefaultHandlers(
  handlers: readonly RequestHandler[],
  resetState: () => void,
): void {
  defaultHandlers = handlers;
  resetFixtureState = resetState;
  resetTestHandlers();
}

export function resetTestHandlers(): void {
  server.resetHandlers(...defaultHandlers);
  resetFixtureState?.();
}
