/**
 * EngineFsm 单测 · W2-03
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngineFsm } from "../../../src/fsm/engineFsm";
import type { FsmTransitionEvent } from "../../../src/fsm/types";

describe("EngineFsm · construction", () => {
  it("starts at idle, turn=0, no halt", () => {
    const fsm = new EngineFsm();
    const snap = fsm.snapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.turn).toBe(0);
    expect(snap.lastHalt).toBeNull();
    expect(typeof snap.enteredAt).toBe("number");
  });
});

describe("EngineFsm · transitions", () => {
  let fsm: EngineFsm;
  beforeEach(() => {
    fsm = new EngineFsm();
  });

  it("beginTurn increments turn and transitions to planning", () => {
    fsm.beginTurn();
    expect(fsm.snapshot()).toMatchObject({ phase: "planning", turn: 1 });
    fsm.beginTurn();
    expect(fsm.snapshot().turn).toBe(2);
  });

  it("walks idle → planning → executing → reflecting → halted", () => {
    fsm.beginTurn();
    fsm.enterExecuting();
    expect(fsm.currentPhase()).toBe("executing");
    fsm.enterReflecting();
    expect(fsm.currentPhase()).toBe("reflecting");
    fsm.halt("completed", "success", { message: "ok" });
    expect(fsm.isHalted()).toBe(true);
    expect(fsm.snapshot().lastHalt).toMatchObject({
      reason: "completed",
      completion: "success",
      message: "ok",
      turn: 1,
    });
  });

  it("halt records turn, traceId, message, occurredAt", () => {
    fsm.beginTurn();
    fsm.beginTurn();
    fsm.halt("approval-required", "blocked", {
      message: "user must approve",
      traceId: "trace-abc",
    });
    const halt = fsm.snapshot().lastHalt!;
    expect(halt.reason).toBe("approval-required");
    expect(halt.completion).toBe("blocked");
    expect(halt.message).toBe("user must approve");
    expect(halt.traceId).toBe("trace-abc");
    expect(halt.turn).toBe(2);
    expect(typeof halt.occurredAt).toBe("number");
  });

  it("resetToIdle transitions to idle but preserves lastHalt and turn", () => {
    fsm.beginTurn();
    fsm.halt("user-cancelled", "abandoned");
    fsm.resetToIdle();
    const snap = fsm.snapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.turn).toBe(1); // turn 不重置
    expect(snap.lastHalt?.reason).toBe("user-cancelled"); // halt 保留
  });

  it("snapshot returns a copy (mutating does not leak)", () => {
    fsm.beginTurn();
    fsm.halt("completed", "success", { message: "x" });
    const snap = fsm.snapshot();
    snap.lastHalt!.message = "tampered";
    expect(fsm.snapshot().lastHalt!.message).toBe("x");
  });

  it("compacting/awaiting are first-class phases", () => {
    fsm.beginTurn();
    fsm.enterCompacting();
    expect(fsm.currentPhase()).toBe("compacting");
    fsm.enterAwaiting();
    expect(fsm.currentPhase()).toBe("awaiting");
  });
});

describe("EngineFsm · listeners", () => {
  it("notifies listener on every transition with from/to", () => {
    const fsm = new EngineFsm();
    const events: FsmTransitionEvent[] = [];
    fsm.on((ev) => events.push(ev));

    fsm.beginTurn();
    fsm.enterExecuting();
    fsm.halt("tool-failure", "failed", { message: "boom" });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ from: "idle", to: "planning" });
    expect(events[1]).toMatchObject({ from: "planning", to: "executing" });
    expect(events[2]).toMatchObject({ from: "executing", to: "halted" });
    expect(events[2]!.halt?.reason).toBe("tool-failure");
  });

  it("unsubscribes via returned disposer", () => {
    const fsm = new EngineFsm();
    const events: FsmTransitionEvent[] = [];
    const off = fsm.on((ev) => events.push(ev));
    fsm.beginTurn();
    off();
    fsm.enterExecuting();
    expect(events).toHaveLength(1);
  });

  it("listener errors do not break other listeners or transitions", () => {
    const fsm = new EngineFsm();
    const ok: FsmTransitionEvent[] = [];
    fsm.on(() => {
      throw new Error("listener boom");
    });
    fsm.on((ev) => ok.push(ev));
    fsm.beginTurn();
    expect(ok).toHaveLength(1);
    expect(fsm.currentPhase()).toBe("planning");
  });

  it("supports vi.fn spies", () => {
    const fsm = new EngineFsm();
    const spy = vi.fn();
    fsm.on(spy);
    fsm.beginTurn();
    fsm.halt("max-turns", "partial");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0].halt?.reason).toBe("max-turns");
  });
});
