import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDevices, parseJvm, parseProcessNames } from "../src/host/debug";
import { parseApplicationIds, parseVariants } from "../src/host/runs";

test("reads online Android devices with readable names", () => {
  assert.deepEqual(
    parseDevices(
      "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\nR58M123  unauthorized usb:1-1 transport_id:2\n0123ABC  device usb:1-2 product:panther model:Pixel_7 device:panther transport_id:3\n\n",
    ),
    [
      { serial: "emulator-5554", name: "sdk gphone64 arm64" },
      { serial: "0123ABC", name: "Pixel 7" },
    ],
  );
  assert.deepEqual(
    [
      ...parseProcessNames(
        "PID NAME\n  1 init\n4321 dev.shop.app\n4400 dev.shop.app:remote\n",
      ),
    ],
    [
      [1, "init"],
      [4321, "dev.shop.app"],
      [4400, "dev.shop.app:remote"],
    ],
  );
});

test("finds JVMs started with a JDWP server and their main class", () => {
  assert.deepEqual(
    parseJvm(
      812,
      "/usr/bin/java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 -cp /a:/b dev.shop.Server --port 8080",
    ),
    {
      kind: "jvm",
      name: "dev.shop.Server",
      pid: 812,
      host: "localhost",
      port: 5005,
    },
  );
  assert.equal(
    parseJvm(
      9,
      "java -Xrunjdwp:transport=dt_socket,server=y,address=10.0.0.2:8000 -jar /opt/app/service.jar",
    )?.name,
    "service.jar",
  );
  assert.equal(
    parseJvm(
      9,
      "java -Xrunjdwp:transport=dt_socket,server=y,address=10.0.0.2:8000 -jar x.jar",
    )?.host,
    "10.0.0.2",
  );
  // A JVM that connects out to a debugger, or has no agent, cannot be attached to.
  assert.equal(
    parseJvm(
      1,
      "java -agentlib:jdwp=transport=dt_socket,server=n,address=5005 Main",
    ),
    undefined,
  );
  assert.equal(parseJvm(1, "java -cp . Main"), undefined);
});

test("variant listing carries each variant's application ID", () => {
  const output =
    "cw-variant interHmgDebug dev.shop.hmg\ncw-variant pjMockServerDebug dev.shop.pj.mock\ncw-variant legacyDebug\n";
  assert.deepEqual(parseVariants(output), [
    "interHmgDebug",
    "pjMockServerDebug",
    "legacyDebug",
  ]);
  assert.deepEqual(parseApplicationIds(output), [
    "dev.shop.hmg",
    "dev.shop.pj.mock",
  ]);
});
