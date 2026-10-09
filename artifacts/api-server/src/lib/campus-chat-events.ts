import type { Response } from "express";

export type CampusEvent = {
  type: string;
  conversationId?: string;
  [key: string]: unknown;
};

const streamsByUser = new Map<string, Set<Response>>();

export function addEventStream(userId: string, response: Response): () => void {
  const streams = streamsByUser.get(userId) ?? new Set<Response>();
  streams.add(response);
  streamsByUser.set(userId, streams);

  return () => {
    streams.delete(response);
    if (streams.size === 0) streamsByUser.delete(userId);
  };
}

export function publishCampusEvent(
  userId: string,
  event: CampusEvent,
): void {
  const streams = streamsByUser.get(userId);
  if (!streams) return;

  const frame = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of streams) {
    if (!response.writableEnded) response.write(frame);
  }
}

export function hasOpenEventStream(userId: string): boolean {
  return (streamsByUser.get(userId)?.size ?? 0) > 0;
}
