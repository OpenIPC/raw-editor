/*
 * A minimal uncompressed DNG writer, for tests that need a frame whose answer
 * is known before the engine sees it.
 *
 * The fixtures beside it are real frames off a real sensor, which is the right
 * thing for "does this decode a camera's output". It is the wrong thing for
 * "does this find a hot pixel", because nobody knows where the hot pixels in a
 * real frame are -- so those tests plant their own and this builds the file
 * around them.
 *
 * 12 bits, packed MSB-first two pixels to three bytes, which is the layout the
 * engine's unpacker reads. 16 would need no packing at all and the engine does
 * not accept it, so the writer packs -- and the round trip through that packing
 * is then also under test, for free.
 */
const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7, SRATIONAL: 10 };

export function makeDng({ width, height, pixels, cfa = [0, 1, 1, 2], black = 0,
	white = 4095, model = 'test', bits = 12, colorMatrices = [] } = {}) {
	if (!pixels || pixels.length !== width * height)
		throw new Error('pixels must be width*height');
	if (bits !== 12 && bits !== 16)
		throw new Error('this writer packs 12 bits, or stores 16, and nothing else');

	let strip;
	if (bits === 16) {
		/*
		 * 16 bits is not packed at all: one little-endian sample per two
		 * bytes. The older HiSilicon parts write raw this way, and until the
		 * engine learned to read it a whole class of camera could not be
		 * opened -- so there has to be a way to make one without a camera.
		 */
		strip = Buffer.alloc(pixels.length * 2);
		for (let i = 0; i < pixels.length; i++)
			strip.writeUInt16LE(Math.max(0, Math.min(65535, pixels[i] | 0)), i * 2);
	} else {
		// Two pixels to three bytes, high bits first -- the order dng_unpack
		// reads. An odd count is allowed so the tail of the unpacker can be
		// tested: a real Bayer frame always has even dimensions, which is
		// exactly why that path would otherwise never run.
		const pairs = Math.floor(pixels.length / 2);
		strip = Buffer.alloc(pairs * 3 + (pixels.length & 1 ? 2 : 0));
		for (let i = 0, o = 0; i + 1 < pixels.length; i += 2, o += 3) {
			const a = Math.max(0, Math.min(4095, pixels[i] | 0));
			const b = Math.max(0, Math.min(4095, pixels[i + 1] | 0));
			strip[o] = a >> 4;
			strip[o + 1] = ((a & 0x0f) << 4) | (b >> 8);
			strip[o + 2] = b & 0xff;
		}
		if (pixels.length & 1) {
			const a = Math.max(0, Math.min(4095, pixels[pixels.length - 1] | 0));
			strip[pairs * 3] = a >> 4;
			strip[pairs * 3 + 1] = (a & 0x0f) << 4;
		}
	}

	const entries = [];
	const extra = [];              // values too big for the 4-byte inline slot
	const add = (tag, type, count, write) => entries.push({ tag, type, count, write });

	const asciiOf = (s) => Buffer.from(s + '\0', 'ascii');
	add(254, T.LONG, 1, () => 0);                       // NewSubfileType
	add(256, T.LONG, 1, () => width);
	add(257, T.LONG, 1, () => height);
	add(258, T.SHORT, 1, () => bits);
	add(259, T.SHORT, 1, () => 1);                      // uncompressed
	add(262, T.SHORT, 1, () => 32803);                  // CFA
	add(273, T.LONG, 1, 'strip');                       // StripOffsets
	add(277, T.SHORT, 1, () => 1);                      // SamplesPerPixel
	add(278, T.LONG, 1, () => height);                  // RowsPerStrip
	add(279, T.LONG, 1, () => strip.length);            // StripByteCounts
	add(33421, T.SHORT, 2, Buffer.from([2, 0, 2, 0]));  // CFARepeatPatternDim
	add(33422, T.BYTE, 4, Buffer.from(cfa));            // CFAPattern
	add(50706, T.BYTE, 4, Buffer.from([1, 4, 0, 0]));   // DNGVersion
	add(50708, T.ASCII, model.length + 1, asciiOf(model));
	if (Array.isArray(black)) {
		// One per 2x2 position, row-major, as majestic writes it under a
		// BlackLevelRepeatDim of 2x2.
		const b = Buffer.alloc(black.length * 2);
		black.forEach((v, i) => b.writeUInt16LE(v, i * 2));
		add(50714, T.SHORT, black.length, b);           // BlackLevel
	} else {
		add(50714, T.SHORT, 1, () => black);            // BlackLevel
	}
	add(50717, T.LONG, 1, () => white);                 // WhiteLevel
	{
		const b = Buffer.alloc(3 * 8);
		[1, 1, 1].forEach((v, i) => { b.writeUInt32LE(Math.round(v * 10000), i * 8); b.writeUInt32LE(10000, i * 8 + 4); });
		add(50728, T.RATIONAL, 3, b);                   // AsShotNeutral
	}
	// ColorMatrix1/2 with their CalibrationIlluminants, signed rationals over
	// 10000 -- the camera's own characterisation a light is named with.
	colorMatrices.slice(0, 2).forEach((c, k) => {
		const b = Buffer.alloc(9 * 8);
		c.matrix.forEach((v, i) => { b.writeInt32LE(Math.round(v * 10000), i * 8); b.writeInt32LE(10000, i * 8 + 4); });
		add(50721 + k, T.SRATIONAL, 9, b);
		add(50778 + k, T.SHORT, 1, () => c.illuminant);
	});
	entries.sort((a, b) => a.tag - b.tag);

	const sizeOf = { [T.BYTE]: 1, [T.ASCII]: 1, [T.SHORT]: 2, [T.LONG]: 4, [T.RATIONAL]: 8, [T.SRATIONAL]: 8 };
	const ifdBytes = 2 + entries.length * 12 + 4;
	let cursor = 8 + ifdBytes;
	for (const e of entries) {
		const bytes = sizeOf[e.type] * e.count;
		if (bytes > 4) { e.at = cursor; cursor += bytes + (bytes & 1); }
	}
	const stripAt = cursor;

	const head = Buffer.alloc(8 + ifdBytes);
	head.write('II', 0, 'ascii');
	head.writeUInt16LE(42, 2);
	head.writeUInt32LE(8, 4);
	head.writeUInt16LE(entries.length, 8);
	const tail = [];
	entries.forEach((e, i) => {
		const o = 10 + i * 12;
		head.writeUInt16LE(e.tag, o);
		head.writeUInt16LE(e.type, o + 2);
		head.writeUInt32LE(e.count, o + 4);
		const bytes = sizeOf[e.type] * e.count;
		if (e.write === 'strip') { head.writeUInt32LE(stripAt, o + 8); return; }
		if (bytes > 4) {
			head.writeUInt32LE(e.at, o + 8);
			const b = Buffer.isBuffer(e.write) ? e.write : Buffer.alloc(bytes);
			tail.push({ at: e.at, buf: b });
			return;
		}
		const v = Buffer.isBuffer(e.write) ? e.write : null;
		if (v) { v.copy(head, o + 8); return; }
		const n = e.write();
		if (e.type === T.SHORT) head.writeUInt16LE(n, o + 8);
		else head.writeUInt32LE(n, o + 8);
	});
	head.writeUInt32LE(0, 8 + 2 + entries.length * 12);

	const out = Buffer.alloc(stripAt + strip.length);
	head.copy(out, 0);
	for (const t of tail) t.buf.copy(out, t.at);
	strip.copy(out, stripAt);
	return new Uint8Array(out);
}
