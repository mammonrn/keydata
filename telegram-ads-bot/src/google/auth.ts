import { google } from "googleapis";
import { config } from "../config";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"];

let authClient: InstanceType<typeof google.auth.OAuth2> | null = null;

export function getAuthClient() {
  if (!authClient) {
    const client = new google.auth.OAuth2(
      config.googleOauthClientId,
      config.googleOauthClientSecret,
      "http://localhost"
    );
    client.setCredentials({ refresh_token: config.googleOauthRefreshToken });
    authClient = client;
  }
  return authClient;
}

export function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getAuthClient() });
}

export function getDriveClient() {
  return google.drive({ version: "v3", auth: getAuthClient() });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, maxRetries = config.googleApiMaxRetries): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(2 ** attempt * 1000);
      }
    }
  }
  throw lastError;
}

export async function throttle(): Promise<void> {
  await sleep(config.googleApiRequestDelayMs);
}
