/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  revokeDeviceToken,
  rotateDeviceToken,
  storeDeviceAuthToken,
} from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createState(request: (method: string, params?: unknown) => Promise<unknown>) {
  return {
    client: {
      request: request as <T = unknown>(method: string, params?: unknown) => Promise<T>,
    },
    connected: true,
    requestGeneration: 1,
    devicesLoading: false,
    devicesError: null,
    devicesList: null,
  };
}

function storeIdentity() {
  localStorage.setItem(
    "openclaw-device-identity-v1",
    JSON.stringify({
      version: 1,
      deviceId: "00",
      publicKey: "AA",
      privateKey: "AA",
      createdAtMs: 1,
    }),
  );
}

function deferIdentityFingerprint() {
  const digest = deferred<ArrayBuffer>();
  const digestMock = vi.fn(() => digest.promise);
  vi.stubGlobal("crypto", { subtle: { digest: digestMock } });
  return { digest, digestMock };
}

const tokenParams = {
  deviceId: "00",
  gatewayUrl: "wss://gateway.test",
  role: "operator",
};

function storedTokenKey(): string {
  const key = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  ).find((candidate) => candidate?.startsWith("openclaw.device.auth.v1:"));
  if (!key) {
    throw new Error("missing device-auth test storage key");
  }
  return key;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("device token request lifecycle", () => {
  // A retired epoch is a reconnect, not a reason to destroy the credential: the previous
  // token is already dead on the server, so the caller still needs this one to recover.
  it("returns a rotate response from a retired request epoch without persisting it", async () => {
    const response = deferred<unknown>();
    const state = createState(() => response.promise);

    const operation = rotateDeviceToken(state, tokenParams);
    state.requestGeneration += 1;
    response.resolve({ token: "rotated-token", tokenDelivery: "in-band", ...tokenParams });

    expect(await operation).toEqual({ delivery: "in-band", token: "rotated-token" });
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  it("rechecks rotate ownership after loading the local identity", async () => {
    storeIdentity();
    const { digest, digestMock } = deferIdentityFingerprint();
    const state = createState(async () => ({
      token: "rotated-token",
      tokenDelivery: "in-band",
      ...tokenParams,
    }));

    const operation = rotateDeviceToken(state, tokenParams);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);

    expect(await operation).toEqual({ delivery: "in-band", token: "rotated-token" });
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  it("reports a cross-device rotation the Gateway withheld the token for", async () => {
    const state = createState(async () => ({
      ...tokenParams,
      scopes: [],
      tokenDelivery: "withheld-cross-device",
    }));

    expect(await rotateDeviceToken(state, tokenParams)).toEqual({
      delivery: "withheld-cross-device",
    });
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  // Gateways released before tokenDelivery answer without it; a present token is then
  // the only signal, so the outcome must still resolve rather than read as withheld.
  it("classifies a rotate response from a Gateway that omits tokenDelivery", async () => {
    storeIdentity();
    const { digest, digestMock } = deferIdentityFingerprint();
    const state = createState(async () => ({ token: "legacy-token", ...tokenParams }));

    const operation = rotateDeviceToken(state, tokenParams);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);

    expect(await operation).toEqual({ delivery: "in-band", token: "legacy-token" });
  });

  it("does not clear a current token when a revoke request retires during identity loading", async () => {
    storeIdentity();
    storeDeviceAuthToken({ ...tokenParams, token: "current-token", scopes: ["operator.read"] });
    const { digest, digestMock } = deferIdentityFingerprint();
    const state = createState(async () => ({}));

    const operation = revokeDeviceToken(state, tokenParams);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);
    await operation;

    expect(loadDeviceAuthToken(tokenParams)?.token).toBe("current-token");
  });

  it("normalizes malformed persisted scopes without breaking token loading", () => {
    storeDeviceAuthToken({ ...tokenParams, token: "current-token", scopes: [] });
    const key = storedTokenKey();
    const store = JSON.parse(localStorage.getItem(key) ?? "null");
    store.tokens.operator.scopes = "not-an-array";
    localStorage.setItem(key, JSON.stringify(store));

    expect(loadDeviceAuthToken(tokenParams)).toMatchObject({
      token: "current-token",
      scopes: [],
    });
  });

  it("canonicalizes persisted role aliases before storing another token", () => {
    storeDeviceAuthToken({ ...tokenParams, token: "operator-token", scopes: [] });
    const key = storedTokenKey();
    const store = JSON.parse(localStorage.getItem(key) ?? "null");
    store.tokens = { " operator ": store.tokens.operator };
    localStorage.setItem(key, JSON.stringify(store));

    storeDeviceAuthToken({
      ...tokenParams,
      role: "node",
      token: "node-token",
      scopes: ["node.invoke"],
    });

    expect(loadDeviceAuthToken(tokenParams)?.token).toBe("operator-token");
  });

  it("removes persisted role aliases when clearing a token", () => {
    storeDeviceAuthToken({ ...tokenParams, token: "operator-token", scopes: [] });
    const key = storedTokenKey();
    const store = JSON.parse(localStorage.getItem(key) ?? "null");
    store.tokens[" operator "] = store.tokens.operator;
    localStorage.setItem(key, JSON.stringify(store));

    clearDeviceAuthToken(tokenParams);

    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });
});
