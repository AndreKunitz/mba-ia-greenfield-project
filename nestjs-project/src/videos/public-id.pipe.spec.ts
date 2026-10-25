import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { generatePublicId } from './public-id.util';
import { PublicIdPipe } from './public-id.pipe';

describe('PublicIdPipe', () => {
  const pipe = new PublicIdPipe();

  it('should let a well-formed public id through unchanged', () => {
    const id = generatePublicId();

    expect(pipe.transform(id)).toBe(id);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'aB3dE5gH7jKx'],
    ['with a symbol', 'aB3dE5gH7j!'],
    ['with a dash', 'aB3dE5gH7j-'],
    ['empty', ''],
    ['with a space', 'aB3dE5gH 7j'],
  ])('should answer not found for an id that is %s', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(VideoNotFoundException);
  });
});
