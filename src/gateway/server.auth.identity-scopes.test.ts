import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openTailscaleWs,
  openWs,
  rpcReq,
  testState,
  testTailscaleWhois,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks();

await import("./server.js");

const BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "admin@example.com",
};

function deviceIdentityPath(label: string): string {
  return path.join(os.tmpdir(), `openclaw-${label}-${randomUUID()}.sqlite`);
}

async function configureGatewayAuth(auth: GatewayAuthConfig): Promise<void> {
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

function responseScopes(response: Awaited<ReturnType<typeof connectReq>>): string[] | undefined {
  return (response.payload as { auth?: { scopes?: string[] } } | undefined)?.auth?.scopes;
}

describe("gateway identity scope grants", () => {
  test("unions a case-insensitive trusted-proxy identity grant without changing pairing", async () => {
    await configureGatewayAuth({
      mode: "trusted-proxy",
      identityScopes: { "admin@example.com": ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    });
    const identityPath = deviceIdentityPath("identity-scope-device");
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, {
        ...TRUSTED_PROXY_HEADERS,
        "x-forwarded-user": "Admin@Example.com",
      });
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: ["operator.read"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: identityPath,
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.read", "operator.admin"]);

        const admin = await rpcReq(ws, "set-heartbeats", { enabled: false });
        expect(admin.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.approvedScopes).toEqual(["operator.read"]);
    const pairing = await listDevicePairing();
    expect(pairing.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);
  });

  test("applies a trusted-proxy grant after clearing device-less self-declared scopes", async () => {
    await configureGatewayAuth({
      mode: "trusted-proxy",
      identityScopes: { "admin@example.com": ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    });

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_HEADERS);
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.read"],
          device: null,
          client: CONTROL_UI_CLIENT,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.admin"]);
        expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(true);
      } finally {
        ws.close();
      }
    });
  });

  test("applies a verified Tailscale WhoIs identity grant", async () => {
    await configureGatewayAuth({
      mode: "token",
      token: "secret",
      allowTailscale: true,
      identityScopes: { peter: ["operator.admin"] },
    });
    testTailscaleWhois.value = { login: "peter", name: "Peter" };

    await withGatewayServer(async ({ port }) => {
      const ws = await openTailscaleWs(port, { origin: BROWSER_ORIGIN });
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.read"],
          client: CONTROL_UI_CLIENT,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.read", "operator.admin"]);
        expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(true);
      } finally {
        ws.close();
      }
    });
  });

  test("caps the final device and identity scope union", async () => {
    await configureGatewayAuth({
      mode: "trusted-proxy",
      identityScopes: {
        "admin@example.com": ["operator.admin", "operator.read"],
      },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    });

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, {
        ...TRUSTED_PROXY_HEADERS,
        "x-openclaw-scopes": "operator.read",
      });
      try {
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: ["operator.read"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: deviceIdentityPath("identity-scope-cap"),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.read"]);
        expect((await rpcReq(ws, "status")).ok).toBe(true);
        expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(false);
      } finally {
        ws.close();
      }
    });
  });

  test("ignores an unverified identity header on token auth", async () => {
    await configureGatewayAuth({
      mode: "token",
      token: "secret",
      identityScopes: { "admin@example.com": ["operator.admin"] },
    });

    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, {
        origin: BROWSER_ORIGIN,
        "x-forwarded-user": "admin@example.com",
      });
      try {
        const connected = await connectReq(ws, {
          token: "secret",
          scopes: ["operator.read"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: deviceIdentityPath("identity-scope-token"),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok).toBe(true);
        expect(responseScopes(connected)).toEqual(["operator.read"]);
        expect((await rpcReq(ws, "set-heartbeats", { enabled: false })).ok).toBe(false);
      } finally {
        ws.close();
      }
    });
  });
});
