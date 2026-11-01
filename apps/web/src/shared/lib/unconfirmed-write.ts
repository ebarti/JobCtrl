import { JobCtrlApiError, JobCtrlApiTimeoutError, JobCtrlApiUnconfirmedWriteError } from "@jobctrl/api-client";

/** Report a response that cannot establish that the submitted write was saved. */
export function createUnconfirmedWriteError(method: string, path: string, cause: unknown): Error {
  return new JobCtrlApiUnconfirmedWriteError(method, path, cause);
}

/** A lost response cannot establish whether a write reached the server. */
export function isUnconfirmedWrite(error: unknown): boolean {
  return (error instanceof JobCtrlApiTimeoutError && error.writeOutcomeUnknown)
    || (error instanceof JobCtrlApiError && error.writeOutcomeUnknown)
    || error instanceof JobCtrlApiUnconfirmedWriteError;
}
