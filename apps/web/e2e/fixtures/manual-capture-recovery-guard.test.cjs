const assert = require("node:assert/strict");
const test = require("node:test");
const { assertIsolatedLinuxManualCapture } = require("./manual-capture-recovery-guard.cjs");

test("manual capture recovery rejects host macOS and non-isolated browser execution", () => {
  assert.throws(() => assertIsolatedLinuxManualCapture("darwin", { JOBCTRL_E2E_ISOLATED: "1" }));
  assert.throws(() => assertIsolatedLinuxManualCapture("win32", { JOBCTRL_E2E_ISOLATED: "1" }));
  assert.throws(() => assertIsolatedLinuxManualCapture("linux", {}));
  assert.throws(() => assertIsolatedLinuxManualCapture("linux", { JOBCTRL_E2E_ISOLATED: "0" }));
  assert.doesNotThrow(() => assertIsolatedLinuxManualCapture("linux", { JOBCTRL_E2E_ISOLATED: "1" }));
});
