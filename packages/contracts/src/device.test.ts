import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  DeviceServiceState,
  DeviceSummary,
  DeviceSession,
  DevicePlatformAvailability,
  EasDeviceHostConfig,
  EasDeviceHostConfigs,
  SshDeviceHostConfigs,
} from "./device.ts";
import { secretSettingsFields } from "./settings.ts";
import { ThreadId } from "./baseSchemas.ts";

const decodeSshHosts = Schema.decodeUnknownSync(SshDeviceHostConfigs);
const decodeEas = Schema.decodeUnknownSync(EasDeviceHostConfigs);
const encodeState = Schema.encodeSync(DeviceServiceState);
const decodeState = Schema.decodeUnknownSync(DeviceServiceState);
const OlderPlatform = Schema.Literals(["ios", "android"]);
// The host summary as clients decoded it before EAS hosts existed.
const decodeOlderState = Schema.decodeUnknownSync(
  Schema.Struct({
    hosts: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: Schema.Literals(["local", "ssh"]),
        platforms: Schema.Array(
          Schema.Struct({ ...DevicePlatformAvailability.fields, platform: OlderPlatform }),
        ),
      }),
    ),
    devices: Schema.Array(Schema.Struct({ ...DeviceSummary.fields, platform: OlderPlatform })),
    sessions: Schema.Array(Schema.Struct({ ...DeviceSession.fields, platform: OlderPlatform })),
    bootingDevices: Schema.optional(
      Schema.Array(
        Schema.Struct({ ...DeviceSummary.fields, platform: OlderPlatform, threadId: ThreadId }),
      ),
    ),
  }),
);

describe("configured device hosts", () => {
  it("reads SSH hosts saved before hosts had a kind, and bounds EAS sessions", () => {
    expect(decodeSshHosts([{ id: "mac", label: "Mac mini", target: "julius@mac" }])).toEqual([
      { kind: "ssh", id: "mac", label: "Mac mini", target: "julius@mac" },
    ]);
    expect(decodeEas([{ kind: "eas", id: "eas", label: "EAS Simulator" }])).toEqual([
      {
        kind: "eas",
        id: "eas",
        label: "EAS Simulator",
        accessToken: "",
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 2,
      },
    ]);
    expect(() =>
      decodeEas([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 600 }]),
    ).toThrow();
    // The default idle limit of 10 is not smaller than a session limit of 10.
    expect(() =>
      decodeEas([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 10 }]),
    ).toThrow();
  });

  it("marks the EAS access token as a secret setting", () => {
    expect(secretSettingsFields(EasDeviceHostConfig)).toEqual(["accessToken"]);
  });
});

describe("device state for clients from before EAS hosts", () => {
  const summary = {
    label: "Host",
    platforms: [],
    hubInstalled: true,
    agentDeviceInstalled: true,
  };
  const state = {
    hosts: [
      { ...summary, id: "local", kind: "local" as const },
      { ...summary, id: "eas", kind: "eas" as const },
    ],
    hostStatus: "ready" as const,
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 1,
  };

  it("sends EAS hosts where an older client does not look, and reads them back", () => {
    const wire = encodeState(state);
    expect(decodeOlderState(wire).hosts.map((host) => host.id)).toEqual(["local"]);
    expect(decodeState(wire).hosts).toEqual(state.hosts);
  });

  it("round-trips tvOS state without exposing an unknown platform to older clients", () => {
    const tv = {
      hostId: "mac",
      id: "tv",
      platform: "tvos" as const,
      name: "Apple TV",
      version: "tvOS 26.0",
      booted: true,
      physical: false,
    };
    const threadId = ThreadId.make("thread");
    const phone = {
      ...tv,
      id: "phone",
      platform: "ios" as const,
      name: "iPhone",
      version: "iOS 26.0",
    };
    const tvState = {
      ...state,
      hosts: [
        {
          ...summary,
          id: "mac",
          kind: "ssh" as const,
          platforms: [
            { platform: "ios" as const, available: true },
            { platform: "tvos" as const, available: true },
          ],
        },
      ],
      devices: [tv, phone],
      sessions: [
        {
          hostId: tv.hostId,
          deviceId: tv.id,
          platform: tv.platform,
          threadId,
          openedAt: "2026-10-25T00:00:00Z",
        },
        {
          hostId: phone.hostId,
          deviceId: phone.id,
          platform: phone.platform,
          threadId,
          openedAt: "2026-10-25T00:01:00Z",
        },
      ],
      bootingDevices: [
        { ...tv, threadId },
        { ...phone, threadId },
      ],
    };
    const wire = encodeState(tvState);
    const older = decodeOlderState(wire);
    expect(older.hosts[0]?.platforms).toEqual([{ platform: "ios", available: true }]);
    expect(older.devices).toEqual([phone]);
    expect(older.sessions).toEqual([tvState.sessions[1]]);
    expect(older.bootingDevices).toEqual([{ ...phone, threadId }]);
    expect(decodeState(wire)).toEqual(tvState);
  });
});
