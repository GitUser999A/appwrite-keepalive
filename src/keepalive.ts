import { Client, Databases, Permission, Role } from "node-appwrite";
import {
  KEEPALIVE_CONFIG,
  type KeepaliveResult,
  type ProjectConfig,
  type SiteKeepaliveResult,
} from "./types.js";

/** User-Agent string sent on Site HTTP keepalive pings */
const SITE_KEEPALIVE_USER_AGENT =
  "appwrite-keepalive/1.1 (+https://github.com/OthmanAdi/appwrite-keepalive)";

/** Timeout (ms) for HTTP keepalive ping against a deployed Appwrite Site */
const SITE_KEEPALIVE_TIMEOUT_MS = 15_000;

/**
 * Sends an HTTP GET to a deployed Appwrite Sites URL.
 *
 * Appwrite Sites pause logic counts site traffic (HTTP visits) independently
 * of project-level API activity. A single GET per keepalive run is enough to
 * register the site as active and keep it deployed.
 */
async function pingSite(url: string): Promise<SiteKeepaliveResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_KEEPALIVE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": SITE_KEEPALIVE_USER_AGENT,
        "Cache-Control": "no-cache",
      },
    });

    return {
      url,
      success: response.ok,
      status: response.status,
      message: response.ok
        ? `HTTP ${response.status}`
        : `HTTP ${response.status} (treated as failure)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      success: false,
      message: message || "unknown fetch error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes a siteUrls field into a clean array of URLs.
 *
 * Accepts either a single URL string or an array of URL strings. Strips
 * whitespace, drops empty entries, and de-duplicates. Returns an empty array
 * when nothing is configured.
 */
function normalizeSiteUrls(input: ProjectConfig["siteUrls"]): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : [input];
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}

/**
 * Performs a keepalive operation on a single Appwrite project.
 * Creates the keepalive database/collection if they don't exist,
 * then upserts a heartbeat document with the current timestamp.
 */
export async function keepaliveProject(config: ProjectConfig): Promise<KeepaliveResult> {
  const { endpoint, projectId, apiKey, name } = config;
  const timestamp = new Date().toISOString();
  const projectLabel = name || projectId;

  // Run the database-API heartbeat (catches "no development activity" pause)
  // and the Site HTTP heartbeat (catches Sites-traffic-based pause) in
  // parallel so a slow site doesn't delay the database call and vice versa.
  // Both error paths are isolated; one product's failure does not mask the
  // other's success.
  const siteUrls = normalizeSiteUrls(config.siteUrls);
  const [dbResult, siteResults] = await Promise.all([
    runDatabaseHeartbeat({ endpoint, projectId, apiKey, projectLabel, timestamp }),
    siteUrls.length > 0
      ? runSiteHeartbeat(projectLabel, siteUrls)
      : Promise.resolve<SiteKeepaliveResult[]>([]),
  ]);

  // Roll up. Success = database succeeded AND every configured site succeeded.
  // If no sites are configured, success is purely the database result.
  const allSitesOk = siteResults.every((r) => r.success);
  const success = dbResult.success && allSitesOk;
  const messages: string[] = [dbResult.message];
  if (siteResults.length > 0) {
    const okCount = siteResults.filter((r) => r.success).length;
    messages.push(`site keepalive ${okCount}/${siteResults.length} ok`);
  }

  return {
    projectId,
    name,
    success,
    message: messages.join("; "),
    timestamp,
    ...(siteResults.length > 0 ? { siteResults } : {}),
  };
}

interface DatabaseHeartbeatArgs {
  endpoint: string;
  projectId: string;
  apiKey: string;
  projectLabel: string;
  timestamp: string;
}

interface DatabaseHeartbeatResult {
  success: boolean;
  message: string;
}

async function runDatabaseHeartbeat(args: DatabaseHeartbeatArgs): Promise<DatabaseHeartbeatResult> {
  const { endpoint, projectId, apiKey, projectLabel, timestamp } = args;
  try {
    const client = new Client();
    client.setEndpoint(endpoint).setProject(projectId).setKey(apiKey);

    const databases = new Databases(client);
    const { DATABASE_ID, COLLECTION_ID, DOCUMENT_ID } = KEEPALIVE_CONFIG;

    await ensureDatabase(databases);
    await ensureCollection(databases);

    try {
      await databases.updateDocument({
        databaseId: DATABASE_ID,
        collectionId: COLLECTION_ID,
        documentId: DOCUMENT_ID,
        data: { timestamp, source: "github-actions" },
      });
      console.log(`[${projectLabel}] db heartbeat sent at ${timestamp}`);
      return { success: true, message: "db heartbeat sent" };
    } catch (updateError) {
      const updateMessage =
        updateError instanceof Error ? updateError.message : String(updateError);
      if (updateMessage.includes("not be found") || updateMessage.includes("404")) {
        await databases.createDocument({
          databaseId: DATABASE_ID,
          collectionId: COLLECTION_ID,
          documentId: DOCUMENT_ID,
          data: { timestamp, source: "github-actions" },
          permissions: [Permission.read(Role.any())],
        });
        console.log(`[${projectLabel}] db initial heartbeat created at ${timestamp}`);
        return { success: true, message: "db initial heartbeat created" };
      }
      throw updateError;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${projectLabel}] db keepalive failed: ${errorMessage}`);
    return { success: false, message: `db keepalive failed: ${errorMessage}` };
  }
}

