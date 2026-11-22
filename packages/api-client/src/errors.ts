export class JobCtrlApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly responseBody: unknown;
  readonly writeOutcomeUnknown: boolean;

  constructor(status: number, statusText: string, detail?: string, responseBody?: unknown, writeOutcomeUnknown = false) {
    super(
      detail?.trim() || `JobCtrl API request failed: ${status} ${statusText}`,
    );
    this.name = "JobCtrlApiError";
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.writeOutcomeUnknown = writeOutcomeUnknown;
  }
}

/** The request deadline expired before its complete response was received. */
export class JobCtrlApiTimeoutError extends Error {
  readonly method: string;
  readonly path: string;
  readonly timeoutMs: number;
  readonly writeOutcomeUnknown: boolean;

  constructor(method: string, path: string, timeoutMs: number) {
    const writeOutcomeUnknown = method !== "GET";
    super(
      `JobCtrl API request timed out after ${timeoutMs}ms: ${method} ${path}` +
      (writeOutcomeUnknown ? ". The change may have completed; check its current state before retrying." : ""),
    );
    this.name = "JobCtrlApiTimeoutError";
    this.method = method;
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.writeOutcomeUnknown = writeOutcomeUnknown;
  }
}

/** A write was attempted, but the client could not read a complete acknowledgement. */
export class JobCtrlApiUnconfirmedWriteError extends Error {
  readonly method: string;
  readonly path: string;
  readonly writeOutcomeUnknown = true;

  constructor(method: string, path: string, cause: unknown) {
    super(`JobCtrl API could not confirm the response: ${method} ${path}. The change may have completed; check its current state before retrying.`, { cause });
    this.name = "JobCtrlApiUnconfirmedWriteError";
    this.method = method;
    this.path = path;
  }
}
