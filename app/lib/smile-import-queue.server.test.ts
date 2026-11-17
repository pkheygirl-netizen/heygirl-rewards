import { describe, expect, it, vi } from "vitest";

vi.mock("./queue.server", async () => ({ ...(await import("./testing/harness")).queueModule(), DEFAULT_JOB_OPTIONS: {} }));
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public name: string) {}
    getFailedCount = async () => 3;
  },
}));

import {
  IMPORT_QUEUE_NAME, enqueueImportJob, failedImportJobCount, importJobBusy, importJobId, importQueue, type ImportQueueLike,
} from "./smile-import-queue.server";

function fakeQueue(states: Record<string, string> = {}) {
  const added: Array<{ name: string; id: string }> = [];
  const removed: string[] = [];
  const queue: ImportQueueLike = {
    getJob: async (id) => (states[id] ? { getState: async () => states[id], remove: async () => { removed.push(id); delete states[id]; } } : null),
    add: async (name, _data, opts) => { added.push({ name, id: String(opts?.jobId) }); states[String(opts?.jobId)] = "waiting"; },
  };
  return { queue, added, removed };
}

describe("import queue (I3, I8)", () => {
  it("exports the queue name and a failed-job count for the health card", async () => {
    expect(IMPORT_QUEUE_NAME).toBe("smile-import");
    expect((importQueue as unknown as { name: string }).name).toBe(IMPORT_QUEUE_NAME);
    expect(await failedImportJobCount()).toBe(3);
  });

  it("uses one fixed job id per run and phase", async () => {
    const { queue, added } = fakeQueue();
    expect(await enqueueImportJob("plan", "run-1", queue)).toEqual({ queued: true });
    expect(added).toEqual([{ name: "plan", id: importJobId("plan", "run-1") }]);
    expect(importJobId("execute", "run-1")).toBe("import-execute-run-1");
  });

  it.each(["active", "waiting", "delayed"])("does not queue a second job while one is %s", async (state) => {
    const { queue, added } = fakeQueue({ "import-execute-run-1": state });
    expect(await importJobBusy("run-1", queue)).toBe(true);
    expect(await enqueueImportJob("execute", "run-1", queue)).toEqual({ queued: false });
    expect(added).toHaveLength(0);
  });

  it.each(["failed", "completed"])("replaces a %s job that would otherwise block the id", async (state) => {
    const { queue, added, removed } = fakeQueue({ "import-execute-run-1": state });
    expect(await importJobBusy("run-1", queue)).toBe(false);
    expect(await enqueueImportJob("execute", "run-1", queue)).toEqual({ queued: true });
    expect(removed).toEqual(["import-execute-run-1"]);
    expect(added).toHaveLength(1);
  });
});
