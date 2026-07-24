export interface AdsData {
  date: string;
  totalMessage?: number;
  totalClick?: number;
  cpr: number;
  totalSpent: number;
  impressions: number;
  reach: number;
  targetAudience?: string;
  adsName?: string;
  location?: string;
  website: string;
  platform: string;
  photoLink?: string;
  recordedBy: string;
  recordedAt: string;
}

export const REQUIRED_FIELDS = [
  "date",
  "cpr",
  "totalSpent",
  "impressions",
  "reach",
  "website",
  "platform",
] as const;

export type RequiredField = (typeof REQUIRED_FIELDS)[number];

// Total Message and Total Click are each optional individually, but at least
// one of the two must be provided — this sentinel key represents that
// combined "either/or" requirement in the missing-field flow.
export const TOTAL_MESSAGE_OR_CLICK_FIELD = "totalMessageOrClick";

export const FIELD_LABELS_TH: Record<string, string> = {
  date: "วันที่ (date)",
  totalMessage: "จำนวนข้อความ (Total Message)",
  totalClick: "จำนวนคลิก (Total Click)",
  cpr: "CPR",
  totalSpent: "ยอดใช้จ่ายรวม (Total Spent)",
  impressions: "Impressions",
  reach: "Reach",
  targetAudience: "กลุ่มเป้าหมาย (Target audience)",
  adsName: "ชื่อโฆษณา (ads name)",
  location: "พื้นที่ (location)",
  website: "ชื่อเว็บ (website)",
  platform: "ช่องทางโฆษณา (platform)",
  [TOTAL_MESSAGE_OR_CLICK_FIELD]: "Total Message หรือ Total Click",
};

export type SessionStep =
  | "idle"
  | "awaiting_field_value"
  | "awaiting_confirmation"
  | "editing_row_select"
  | "editing_field_select"
  | "editing_field_value"
  | "awaiting_delete_confirmation";

export interface PendingEdit {
  sheetName: string;
  spreadsheetId: string;
  rowNumber: number;
  field?: string;
}

export interface UserSession {
  userId: number;
  username?: string;
  chatId?: number;
  defaultWebsite?: string;
  defaultPlatform?: string;
  step: SessionStep;
  pendingData?: Partial<AdsData>;
  missingFields?: string[];
  currentMissingField?: string;
  pendingPhotoFileIds?: string[];
  pendingMediaGroupId?: string;
  confirmationMessageId?: number;
  pendingEdit?: PendingEdit;
  deleteTarget?: { row: number };
  deleteConfirmStage?: number;
}

export type LogAction =
  | "DATA_RECORDED"
  | "DATA_EDITED"
  | "DATA_DELETED"
  | "PHOTO_UPLOADED"
  | "FOLDER_CREATED"
  | "SHEET_CREATED"
  | "ERROR"
  | "USER_COMMAND"
  | "UNAUTHORIZED_ACCESS";

export interface LogEntry {
  timestamp: string;
  action: LogAction;
  user_id: number;
  username?: string;
  website?: string;
  details: string;
  sheet_id?: string;
  row_number?: number;
}

export interface DriveFolderRefs {
  websiteFolderId: string;
  yearFolderId: string;
  monthFolderId: string;
  photosFolderId: string;
}

export interface SheetRow {
  rowNumber: number;
  values: string[];
}
