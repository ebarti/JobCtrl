export interface RequestIdentityPort {
  create(): string;
  /** Opaque equality check for exact retry input; never persist the input itself. */
  fingerprint(value: string): Promise<string>;
}
