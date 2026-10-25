const MAX_FILENAME_LENGTH = 255;
const FALLBACK_FILENAME = 'video';

/**
 * Builds an `attachment` header from the uploaded file name (RFC 6266): an
 * ASCII fallback for old clients plus the UTF-8 form for the real name.
 */
export function buildContentDisposition(originalFilename: string): string {
  const name = sanitizeFilename(originalFilename);
  const asciiFallback = name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > LAST_CONTROL_CODE && code !== DELETE_CODE;
    })
    .join('');
}

function sanitizeFilename(filename: string): string {
  const withoutControls = stripControlCharacters(filename);
  // Keep only the last path segment: the name must never carry a directory.
  const base = withoutControls.split(/[\\/]/).pop()?.trim() ?? '';
  const name = base.length > 0 ? base : FALLBACK_FILENAME;
  return name.slice(0, MAX_FILENAME_LENGTH);
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
