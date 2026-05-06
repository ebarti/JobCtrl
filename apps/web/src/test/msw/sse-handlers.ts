import { http, HttpResponse } from "msw";

export interface SseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

function frameToText(frame: SseFrame): string {
  const lines: string[] = [];
  lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  lines.push("", "");
  return lines.join("\n");
}

export function streamFrames(frames: readonly SseFrame[]) {
  return http.get("*/v1/events/stream", () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frameToText(frame)));
        }
        controller.close();
      },
    });
    return new HttpResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
}
