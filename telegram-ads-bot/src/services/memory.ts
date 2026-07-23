import fs from "fs";
import path from "path";
import { UserSession } from "../types";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

const sessions = new Map<number, UserSession>();

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadSessions(): void {
  ensureDataDir();
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as UserSession[];
    for (const s of parsed) {
      sessions.set(s.userId, { ...s, step: "idle", pendingData: undefined, missingFields: undefined, currentMissingField: undefined, pendingEdit: undefined, deleteTarget: undefined, deleteConfirmStage: undefined });
    }
  } catch {
    // ignore corrupted backup, start fresh
  }
}

function persistSessions(): void {
  ensureDataDir();
  const all = Array.from(sessions.values());
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2), "utf-8");
}

loadSessions();

export function getSession(userId: number): UserSession {
  let session = sessions.get(userId);
  if (!session) {
    session = { userId, step: "idle" };
    sessions.set(userId, session);
  }
  return session;
}

export function updateSession(userId: number, patch: Partial<UserSession>): UserSession {
  const session = getSession(userId);
  Object.assign(session, patch);
  sessions.set(userId, session);
  persistSessions();
  return session;
}

export function resetSessionFlow(userId: number): UserSession {
  return updateSession(userId, {
    step: "idle",
    pendingData: undefined,
    missingFields: undefined,
    currentMissingField: undefined,
    pendingPhotoFileId: undefined,
    confirmationMessageId: undefined,
    pendingEdit: undefined,
    deleteTarget: undefined,
    deleteConfirmStage: undefined,
  });
}

export function setDefaultWebsite(userId: number, website: string): void {
  updateSession(userId, { defaultWebsite: website });
}

export function setDefaultPlatform(userId: number, platform: string): void {
  updateSession(userId, { defaultPlatform: platform });
}
