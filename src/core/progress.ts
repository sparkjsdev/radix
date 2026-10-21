/** What a long job is doing. */
export type ProgressStage = "downloading" | "decoding" | "encoding" | "compressing";

/**
 * Reports how far a long job has come. It is called often, so code that
 * forwards it throttles.
 *
 * @param fraction The fraction done, from 0 to 1.
 */
export type Progress = (fraction: number, stage: ProgressStage) => void;

// A sub-step's progress as [from, to] of its parent's
export function span(progress: Progress | undefined, from: number, to: number): Progress | undefined {
  return progress && ((fraction, stage) => progress(from + (to - from) * Math.min(1, Math.max(0, fraction)), stage));
}

export function counter(progress: Progress | undefined, total: number, stage: ProgressStage) {
  return progress ? (i: number) => (i & 0xffff) === 0 && progress(i / Math.max(1, total), stage) : () => {};
}

// content-length is the transferred size, so the fraction is an estimate
export async function readResponse(response: Response, progress?: Progress): Promise<Uint8Array<ArrayBuffer>> {
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!progress || !response.body || !(total > 0)) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const chunks: Uint8Array[] = [];
  let read = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    read += value.byteLength;
    progress(Math.min(1, read / total), "downloading");
  }

  const bytes = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
