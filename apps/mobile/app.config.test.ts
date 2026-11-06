import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ ...process.env }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("isolates Custom identity, signing, extensions and updates from upstream", async () => {
  vi.stubEnv("T3CUSTOM_MOBILE", "1");
  vi.stubEnv("T3CODE_RELAY_URL", "https://example.com");
  vi.stubEnv("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", "upstream-key");
  const config = await loadConfig("production");
  const id = "dev.ondravotava.t3custom";
  expect(config.name).toBe("T3 Custom");
  expect(config.scheme).toBe("t3custom");
  expect(config.ios?.bundleIdentifier).toBe(id);
  expect(config.ios?.appleTeamId).toBe("RNT8PBS36F");
  expect(config.ios?.associatedDomains).toEqual([]);
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    `$(AppIdentifierPrefix)${id}`,
  ]);
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.owner).not.toBe("pingdotgg");
  expect(config.extra?.eas.projectId).toBe("f69d40a0-6c47-4990-b1a2-60e0241539e5");
  expect(config.extra?.relay.url).toBeNull();
  expect(config.extra?.clerk.publishableKey).toBeNull();
  expect(config.extra?.eas.observe.endpointUrl).toBe("https://observe.invalid");
  expect(config.plugins).toContainEqual([
    "@clerk/expo",
    { theme: "./clerk-theme.json", appleSignIn: false },
  ]);
  expect(config.plugins).toContainEqual([
    "expo-widgets",
    expect.objectContaining({ bundleIdentifier: `${id}.widgets`, groupIdentifier: `group.${id}` }),
  ]);
  expect(config.plugins).toContainEqual([
    "expo-sharing",
    expect.objectContaining({
      ios: expect.objectContaining({
        extensionBundleIdentifier: `${id}.sharing`,
        appGroupId: `group.${id}`,
      }),
    }),
  ]);
});
