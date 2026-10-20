import { describe, expect, it } from "vitest";
import { clock, remaining } from "./api";
import type { Timer } from "./api";

describe("countdown display", () => {
  it("uses elapsed monotonic time rather than assuming one tick per second", () => {
    const timer = {
      status: "running",
      remaining_seconds: 60,
      sampledAt: 1000,
    } as Timer;
    expect(remaining(timer, 36500)).toBe(24.5);
    expect(remaining(timer, 90000)).toBe(0);
  });
  it("does not decrement paused timers", () => {
    expect(
      remaining(
        { status: "paused", remaining_seconds: 20, sampledAt: 0 } as Timer,
        50000,
      ),
    ).toBe(20);
  });
  it("formats zero, partial seconds and hour-long tasks", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(59.1)).toBe("01:00");
    expect(clock(3661)).toBe("1:01:01");
  });
});
