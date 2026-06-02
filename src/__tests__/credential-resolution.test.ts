/**
 * vibe-plugin-ai-openai-compat credential-resolution tests
 *
 * Verifies the provider resolves OPENAI_COMPAT_API_KEY (and the optional
 * OPENAI_COMPAT_BASE_URL) from the agent config bag (`hostServices.getConfig`)
 * when they are NOT present in process.env — the path the frontend writes to —
 * and that the configured base URL is passed through to the OpenAI client.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { HostServices } from "@vibecontrols/plugin-sdk";

// Capture the options the OpenAI constructor is called with so the base URL
// pass-through can be asserted. Cleared in beforeEach.
let lastOpenAIOpts: { apiKey: string; baseURL?: string } | null = null;

mock.module("openai", () => {
  class MockOpenAI {
    constructor(opts: { apiKey: string; baseURL?: string }) {
      lastOpenAIOpts = opts;
    }
  }
  return { default: MockOpenAI };
});

const { createPlugin } = await import("../index.js");

/**
 * `AIAgentProvider` does not surface the optional `setHostServices` lifecycle
 * method, but the concrete provider class implements it. Narrow to a structural
 * type that exposes the methods the tests drive.
 */
interface ProviderWithHost {
  setHostServices(hs: HostServices): void;
  setMode(mode: "sdk" | "cli"): void;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

function getProvider(): ProviderWithHost {
  const plugin = createPlugin({ name: "test", dataDir: "/tmp" });
  return plugin.providers!.ai! as unknown as ProviderWithHost;
}

/**
 * The plugin exports a single shared provider instance, so credential state
 * (the warmed key/base URL, the resolved mode, and the cached adapter/client)
 * leaks between tests. Reset those private fields so each test starts from a
 * cold resolve and genuinely exercises the env → cache → config-bag chain.
 */
function resetProviderState(provider: ProviderWithHost): void {
  const internal = provider as unknown as Record<string, unknown>;
  internal["cachedApiKey"] = undefined;
  internal["cachedBaseUrl"] = undefined;
  internal["hostServices"] = null;
  internal["adapter"] = null;
  internal["activeMode"] = null;
}

/**
 * HostServices whose `getConfig` returns values from `configMap` (and undefined
 * for any other key). Every HostServices field is optional, so the provider's
 * `setHostServices` runs without throwing against this fake.
 */
function makeHostServices(configMap: Record<string, string>): {
  hs: HostServices;
  getConfig: ReturnType<typeof mock>;
} {
  const getConfig = mock((key: string): Promise<string | undefined> => {
    return Promise.resolve(configMap[key]);
  });
  const hs: HostServices = {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    getConfig,
  };
  return { hs, getConfig };
}

describe("openai-compat credential resolution", () => {
  beforeEach(() => {
    delete process.env["OPENAI_COMPAT_API_KEY"];
    delete process.env["OPENAI_COMPAT_BASE_URL"];
    lastOpenAIOpts = null;
    resetProviderState(getProvider());
  });

  it("resolves key + base URL from the config bag and passes baseURL through", async () => {
    const provider = getProvider();
    const baseUrl = "https://compat.example.com/v1";
    const { hs, getConfig } = makeHostServices({
      OPENAI_COMPAT_API_KEY: "cfg-compat-key",
      OPENAI_COMPAT_BASE_URL: baseUrl,
    });

    provider.setHostServices(hs);
    await new Promise((r) => setTimeout(r, 0));
    provider.setMode("sdk");

    const result = await provider.healthCheck();
    expect(result.ok).toBe(true);
    expect(getConfig).toHaveBeenCalled();
    expect(lastOpenAIOpts).not.toBeNull();
    expect(lastOpenAIOpts!.apiKey).toBe("cfg-compat-key");
    expect(lastOpenAIOpts!.baseURL).toBe(baseUrl);
  });

  it("reports ok:false with a /required/ message when no key is available", async () => {
    const provider = getProvider();
    const { hs } = makeHostServices({});

    provider.setHostServices(hs);
    await new Promise((r) => setTimeout(r, 0));
    provider.setMode("sdk");

    const result = await provider.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/required/i);
  });
});
