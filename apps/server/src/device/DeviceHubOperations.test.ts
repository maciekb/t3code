import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

const tv = {
  id: "TV-1",
  name: "Apple TV 4K",
  platform: "tvos" as const,
  version: "tvOS 26.0",
  booted: false,
  physical: false,
};

function setup(
  options: {
    listOutput?: string;
    listCode?: number;
    startOk?: boolean;
    appleAvailable?: boolean;
  } = {},
) {
  const requests: string[] = [];
  const commands: { command: string; args: ReadonlyArray<string> }[] = [];
  const http = HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          request.url.endsWith("/api/devices")
            ? { simulators: [], emulators: [] }
            : { ok: options.startOk ?? true },
        ),
      ),
    );
  });
  const devices = makeDeviceHubOperations({
    hostId: "mac",
    origin: "http://mac",
    http,
    appleAvailable: Effect.succeed(options.appleAvailable ?? true),
    androidAvailable: Effect.succeed(false),
    run: (command, args) => {
      commands.push({ command, args });
      return Effect.succeed({
        code: options.listCode ?? 0,
        stdout:
          options.listOutput ??
          JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.tvOS-26-0": [
                { udid: tv.id, name: tv.name, state: "Shutdown", isAvailable: true },
                { udid: "TV-2", name: "Apple TV", state: "Booted", isAvailable: true },
                { udid: "TV-old", name: "Unavailable", state: "Shutdown", isAvailable: false },
              ],
              "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
                { udid: "PHONE", name: "iPhone", state: "Booted", isAvailable: true },
              ],
            },
          }),
        stderr: "",
      });
    },
  });
  return { devices, requests, commands };
}

describe("tvOS hub operations", () => {
  it.effect("discovers unused and booted tvOS simulators on the device host", () =>
    Effect.gen(function* () {
      const { devices, commands } = setup();
      const listed = yield* devices.list;
      expect(listed.devices).toEqual([tv, { ...tv, id: "TV-2", name: "Apple TV", booted: true }]);
      expect(commands).toEqual([
        { command: "xcrun", args: ["simctl", "list", "devices", "available", "--json"] },
      ]);
    }),
  );

  it.effect("does not run Apple tools on Android-only hosts", () =>
    Effect.gen(function* () {
      const { devices, commands } = setup({ appleAvailable: false });
      expect((yield* devices.list).devices).toEqual([]);
      expect(commands).toEqual([]);
    }),
  );

  it.effect.each([{ listCode: 1 }, { listOutput: "not json" }])(
    "keeps hub devices accessible when tvOS discovery fails: %j",
    (options) =>
      Effect.gen(function* () {
        const { devices } = setup(options);
        expect((yield* devices.list).detail).toContain("Could not list tvOS simulators");
      }),
  );

  it.effect("boots, attaches, captures and shuts down through serve-sim", () =>
    Effect.gen(function* () {
      const { devices, requests } = setup();
      expect(yield* devices.boot(tv, undefined)).toBe(tv.id);
      yield* devices.attach(tv);
      yield* devices.screenshot(tv);
      yield* devices.shutdown(tv);
      expect(requests).toEqual([
        "http://mac/vendor/serve-sim/grid/api/start",
        "http://mac/vendor/serve-sim/grid/api/start",
        "http://mac/vendor/serve-sim/api/screenshot?device=TV-1",
        "http://mac/vendor/serve-sim/grid/api/shutdown",
      ]);
    }),
  );

  it.effect("reports a rejected tvOS boot", () =>
    Effect.gen(function* () {
      const { devices } = setup({ startOk: false });
      const result = yield* devices.boot(tv, undefined).pipe(Effect.flip);
      expect(result._tag).toBe("DeviceBootError");
    }),
  );

  it.effect("reports a rejected stream attachment instead of opening a broken preview", () =>
    Effect.gen(function* () {
      const { devices } = setup({ startOk: false });
      const result = yield* devices.attach(tv).pipe(Effect.flip);
      expect(result.reason).toBe("hub_rejected");
    }),
  );
});
