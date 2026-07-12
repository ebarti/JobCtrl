import type { DemoWorkspaceNotification } from "./contracts.js";

export interface DemoWorkspaceChannel {
  postMessage(notification: DemoWorkspaceNotification): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<DemoWorkspaceNotification>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<DemoWorkspaceNotification>) => void,
  ): void;
  close(): void;
}

export interface DemoWorkspaceChannelFactory {
  create(): DemoWorkspaceChannel | null;
}

const CHANNEL_NAME = "jobctrl-demo-workspace";

export const browserDemoWorkspaceChannelFactory: DemoWorkspaceChannelFactory = {
  create() {
    if (typeof BroadcastChannel === "undefined") {
      return null;
    }
    return new BroadcastChannel(CHANNEL_NAME) as DemoWorkspaceChannel;
  },
};
