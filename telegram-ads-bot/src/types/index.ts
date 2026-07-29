export interface AdsData {
  date: string;
  totalMessage?: number;
  totalClick?: number;
  cpr?: number;
  totalSpent?: number;
  impressions?: number;
  reach?: number;
  views?: number;
  mainBudget?: number;
  runningCampaign?: string;
  joined?: number;
  targetAudience?: string;
  adsName?: string;
  location?: string;
  website: string;
  platform: string;
  photoLink?: string;
  recordedBy: string;
  recordedAt: string;
}

// Every platform reports a different set of numbers, so no metric can be
// required system-wide. Only the three fields that decide *where* a row is
// filed (which Drive folder, which spreadsheet, which tab, which date) are
// mandatory; a record additionally needs at least one actual data field,
// which is enforced separately by hasAnyDataField().
export const REQUIRED_FIELDS = ["date", "website", "platform"] as const;

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
  views: "ยอดวิว (Views)",
  mainBudget: "งบหลัก (Main Budget)",
  runningCampaign: "แคมเปญที่รัน (Running Campaign)",
  joined: "ยอดเข้าร่วม (Joined)",
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
  | "awaiting_duplicate_confirmation"
  | "awaiting_adsname_pick"
  | "awaiting_location_pick"
  | "editing_row_select"
  | "editing_field_select"
  | "editing_field_value"
  | "awaiting_delete_confirmation";

export interface PendingEdit {
  sheetName: string;
  spreadsheetId: string;
  tabName: string;
  sheetId: number;
  rowNumber: number;
  website: string;
  month: string;
  year: string;
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
  pendingPhotosAt?: number;
  pendingMediaGroupId?: string;
  confirmationMessageId?: number;
  /**
   * Set once the user has answered "save it anyway" to a duplicate warning,
   * so the save that follows doesn't re-detect the same duplicate and ask
   * again. Cleared whenever the confirmation screen is shown again, since
   * that means the record may have changed since it was acknowledged.
   */
  duplicateAcknowledged?: boolean;
  pendingEdit?: PendingEdit;
  deleteTarget?: { row: number };
  deleteConfirmStage?: number;
  leftoverLines?: string[];
}

export type LogAction =
  | "DATA_RECORDED"
  | "DATA_EDITED"
  | "DATA_DELETED"
  | "DATA_DUPLICATE"
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
