import {
  DeviceActionUnavailableError,
  DeviceOperationError,
  type DeviceTvRemoteButton,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { DeviceHostReady } from "./DeviceHost.ts";

const KEY_USAGES: Record<DeviceTvRemoteButton, number> = {
  up: 0x52,
  down: 0x51,
  left: 0x50,
  right: 0x4f,
  select: 0x28,
  back: 0x29,
};

// CoreSimulator 1155.4+ drops legacy keyboard HID; DTUHID must be reached in the simulator's namespace.
const SOURCE = String.raw`#import <Foundation/Foundation.h>
#import <xpc/xpc.h>
#import <dlfcn.h>
#import <mach/mach.h>
@interface NSObject (SimPrivate)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)path error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)availableDevices;
- (NSUUID *)UDID;
- (mach_port_t)lookup:(NSString *)name error:(NSError **)error;
@end
static const char *service = "com.apple.coredevice.feature.remote.hid.digitizer";
static xpc_object_t keyMessage(uint64_t usage,uint64_t state,bool barrier) {
 xpc_object_t message=xpc_dictionary_create(NULL,NULL,0),payload=xpc_dictionary_create(NULL,NULL,0);
 xpc_dictionary_set_string(message,"messageType","IndigoKeyboardButtonEvent");
 xpc_dictionary_set_string(message,"featureIdentifier",service);
 xpc_dictionary_set_bool(message,"isBarrier",barrier);
 xpc_dictionary_set_uint64(payload,"usageCode",usage);
 xpc_dictionary_set_uint64(payload,"state",state);
 xpc_dictionary_set_value(message,"payload",payload);
 return message;
}
int main(int argc,const char **argv) {@autoreleasepool {
 if(argc!=4)return 2;
 NSError *error=nil;
 NSBundle *framework=[NSBundle bundleWithPath:@"/Library/Developer/PrivateFrameworks/CoreSimulator.framework"];
 if(![framework loadAndReturnError:&error]){fprintf(stderr,"CoreSimulator: %s\n",error.description.UTF8String);return 3;}
 NSString *version=framework.infoDictionary[@"CFBundleVersion"];
 if(version && [version compare:@"1155.4" options:NSNumericSearch]==NSOrderedAscending)return 10;
 id context=[NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:@(argv[3]) error:&error];
 id set=[context defaultDeviceSetWithError:&error],device=nil;
 for(id candidate in [set availableDevices])if([[[candidate UDID] UUIDString] caseInsensitiveCompare:@(argv[1])]==NSOrderedSame)device=candidate;
 if(!device){fprintf(stderr,"Device not found\n");return 4;}
 mach_port_t port=[device lookup:@(service) error:&error];
 if(!port){fprintf(stderr,"Lookup: %s\n",error.description.UTF8String);return 5;}
 xpc_endpoint_t(*endpoint)(mach_port_t,uint64_t,uint64_t)=dlsym(RTLD_DEFAULT,"xpc_endpoint_create_mach_port_4sim");
 void(*enable)(xpc_connection_t)=dlsym(RTLD_DEFAULT,"xpc_connection_enable_sim2host_4sim");
 if(!endpoint||!enable)return 6;
 xpc_endpoint_t serviceEndpoint=endpoint(port,0,0);
 if(!serviceEndpoint)return 6;
 xpc_connection_t connection=xpc_connection_create_from_endpoint(serviceEndpoint);
 if(!connection)return 6;
 enable(connection);
 xpc_connection_set_event_handler(connection,^(xpc_object_t event){});
 xpc_connection_resume(connection);
 dispatch_semaphore_t ready=dispatch_semaphore_create(0);
 __block bool alive=false;
 xpc_connection_send_message_with_reply(connection,keyMessage(0,2,true),dispatch_get_global_queue(QOS_CLASS_DEFAULT,0),^(xpc_object_t reply){alive=xpc_get_type(reply)!=XPC_TYPE_ERROR;dispatch_semaphore_signal(ready);});
 if(dispatch_semaphore_wait(ready,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))||!alive)return 7;
 usleep(200000);
 uint64_t usage=strtoull(argv[2],NULL,10);
 xpc_connection_send_message(connection,keyMessage(usage,1,false));
 usleep(80000);
 xpc_connection_send_message(connection,keyMessage(usage,2,false));
 dispatch_semaphore_t sent=dispatch_semaphore_create(0);
 xpc_connection_send_barrier(connection,^{dispatch_semaphore_signal(sent);});
 if(dispatch_semaphore_wait(sent,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC)))return 8;
 usleep(200000);
 xpc_connection_cancel(connection);
 puts("sent");return 0;
}}
`;

const RUNNER = `
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const source = ${JSON.stringify(SOURCE)};
const [device, usage, cli] = process.argv.slice(1);
const run = (command, args, timeout = 20000) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  if (result.error) throw result.error;
  return result;
};
const developer = run("xcode-select", ["-p"]);
if (developer.status !== 0) throw Error("Xcode developer directory is unavailable");
const developerDir = developer.stdout.trim();
const hash = createHash("sha256").update(source + "\\0" + developerDir).digest("hex");
const cache = path.join(os.homedir(), ".t3", "device", "tvos-input", hash);
const binary = path.join(cache, "input");
fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
if (!fs.existsSync(binary)) {
  const staging = fs.mkdtempSync(path.join(cache, ".build-"));
  try {
    const input = path.join(staging, "input.m"), output = path.join(staging, "input");
    fs.writeFileSync(input, source, { mode: 0o600 });
    const compiled = run("xcrun", ["clang", "-fobjc-arc", "-framework", "Foundation", input, "-o", output]);
    if (compiled.status !== 0) { process.stderr.write(compiled.stderr); process.exit(1); }
    fs.chmodSync(output, 0o700);
    fs.renameSync(output, binary);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
(async () => {
  const result = run(binary, [device, usage, developerDir], 10000);
  if (result.status === 10) {
    const native = require(path.join(path.dirname(cli), "native", "serve-sim-native.node"));
    const hid = new native.SimHID(device);
    await hid.key("down", Number(usage));
    await new Promise(resolve => setTimeout(resolve, 80));
    await hid.key("up", Number(usage));
    await new Promise(resolve => setTimeout(resolve, 80));
    process.exit(0);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
})().catch(error => { console.error(error); process.exit(1); });
`;

export const pressTvRemoteButton = Effect.fn("DeviceActions.pressTvRemoteButton")(function* (
  ready: DeviceHostReady,
  deviceId: string,
  button: DeviceTvRemoteButton,
) {
  const cli = ready.helpers.serveSimCli;
  if (!cli)
    return yield* new DeviceActionUnavailableError({
      operation: "pressRemoteButton",
      platform: "tvos",
      reason: "helper_missing",
    });
  const result = yield* ready.run(
    ready.nodePath,
    ["-e", RUNNER, deviceId, String(KEY_USAGES[button]), cli],
    { timeoutMs: 45000 },
  );
  if (result.code !== 0)
    return yield* new DeviceOperationError({
      operation: "press remote button",
      reason: "command_failed",
      exitCode: result.code,
      cause: result,
    });
});
