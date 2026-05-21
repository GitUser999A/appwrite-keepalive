/**
 * Configuration for a single Appwrite project
 */
export interface ProjectConfig {
  /** Appwrite API endpoint (e.g., https://cloud.appwrite.io/v1) */
  endpoint: string;
  /** Appwrite project ID */
  projectId: string;
  /** Appwrite API key with database permissions */
  apiKey: string;
  /** Optional friendly name for logging */
  name?: string;
  /**
   * Optional deployed Appwrite Sites URL(s) to ping with HTTP GET.
   *
   * Appwrite Sites can pause independently of project-level pause based on
   * site traffic rather than API/database activity. Adding the deployed site
   * URL here makes the keepalive send an HTTP GET on every run so the site
   * receives a visit and stays active.
   *
   * Accepts a single URL or an array. Examples:
   *   "https://my-app.appwrite.network"
   *   ["https://site-a.appwrite.network", "https://site-b.appwrite.network"]
   */
  siteUrls?: string | string[];
}

/**
 * Result of a keepalive operation for a single project
 */
export interface KeepaliveResult {
  projectId: string;
  name?: string;
  success: boolean;
  message: string;
  timestamp: string;
  /** HTTP keepalive results, one per configured site URL (empty if no siteUrls set) */
  siteResults?: SiteKeepaliveResult[];
}

/**
 * Result of an HTTP keepalive ping to a single deployed Appwrite Sites URL
 */
export interface SiteKeepaliveResult {
  url: string;
  success: boolean;
  status?: number;
  message: string;
}

/**
 * Database and collection IDs used by appwrite-keepalive
 */
export const KEEPALIVE_CONFIG = {
  DATABASE_ID: "keepalive",
  DATABASE_NAME: "Keepalive",
  COLLECTION_ID: "heartbeats",
  COLLECTION_NAME: "Heartbeats",
  DOCUMENT_ID: "status",
} as const;
