import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildTestPorts, FakeSessionPort } from "../../test/testPorts.js";
import { PortsProvider, usePorts } from "./PortsProvider.js";

describe("PortsProvider composition", () => {
  it("preserves composition identity until a member is replaced on the same ports object", () => {
    const ports = buildTestPorts();
    let observed!: ReturnType<typeof usePorts>;
    function Probe() { observed = usePorts(); return null; }
    const view = render(<PortsProvider ports={ports}><Probe /></PortsProvider>);
    const original = observed;
    view.rerender(<PortsProvider ports={ports}><Probe /></PortsProvider>);
    expect(observed).toBe(original);

    ports.session = new FakeSessionPort({ tenantId: "other" as ReturnType<typeof ports.session.getSession>["tenantId"], userId: null });
    view.rerender(<PortsProvider ports={ports}><Probe /></PortsProvider>);
    expect(observed).not.toBe(original);
    expect(observed.session).toBe(ports.session);
    expect(observed.requestIdentity).toBe(original.requestIdentity);

    const afterSession = observed;
    ports.api = buildTestPorts().api;
    view.rerender(<PortsProvider ports={ports}><Probe /></PortsProvider>);
    expect(observed).not.toBe(afterSession);
    expect(observed.api).toBe(ports.api);
    const afterApi = observed;
    view.rerender(<PortsProvider ports={ports}><Probe /></PortsProvider>);
    expect(observed).toBe(afterApi);
  });
});
