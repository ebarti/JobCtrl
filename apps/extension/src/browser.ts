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
  query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<BrowserTab[]>;
  sendMessage<TResponse = unknown>(tabId: number, message: unknown): Promise<TResponse>;
}

export interface BrowserScripting {
  executeScript<TResult>(options: {
    target: { tabId: number };
    func: () => TResult;
  }): Promise<Array<{ result?: TResult }>>;
}

export interface BrowserApi {
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
