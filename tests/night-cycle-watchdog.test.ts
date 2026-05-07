/**
 * bug-2-night-cycle-watchdog: hung cycle.run() must not pin running=true forever.
 * Verifies watchdog timeout fires, resets running flag, and records abortedReason.
 */
import { describe, expect, test } from "bun:test";
import type { NightCycle, NightCycleResult } from "@subbrain/agent/pipeline";
import { NightCycleController } from "../packages/server/src/app/night-cycle-controller";

function makeHangCycle(): NightCycle {
  return {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: never-resolves by design (hang simulation)
    run: () => new Promise<NightCycleResult>(() => {}),
  } as unknown as NightCycle;
}

function makeFastCycle(result: Partial<NightCycleResult>): NightCycle {
  return {
    run: async () => ({ archiveEntriesCreated: 0, errors: [], ...result }) as NightCycleResult,
  } as unknown as NightCycle;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("NightCycleController watchdog", () => {
  test("watchdog fires when cycle.run hangs — resets running, sets abortedReason", async () => {
    const ctrl = new NightCycleController(makeHangCycle(), 50);
    const trig = ctrl.trigger("scheduled");
    expect(trig.started).toBe(true);
    expect(ctrl.running).toBe(true);

    // Wait past timeout + a few ticks for the race to settle.
    await sleep(120);

    expect(ctrl.running).toBe(false);
    expect(ctrl.lastResult).not.toBeNull();
    const res = ctrl.lastResult as { abortedReason?: string; timeoutMs?: number };
    expect(res.abortedReason).toBe("watchdog");
    expect(res.timeoutMs).toBe(50);
  });

  test("watchdog does NOT fire when cycle.run completes in time", async () => {
    const ctrl = new NightCycleController(makeFastCycle({ archiveEntriesCreated: 3 }), 5_000);
    ctrl.trigger("http");
    // Yield microtasks so the async run resolves.
    await sleep(20);
    expect(ctrl.running).toBe(false);
    const res = ctrl.lastResult as { archiveEntriesCreated?: number; abortedReason?: string };
    expect(res.archiveEntriesCreated).toBe(3);
    expect(res.abortedReason).toBeUndefined();
  });

  test("second trigger blocked while first still running, then unblocked after watchdog", async () => {
    const ctrl = new NightCycleController(makeHangCycle(), 60);
    const t1 = ctrl.trigger("scheduled");
    expect(t1.started).toBe(true);

    const t2 = ctrl.trigger("scheduled");
    expect(t2.started).toBe(false);
    expect(t2.reason).toBe("already_running");

    await sleep(120);
    expect(ctrl.running).toBe(false);

    // After watchdog, controller is releasable.
    const t3 = ctrl.trigger("scheduled");
    expect(t3.started).toBe(true);
    // Cleanup: wait second hang's watchdog so timers don't leak past test.
    await sleep(120);
    expect(ctrl.running).toBe(false);
  });

  test("default timeout falls back to 30 min when not specified", () => {
    const ctrl = new NightCycleController(makeFastCycle({}));
    // Internal default not exposed — assert by behavior: trigger doesn't immediately fail.
    const t = ctrl.trigger("http");
    expect(t.started).toBe(true);
  });
});
