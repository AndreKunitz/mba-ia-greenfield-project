import { buildContentDisposition } from './content-disposition.util';

describe('buildContentDisposition', () => {
  it('should build an attachment header with both name forms', () => {
    expect(buildContentDisposition('My Clip.mp4')).toBe(
      `attachment; filename="My Clip.mp4"; filename*=UTF-8''My%20Clip.mp4`,
    );
  });

  it('should keep accents in the UTF-8 form and use an ASCII fallback', () => {
    const header = buildContentDisposition('férias à praia.mp4');

    expect(header).toContain('filename="f_rias _ praia.mp4"');
    expect(header).toContain(
      "filename*=UTF-8''f%C3%A9rias%20%C3%A0%20praia.mp4",
    );
  });

  it('should neutralise quotes that would break out of the quoted name', () => {
    const header = buildContentDisposition('a"b.mp4');

    expect(header).toContain('filename="a_b.mp4"');
    expect(header).not.toContain('"a"b');
  });

  it('should drop any directory from the name', () => {
    expect(buildContentDisposition('../../etc/passwd.mp4')).toContain(
      'filename="passwd.mp4"',
    );
    expect(buildContentDisposition('C:\\videos\\clip.mp4')).toContain(
      'filename="clip.mp4"',
    );
  });

  it('should remove control characters, including header injection attempts', () => {
    const header = buildContentDisposition('clip\r\nSet-Cookie: x=1.mp4');

    expect(header).not.toMatch(/[\r\n]/);
  });

  it('should fall back to a default name when nothing usable is left', () => {
    expect(buildContentDisposition('')).toContain('filename="video"');
    expect(buildContentDisposition('   ')).toContain('filename="video"');
  });

  it('should limit very long names', () => {
    const header = buildContentDisposition(`${'a'.repeat(400)}.mp4`);
    const match = /filename="([^"]*)"/.exec(header);

    expect(match?.[1].length).toBeLessThanOrEqual(255);
  });

  it('should percent-encode the characters RFC 5987 reserves', () => {
    expect(buildContentDisposition("it's (1)*.mp4")).toContain(
      "filename*=UTF-8''it%27s%20%281%29%2A.mp4",
    );
  });
});
