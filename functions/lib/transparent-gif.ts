// 1x1 transparent GIF89a, the canonical 43-byte payload returned by the
// pixel endpoint. Pre-encoded as a Uint8Array constant so the handler
// never spends time building it.
//
// Layout (43 bytes):
//   header             47 49 46 38 39 61              "GIF89a"
//   logical width      01 00                          1
//   logical height     01 00                          1
//   gct flag/bg/aspect 80 00 00                       2-color GCT, sorted
//   gct entry 0        ff ff ff                       white
//   gct entry 1        00 00 00                       black
//   graphic ctl ext    21 f9 04 01 00 00 00 00        transparent flag set
//   image descriptor   2c 00 00 00 00 01 00 01 00 00  1x1 image, no LCT
//   lzw                02 02 44 01 00                 minimal lzw
//   trailer            3b
export const TRANSPARENT_GIF: Uint8Array = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

export const TRANSPARENT_GIF_HEADERS = {
  'Content-Type': 'image/gif',
  'Content-Length': String(TRANSPARENT_GIF.length),
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
} as const;
