// app/lib/admin-health.server.ts
// System health for Home and Settings: worker heartbeats, alerts raised by the
// engine, and the number of failed background jobs when Redis can be reached.
import { readHeartbeats } from "./heartbeat.server";

export type HeartbeatView = {
  key: string;
  at: string;
  kind: "alert" | "worker" | "signal";
  ageMinutes: number;
  stale: boolean;
  detail: string;
};

export type SystemHealth = {
  status: "healthy" | "attention" | "unknown";
  summary: string;
  heartbeats: HeartbeatView[];
  /** null when the queues could not be asked (Redis unreachable or slow). */
  failedJobs: number | null;
};

/** A worker heartbeat older than this means the worker has probably stopped. */
export const WORKER_STALE_MINUTES = 15;
/** Alerts are shown for this long after they were raised. */
export const ALERT_WINDOW_MINUTES = 7 * 24 * 60;

function detailText(detail: Record<string, unknown>): string {
  // Only short scalar values; a heartbeat is not expected to carry personal data,
  // but nothing long or nested is echoed to the page either.
  return Object.entries(detail)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
    .slice(0, 6)
    .join(", ");
}

export function classifyHeartbeats(
  rows: Array<{ key: string; at: string; detail: Record<string, unknown> }>,
  now: Date = new Date(),
): HeartbeatView[] {
  return rows.map((r) => {
    const ageMinutes = Math.max(0, Math.round((now.getTime() - new Date(r.at).getTime()) / 60000));
    // Keys written by the engine: `worker` (liveness), `cron:<job>` (last good run),
    // `cron_failed:<job>` (last failed run) and `alert:<what>`.
    const kind: HeartbeatView["kind"] = r.key.startsWith("alert:") || r.key.startsWith("cron_failed:")
      ? "alert"
      : r.key === "worker" || r.key.startsWith("worker:")
        ? "worker"
        : "signal";
    return {
      key: r.key,
      at: r.at,
      kind,
      ageMinutes,
      stale: kind === "worker" && ageMinutes > WORKER_STALE_MINUTES,
      detail: detailText(r.detail ?? {}),
    };
  });
}

function age(minutes: number): string {
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const h = Math.round(minutes / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function summariseHealth(heartbeats: HeartbeatView[], failedJobs: number | null): Pick<SystemHealth, "status" | "summary"> {
  const workers = heartbeats.filter((h) => h.kind === "worker");
  // A failed job that has since run successfully (`cron:<job>` newer than
  // `cron_failed:<job>`) has recovered and is no longer an alert.
  const recovered = (h: HeartbeatView) => {
    if (!h.key.startsWith("cron_failed:")) return false;
    const good = heartbeats.find((x) => x.key === `cron:${h.key.slice("cron_failed:".length)}`);
    return Boolean(good && good.ageMinutes < h.ageMinutes);
  };
  const alerts = heartbeats.filter((h) => h.kind === "alert" && h.ageMinutes <= ALERT_WINDOW_MINUTES && !recovered(h));
  const parts: string[] = [];
  let status: SystemHealth["status"] = "healthy";

  if (workers.length === 0) {
    status = "unknown";
    parts.push("The points worker has not reported yet.");
  } else {
    const freshest = workers.reduce((a, b) => (a.ageMinutes <= b.ageMinutes ? a : b));
    parts.push(`Points worker last reported ${age(freshest.ageMinutes)}.`);
    if (freshest.stale) status = "attention";
  }
  if (failedJobs === null) parts.push("Failed-job count unavailable.");
  else if (failedJobs === 0) parts.push("No failed jobs.");
  else {
    parts.push(`${failedJobs} failed job${failedJobs === 1 ? "" : "s"}.`);
    status = "attention";
  }
  if (alerts.length > 0) {
    parts.push(`${alerts.length} alert${alerts.length === 1 ? "" : "s"} in the last 7 days.`);
    status = "attention";
  }
  return { status, summary: parts.join(" ") };
}

/** Sum of failed jobs across the queues, or null if Redis does not answer in time. */
export async function countFailedJobs(timeoutMs = 1500): Promise<number | null> {
  try {
    const work = (async () => {
      const q = await import("./queue.server");
      const queues: Array<{ getFailedCount(): Promise<number> }> =
        [q.pointsQueue, q.socialQueue, q.notificationQueue, q.cronQueue].filter(Boolean);
      // The Smile import has its own queue ("smile-import"). It is counted when
      // that module is present; the engine queues are still counted if it is not.
      const imp = await import("./smile-import-queue.server").catch(() => null);
      if (imp?.importQueue) queues.push(imp.importQueue);
      const counts = await Promise.all(queues.map((queue) => queue.getFailedCount()));
      return counts.reduce((a, b) => a + b, 0);
    })();
    work.catch(() => undefined); // a late rejection after the timeout must not go unhandled
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  }
}

/**
 * The worker writes its own failed-job counts into its heartbeat
 * (`worker` → detail.failed = { <queue>: n }). Used when this process cannot
 * ask Redis itself. null when the heartbeat carries no counts.
 */
export function failedFromHeartbeat(
  rows: Array<{ key: string; detail: Record<string, unknown> }>,
): number | null {
  const failed = rows.find((r) => r.key === "worker")?.detail?.failed;
  if (typeof failed === "number" && Number.isFinite(failed)) return failed;
  if (!failed || typeof failed !== "object") return null;
  const counts = Object.values(failed as Record<string, unknown>).filter((v): v is number => typeof v === "number");
  return counts.length ? counts.reduce((a, b) => a + b, 0) : null;
}

export async function getSystemHealth(now: Date = new Date()): Promise<SystemHealth> {
  const [rows, liveFailed] = await Promise.all([
    readHeartbeats().catch((e: unknown) => {
      console.error("[admin] heartbeats unreadable:", e instanceof Error ? e.message : e);
      return null;
    }),
    countFailedJobs(),
  ]);
  if (rows === null) {
    return { status: "unknown", summary: "System health could not be read.", heartbeats: [], failedJobs: liveFailed };
  }
  const failedJobs = liveFailed ?? failedFromHeartbeat(rows);
  const heartbeats = classifyHeartbeats(rows, now);
  return { ...summariseHealth(heartbeats, failedJobs), heartbeats, failedJobs };
}
