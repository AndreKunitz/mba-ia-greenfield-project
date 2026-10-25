/** The file is not a playable video; retrying would not change the outcome. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

/**
 * Summarises a failed ffmpeg/ffprobe run without leaking the command line:
 * it contains the signed storage URL.
 */
export function describeToolFailure(tool: string, error: unknown): string {
  const { stderr, code } = error as {
    stderr?: string;
    code?: string | number;
  };
  const lastLine =
    (stderr ?? '').trim().split('\n').filter(Boolean).pop() ??
    (error instanceof Error ? error.name : 'unknown error');
  const withoutUrls = lastLine.replace(/https?:\/\/\S+/g, '<url>');
  return `${tool} failed (${String(code ?? 'no exit code')}): ${withoutUrls}`;
}
