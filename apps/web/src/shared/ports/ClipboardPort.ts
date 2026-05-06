export interface ClipboardPort {
  write(text: string): Promise<void>;
}