async function runSiteHeartbeat(
  projectLabel: string,
  urls: string[],
): Promise<SiteKeepaliveResult[]> {
  // Fire HTTP pings in parallel for multi-site projects so the run stays fast.
  return Promise.all(urls.map((u) => pingSite(u))).then((results) => {
    for (const r of results) {
      const tag = r.success ? "ok" : "FAIL";
      console.log(`[${projectLabel}] site ${tag}: ${r.url} (${r.message})`);
    }
    return results;
  });
}

/**
 * Ensures the keepalive database exists, creates it if not
 */
async function ensureDatabase(databases: Databases): Promise<void> {
  const { DATABASE_ID, DATABASE_NAME } = KEEPALIVE_CONFIG;

  try {
    await databases.get({ databaseId: DATABASE_ID });
  } catch {
    console.log("Creating keepalive database...");
    await databases.create({
      databaseId: DATABASE_ID,
      name: DATABASE_NAME,
    });
    console.log("Database created.");
  }
}

/**
 * Ensures the heartbeats collection exists with proper attributes
 */
async function ensureCollection(databases: Databases): Promise<void> {
  const { DATABASE_ID, COLLECTION_ID, COLLECTION_NAME } = KEEPALIVE_CONFIG;

  try {
    await databases.getCollection({
      databaseId: DATABASE_ID,
      collectionId: COLLECTION_ID,
    });
  } catch {
    console.log("Creating heartbeats collection...");

    // Create collection
    await databases.createCollection({
      databaseId: DATABASE_ID,
      collectionId: COLLECTION_ID,
      name: COLLECTION_NAME,
      permissions: [Permission.read(Role.any()), Permission.write(Role.any())],
      documentSecurity: false,
      enabled: true,
    });

    // Add timestamp attribute
    await databases.createDatetimeAttribute({
      databaseId: DATABASE_ID,
      collectionId: COLLECTION_ID,
      key: "timestamp",
      required: true,
    });

    // Add source attribute
    await databases.createStringAttribute({
      databaseId: DATABASE_ID,
      collectionId: COLLECTION_ID,
      key: "source",
      size: 64,
      required: true,
    });

    // Wait for attributes to be ready (Appwrite processes them async)
    console.log("Waiting for attributes to be ready...");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log("Collection created with attributes.");
  }
}

/**
 * Loads project configurations from environment variables
 */
export function loadProjectsFromEnv(): ProjectConfig[] {
  const projects: ProjectConfig[] = [];

  // Check for multi-project JSON config
  const projectsJson = process.env.APPWRITE_PROJECTS;
  if (projectsJson) {
    try {
      const parsed = JSON.parse(projectsJson) as ProjectConfig[];
      if (Array.isArray(parsed)) {
        projects.push(...parsed);
        console.log(`Loaded ${parsed.length} projects from APPWRITE_PROJECTS`);
        return projects;
      }
    } catch {
      console.error("Failed to parse APPWRITE_PROJECTS JSON");
    }
  }

  // Fall back to single project config
  const endpoint = process.env.APPWRITE_ENDPOINT;
  const projectId = process.env.APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;

  if (endpoint && projectId && apiKey) {
    // Optional site URLs for Appwrite Sites HTTP keepalive. Accepts a
    // comma-separated list so users can keep several deployed sites alive
    // from a single project: APPWRITE_SITE_URLS="https://a.appwrite.network,https://b.appwrite.network"
    const siteUrlsRaw = process.env.APPWRITE_SITE_URLS?.trim();
    const siteUrls = siteUrlsRaw
      ? siteUrlsRaw
          .split(",")
          .map((u) => u.trim())
          .filter((u) => u.length > 0)
      : undefined;
    const config: ProjectConfig = { endpoint, projectId, apiKey };
    if (siteUrls && siteUrls.length > 0) {
      config.siteUrls = siteUrls;
    }
    projects.push(config);
    console.log(
      siteUrls && siteUrls.length > 0
        ? `Loaded single project from env (${siteUrls.length} site URL${siteUrls.length === 1 ? "" : "s"} configured)`
        : "Loaded single project from environment variables",
    );
  }

  return projects;
}
