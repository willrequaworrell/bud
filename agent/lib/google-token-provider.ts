import { CalendarAdapterError } from "./calendar.js";
import type { TokenProvider } from "./token-provider.js";

interface GoogleTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  refreshToken: string;
}

export function createGoogleTokenProvider(
  options: GoogleTokenProviderOptions,
): TokenProvider {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { expiresAt: number; token: string } | undefined;

  return {
    async getAccessToken() {
      if (cached && cached.expiresAt > now() + 30_000) return cached.token;
      let response: Response;
      try {
        response = await request("https://oauth2.googleapis.com/token", {
          body: new URLSearchParams({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            grant_type: "refresh_token",
            refresh_token: options.refreshToken,
          }),
          method: "POST",
        });
      } catch {
        throw new CalendarAdapterError("unavailable");
      }
      if (!response.ok) {
        throw new CalendarAdapterError(
          response.status === 400 || response.status === 401
            ? "access_revoked"
            : response.status === 429
              ? "rate_limited"
              : "unavailable",
        );
      }
      const payload = await response.json() as {
        access_token?: string;
        expires_in?: number;
      };
      if (!payload.access_token) {
        throw new CalendarAdapterError("authentication_expired");
      }
      cached = {
        expiresAt: now() + (payload.expires_in ?? 3600) * 1000,
        token: payload.access_token,
      };
      return cached.token;
    },
  };
}
