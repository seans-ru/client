import { describe, expect, it, vi } from "vitest";
import { createChromeControl } from "../src/features/player/extensions/chromeControl";

describe("createChromeControl", () => {
  it("starts visible and reports hidden state", () => {
    const control = createChromeControl();
    expect(control.isHidden()).toBe(false);
    control.setHidden(true);
    expect(control.isHidden()).toBe(true);
    control.setHidden(false);
    expect(control.isHidden()).toBe(false);
  });

  it("notifies subscribers on change only", () => {
    const control = createChromeControl();
    const seen: boolean[] = [];
    control.subscribe(() => seen.push(control.isHidden()));
    control.setHidden(true);
    control.setHidden(true); // no change -> no notification
    control.setHidden(false);
    expect(seen).toEqual([true, false]);
  });

  it("unsubscribe stops notifications", () => {
    const control = createChromeControl();
    const cb = vi.fn();
    const unsubscribe = control.subscribe(cb);
    control.setHidden(true);
    unsubscribe();
    unsubscribe(); // idempotent
    control.setHidden(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("reset restores visibility and keeps subscriptions live", () => {
    const control = createChromeControl();
    const cb = vi.fn();
    control.subscribe(cb);
    control.setHidden(true);
    control.reset();
    expect(control.isHidden()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(2); // hidden + reset
    control.setHidden(true);
    expect(cb).toHaveBeenCalledTimes(3);
  });
});
