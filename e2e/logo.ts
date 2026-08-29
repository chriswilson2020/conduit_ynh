import { crc32, deflateSync } from "node:zlib";

/**
 * A REAL LOGO, BUILT RATHER THAN CHECKED IN.
 *
 * The journey this file supports uploads a logo through the real Settings surface and
 * then looks for the image in the rendered PDF, and the whole point of v1.0.1 is the
 * SIZE of that logo: 32KB was too small for flat-colour artwork on a large canvas,
 * which is what a company logo is. A 70-byte 1x1 PNG -- what the suite used before --
 * exercises the upload and proves nothing about the limit.
 *
 * BUILT, because the alternative is a 300KB binary in a repository whose sources are
 * ASCII, reviewed by nobody, and impossible to change without a new binary. This is
 * ~40 lines of PNG encoder and one shape function, and what it produces is
 * deterministic: the same bytes on every machine and every run, so the digest
 * assertions elsewhere in the suite stay meaningful.
 *
 * WHAT MAKES IT 300KB IS THE DITHER, and that is not a cheat -- it is what a real
 * export looks like. Flat colour compresses to almost nothing (a 2000 x 1400 field of
 * one colour is under 40KB even at deflate level 1), so artwork this size only lands
 * near 300KB when it carries the sub-pixel noise a design tool leaves behind. The
 * dither here is plus or minus two levels on a fraction of the pixels: invisible on
 * screen, incompressible in the file, and it does not change what the RENDERER pays,
 * which is decided by the pixel count and nothing else.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * A wordmark: a disc and three bars in flat colour on a light field, anti-aliased by
 * coverage, dithered on `dithered` pixels in every thousand.
 *
 * 32 in a thousand is not a magic number so much as a measured one: it is what puts
 * a 2000 x 1400 canvas at 293,138 bytes, which is a realistic logo inside
 * MAX_LOGO_BYTES (307,200) and nine times what v1.0.0 would accept. Neighbouring
 * values are 278,902 at 30 and 307,384 at 34, so the curve is steep and the test
 * asserts the size it actually gets rather than trusting this comment.
 */
export function flatColourLogo(width = 2000, height = 1400, dithered = 32): Buffer {
  const cx = width * 0.22;
  const cy = height * 0.5;
  const radius = height * 0.32;
  const bars = [
    { x0: width * 0.42, x1: width * 0.92, y0: height * 0.28, y1: height * 0.38 },
    { x0: width * 0.42, x1: width * 0.78, y0: height * 0.45, y1: height * 0.55 },
    { x0: width * 0.42, x1: width * 0.86, y0: height * 0.62, y1: height * 0.72 },
  ];
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0xf7, g = 0xf7, b = 0xf5;
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const disc = Math.max(0, Math.min(1, radius + 0.5 - distance));
      if (disc > 0) {
        r = Math.round(r * (1 - disc) + 0x1f * disc);
        g = Math.round(g * (1 - disc) + 0x4e * disc);
        b = Math.round(b * (1 - disc) + 0x79 * disc);
      }
      for (const bar of bars) {
        const across = Math.max(0, Math.min(x + 1, bar.x1) - Math.max(x, bar.x0));
        const down = Math.max(0, Math.min(y + 1, bar.y1) - Math.max(y, bar.y0));
        const cover = Math.max(0, Math.min(1, across * down));
        if (cover > 0) {
          r = Math.round(r * (1 - cover) + 0x33 * cover);
          g = Math.round(g * (1 - cover) + 0x33 * cover);
          b = Math.round(b * (1 - cover) + 0x33 * cover);
        }
      }
      // A hash of the coordinates rather than a random number, so the file is the
      // same on every run: a digest assertion over a random logo would be a
      // different kind of test every time it ran.
      const hash = ((x * 73_856_093) ^ (y * 19_349_663)) >>> 0;
      if (hash % 1000 < dithered) {
        r = Math.max(0, Math.min(255, r + (hash >>> 10) % 5 - 2));
        g = Math.max(0, Math.min(255, g + (hash >>> 14) % 5 - 2));
        b = Math.max(0, Math.min(255, b + (hash >>> 18) % 5 - 2));
      }
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // eight bits a channel
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    PNG_MAGIC,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
