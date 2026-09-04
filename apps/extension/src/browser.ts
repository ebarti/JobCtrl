export interface BrowserTab {
  id?: number;
  title?: string;
  url?: string;
}

export interface BrowserStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface BrowserRuntimeMessageSender {
  tab?: BrowserTab;
}

export type BrowserMessageListener = (
  message: unknown,
  sender: BrowserRuntimeMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

export interface BrowserRuntime {
  getManifest(): { version?: string };
  sendMessage<TResponse = unknown>(message: unknown): Promise<TResponse>;
  onMessage: {
    addListener(listener: BrowserMessageListener): void;
  };
}

export interface BrowserTabs {
  create(createProperties: { active?: boolean; url?: string }): Promise<BrowserTab>;
  update(tabId: number, updateProperties: { active?: boolean; url?: string }): Promise<BrowserTab>;
  query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<BrowserTab[]>;
  remove(tabId: number): Promise<void>;
  sendMessage<TResponse = unknown>(tabId: number, message: unknown): Promise<TResponse>;
}

export interface BrowserDeclarativeNetRequestRule {
  id: number;
  priority: number;
  action: { type: "allow" | "block" };
  condition: {
    regexFilter: string;
    resourceTypes: Array<"main_frame" | "xmlhttprequest">;
    tabIds: number[];
  };
}

export interface BrowserDeclarativeNetRequest {
  updateSessionRules(options: {
    removeRuleIds: number[];
    addRules?: BrowserDeclarativeNetRequestRule[];
  }): Promise<void>;
}

export interface BrowserAlarms {
  create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }): void;
  onAlarm: {
    addListener(listener: (alarm: { name: string }) => void): void;
  };
}

export interface BrowserScripting {
  executeScript<TResult, TArgs extends unknown[] = []>(options: {
    target: { tabId: number };
    func: (...args: TArgs) => TResult;
    args?: TArgs;
  }): Promise<Array<{ result?: TResult }>>;
}

export interface BrowserApi {
  alarms: BrowserAlarms;
  declarativeNetRequest: BrowserDeclarativeNetRequest;
  runtime: BrowserRuntime;
  scripting: BrowserScripting;
  storage: {
    local: BrowserStorageArea;
  };
  tabs: BrowserTabs;
}

declare global {
  const chrome: BrowserApi;
}

export function getBrowserApi(): BrowserApi {
  return chrome;
}
