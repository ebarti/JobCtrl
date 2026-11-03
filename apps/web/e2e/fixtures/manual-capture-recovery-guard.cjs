function assertIsolatedLinuxManualCapture(platform = process.platform, env = process.env) {
  if (platform !== "linux" || env.JOBCTRL_E2E_ISOLATED !== "1") {
    throw new Error("The manual-capture recovery browser test requires Linux and JOBCTRL_E2E_ISOLATED=1.");
  }
}

module.exports = { assertIsolatedLinuxManualCapture };
