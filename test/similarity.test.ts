import { describe, expect, it } from "vitest";
import { similarity } from "../src/tools/similarity.js";

describe("similarity", () => {
  it("is 1 for identical titles ignoring case/punctuation", () => {
    expect(similarity("Call the dentist!", "call dentist")).toBe(1);
  });
  it("is 0 for unrelated titles", () => {
    expect(similarity("Buy milk", "Renew passport")).toBe(0);
  });
  it("is partial for overlapping titles", () => {
    const s = similarity("Buy milk and eggs", "Buy milk");
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(1);
  });
});
