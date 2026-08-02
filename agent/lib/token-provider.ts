export type TokenFailure =
  | "access_revoked"
  | "authentication_expired"
  | "rate_limited"
  | "unavailable";

export class TokenProviderError extends Error {
  constructor(readonly reason: TokenFailure) {
    super(reason);
    this.name = "TokenProviderError";
  }
}

export interface TokenProvider {
  getAccessToken(): Promise<string>;
}
