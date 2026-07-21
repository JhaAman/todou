import { describe, expect, it } from "vitest";
import { normalizeSyncSettings, toNativeShortcut } from "./syncSettings";

describe("sync settings", () => {
  it("normalizes a configured Supabase connection", () => {
    expect(normalizeSyncSettings({
      url: "  http://127.0.0.1:54321/ ",
      publishableKey: " local-key ",
    })).toEqual({
      url: "http://127.0.0.1:54321",
      publishableKey: "local-key",
    });
  });

  it("allows sync to be disabled but rejects half-configured credentials", () => {
    expect(normalizeSyncSettings({ url: "", publishableKey: "" })).toEqual({
      url: "",
      publishableKey: "",
    });
    expect(() => normalizeSyncSettings({ url: "https://example.supabase.co", publishableKey: "" }))
      .toThrow("both");
  });

  it("translates editable UI shortcuts into native accelerators", () => {
    expect(toNativeShortcut("Ctrl+Space")).toBe("Control+Space");
    expect(toNativeShortcut("Meta+Shift+K")).toBe("Command+Shift+K");
  });
});
