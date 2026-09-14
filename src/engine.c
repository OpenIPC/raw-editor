/*
 * Raw engine — DNG in, RGBA out.
 *
 * Freestanding wasm32: no libc, no emscripten runtime. Everything here is
 * arithmetic over one linear memory, so the module needs no syscalls and links
 * against nothing. That keeps it a few KB rather than a few hundred.
 *
 * The one thing it does NOT do is gamma: that needs pow(), which lives in libm.
 * The caller passes a lookup table instead — JS has Math.pow and builds it once.
 */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef signed int i32;

#define EXPORT(name) __attribute__((export_name(#name)))

/* clang lowers larger copies to these even with -nostdlib. */
void *memcpy(void *d, const void *s, unsigned long n) {
    u8 *a = d; const u8 *b = s;
    while (n--) *a++ = *b++;
    return d;
}
void *memset(void *d, int c, unsigned long n) {
    u8 *a = d;
    while (n--) *a++ = (u8)c;
    return d;
}

/* ---- allocator ------------------------------------------------------- */
/* A bump allocator and no free(): every buffer here lives as long as the
 * frame does, and a frame is replaced wholesale. reset_alloc() is what
 * "close the file" means. */
extern u8 __heap_base;
static u32 brk = 0;

EXPORT(reset_alloc) void reset_alloc(void) { brk = 0; }

EXPORT(alloc) void *alloc(u32 n) {
    if (brk == 0) brk = (u32)&__heap_base;
    u32 p = (brk + 15u) & ~15u;
    u32 end = p + n;
    u32 have = (u32)__builtin_wasm_memory_size(0) << 16;
    if (end > have) {
        u32 need = (end - have + 0xffffu) >> 16;
        if (__builtin_wasm_memory_grow(0, need) == (u32)-1) return 0;
    }
    brk = end;
    return (void *)p;
}

/* ---- DNG / TIFF ------------------------------------------------------ */

enum { CFA_RGGB = 0, CFA_GRBG = 1, CFA_GBRG = 2, CFA_BGGR = 3 };
enum { DEMOSAIC_NONE = 0, DEMOSAIC_BILINEAR = 1 };

enum {
    ERR_OK = 0, ERR_MAGIC = -1, ERR_TRUNCATED = -2, ERR_NO_STRIP = -3,
    ERR_BITS = -4, ERR_COMPRESSED = -5, ERR_SIZE = -6
};

static struct {
    const u8 *buf; u32 len;
    i32 width, height, bits, cfa;
    i32 black, white;
    i32 iso; float exposure_time;
    float neutral[3];
    float forward[9];
    i32 has_forward;
    i32 strip_off, strip_len;
    char model[64];
    u16 *raw;       /* width*height, unpacked */
} F;

static u32 rd16(const u8 *p) { return (u32)p[0] | ((u32)p[1] << 8); }
static u32 rd32(const u8 *p) {
    return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24);
}

static u32 type_size(u32 t) {
    switch (t) {
    case 1: case 2: case 6: case 7: return 1;
    case 3: case 8: return 2;
    case 4: case 9: case 11: return 4;
    case 5: case 10: case 12: return 8;
    }
    return 0;
}

/* Where an entry's values are: inline in the 4 value bytes when they fit,
 * otherwise at the offset those bytes hold. */
static const u8 *entry_data(const u8 *e, u32 type, u32 count) {
    u32 total = type_size(type) * count;
    if (total <= 4) return e + 8;
    u32 off = rd32(e + 8);
    if (off + total > F.len) return 0;
    return F.buf + off;
}

static u32 scalar(const u8 *e, u32 type, u32 count) {
    const u8 *d = entry_data(e, type, count);
    if (!d) return 0;
    return (type == 3 || type == 8) ? rd16(d) : rd32(d);
}

static float ratio_at(const u8 *d, u32 i, int is_signed) {
    i32 n = (i32)rd32(d + i * 8), den = (i32)rd32(d + i * 8 + 4);
    if (!is_signed) { u32 un = rd32(d + i * 8), ud = rd32(d + i * 8 + 4);
                      return ud ? (float)un / (float)ud : 0.f; }
    return den ? (float)n / (float)den : 0.f;
}

EXPORT(dng_open) i32 dng_open(const u8 *buf, u32 len) {
    F.buf = buf; F.len = len;
    F.width = F.height = 0; F.bits = 0; F.cfa = CFA_RGGB;
    F.black = 0; F.white = 0; F.has_forward = 0; F.strip_off = 0;
    F.strip_len = 0; F.iso = 0; F.exposure_time = 0.f; F.model[0] = 0;
    F.neutral[0] = F.neutral[1] = F.neutral[2] = 1.f;

    if (len < 16) return ERR_TRUNCATED;
    /* Little-endian only. Every DNG majestic writes is 'II', and a
     * big-endian branch nobody can exercise is a branch that rots. */
    if (!(buf[0] == 'I' && buf[1] == 'I' && buf[2] == 42 && buf[3] == 0))
        return ERR_MAGIC;

    u32 ifd = rd32(buf + 4);
    if (ifd + 2 > len) return ERR_TRUNCATED;
    u32 n = rd16(buf + ifd);
    if (ifd + 2 + n * 12u + 4u > len) return ERR_TRUNCATED;

    i32 compression = 1, photometric = 32803, bits_seen = 0;

    for (u32 i = 0; i < n; i++) {
        const u8 *e = buf + ifd + 2 + i * 12;
        u32 tag = rd16(e), type = rd16(e + 2), count = rd32(e + 4);
        const u8 *d;
        switch (tag) {
        case 256: F.width = (i32)scalar(e, type, count); break;
        case 257: F.height = (i32)scalar(e, type, count); break;
        case 258: bits_seen = (i32)scalar(e, type, count); break;
        case 259: compression = (i32)scalar(e, type, count); break;
        case 262: photometric = (i32)scalar(e, type, count); break;
        case 273: F.strip_off = (i32)scalar(e, type, count); break;
        case 279: F.strip_len = (i32)scalar(e, type, count); break;
        case 34855: F.iso = (i32)scalar(e, type, count); break;
        case 33434:
            d = entry_data(e, type, count);
            if (d) F.exposure_time = ratio_at(d, 0, 0);
            break;
        case 33422: /* CFAPattern, as plane indices */
            d = entry_data(e, type, count);
            if (d && count >= 4) {
                u8 a = d[0], b = d[1];
                F.cfa = a == 0 ? CFA_RGGB : a == 2 ? CFA_BGGR
                      : (b == 0 ? CFA_GRBG : CFA_GBRG);
            }
            break;
        case 50714: /* BlackLevel — one value or one per CFA position */
            d = entry_data(e, type, count);
            if (d) F.black = (i32)((type == 3 || type == 8) ? rd16(d) : rd32(d));
            break;
        case 50717:
            d = entry_data(e, type, count);
            if (d) F.white = (i32)((type == 3 || type == 8) ? rd16(d) : rd32(d));
            break;
        case 50728: /* AsShotNeutral */
            d = entry_data(e, type, count);
            if (d && count >= 3)
                for (u32 k = 0; k < 3; k++) F.neutral[k] = ratio_at(d, k, type == 10);
            break;
        case 50964: /* ForwardMatrix1 */
            d = entry_data(e, type, count);
            if (d && count >= 9) {
                for (u32 k = 0; k < 9; k++) F.forward[k] = ratio_at(d, k, 1);
                F.has_forward = 1;
            }
            break;
        case 50708: /* UniqueCameraModel */
            d = entry_data(e, type, count);
            if (d) {
                u32 m = count < sizeof F.model - 1 ? count : sizeof F.model - 1;
                for (u32 k = 0; k < m; k++) F.model[k] = (char)d[k];
                F.model[m] = 0;
            }
            break;
        }
    }

    if (compression != 1) return ERR_COMPRESSED;
    (void)photometric;
    if (bits_seen != 8 && bits_seen != 10 && bits_seen != 12 && bits_seen != 14)
        return ERR_BITS;
    F.bits = bits_seen;
    if (F.width <= 0 || F.height <= 0 || F.width > 16384 || F.height > 16384)
        return ERR_SIZE;
    if (!F.strip_off || !F.strip_len) return ERR_NO_STRIP;
    if ((u32)F.strip_off + (u32)F.strip_len > len) return ERR_TRUNCATED;
    /* The payload must be exactly the frame: a mismatch means the geometry
     * and the data disagree, and unpacking would read past one of them. */
    if ((u32)F.strip_len < ((u32)F.width * (u32)F.height * (u32)F.bits) / 8u)
        return ERR_TRUNCATED;
    if (!F.white) F.white = (1 << F.bits) - 1;
    return ERR_OK;
}

EXPORT(dng_width) i32 dng_width(void) { return F.width; }
EXPORT(dng_height) i32 dng_height(void) { return F.height; }
EXPORT(dng_bits) i32 dng_bits(void) { return F.bits; }
EXPORT(dng_cfa) i32 dng_cfa(void) { return F.cfa; }
EXPORT(dng_black) i32 dng_black(void) { return F.black; }
EXPORT(dng_white) i32 dng_white(void) { return F.white; }
EXPORT(dng_iso) i32 dng_iso(void) { return F.iso; }
EXPORT(dng_exposure) float dng_exposure(void) { return F.exposure_time; }
EXPORT(dng_has_forward) i32 dng_has_forward(void) { return F.has_forward; }
EXPORT(dng_neutral_ptr) const float *dng_neutral_ptr(void) { return F.neutral; }
EXPORT(dng_forward_ptr) const float *dng_forward_ptr(void) { return F.forward; }
EXPORT(dng_model_ptr) const char *dng_model_ptr(void) { return F.model; }
EXPORT(dng_raw_ptr) const u16 *dng_raw_ptr(void) { return F.raw; }

/* ---- unpack ---------------------------------------------------------- */
/* MSB-first packing, which is what the DNG spec means by an n-bit strip and
 * what majestic writes: 4 px per 5 bytes at 10 bits, 2 per 3 at 12. */
EXPORT(dng_unpack) i32 dng_unpack(void) {
    u32 px = (u32)F.width * (u32)F.height;
    F.raw = alloc(px * 2);
    if (!F.raw) return ERR_SIZE;
    const u8 *s = F.buf + F.strip_off;
    u16 *o = F.raw;

    if (F.bits == 8) {
        for (u32 i = 0; i < px; i++) o[i] = s[i];
    } else if (F.bits == 10) {
        u32 groups = px >> 2;
        for (u32 g = 0; g < groups; g++) {
            const u8 *b = s + g * 5; u16 *d = o + g * 4;
            d[0] = (u16)((b[0] << 2) | (b[1] >> 6));
            d[1] = (u16)(((b[1] & 0x3f) << 4) | (b[2] >> 4));
            d[2] = (u16)(((b[2] & 0x0f) << 6) | (b[3] >> 2));
            d[3] = (u16)(((b[3] & 0x03) << 8) | b[4]);
        }
    } else if (F.bits == 12) {
        u32 pairs = px >> 1;
        for (u32 g = 0; g < pairs; g++) {
            const u8 *b = s + g * 3; u16 *d = o + g * 2;
            d[0] = (u16)((b[0] << 4) | (b[1] >> 4));
            d[1] = (u16)(((b[1] & 0x0f) << 8) | b[2]);
        }
    } else { /* 14 */
        u32 groups = px >> 2;
        for (u32 g = 0; g < groups; g++) {
            const u8 *b = s + g * 7; u16 *d = o + g * 4;
            d[0] = (u16)((b[0] << 6) | (b[1] >> 2));
            d[1] = (u16)(((b[1] & 0x03) << 12) | (b[2] << 4) | (b[3] >> 4));
            d[2] = (u16)(((b[3] & 0x0f) << 10) | (b[4] << 2) | (b[5] >> 6));
            d[3] = (u16)(((b[5] & 0x3f) << 8) | b[6]);
        }
    }
    return ERR_OK;
}

/* ---- develop --------------------------------------------------------- */

/* Which CFA plane (0=R 1=G 2=B) sits at (x,y) for a given pattern. */
static inline int plane_at(int cfa, int x, int y) {
    int ox = cfa == CFA_GRBG || cfa == CFA_BGGR;
    int oy = cfa == CFA_GBRG || cfa == CFA_BGGR;
    int px = (x & 1) ^ ox, py = (y & 1) ^ oy;
    if (px == 0 && py == 0) return 0;
    if (px == 1 && py == 1) return 2;
    return 1;
}

static inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

/* XYZ(D50) -> sRGB, the ICC D50-adapted matrix. Paired with ForwardMatrix,
 * which the DNG spec defines as mapping white-balanced camera values to
 * XYZ(D50) -- that is why the forward matrix is the one used here and
 * ColorMatrix is not. */
static const float XYZ50_TO_SRGB[9] = {
     3.1338561f, -1.6168667f, -0.4906146f,
    -0.9787684f,  1.9161415f,  0.0334540f,
     0.0719453f, -0.2289914f,  1.4052427f
};

/*
 * out:   (width/step)*(height/step)*4 RGBA
 * gamma: 1024-entry u8 LUT indexed by a 0..1023 linear value
 * step:  1 for the full frame; N samples every Nth quad.
 *
 * The step exists because a full 2592x1520 bilinear develop measured 182 ms
 * here -- 5.5 fps, which is not a live slider. Stepping keeps the CFA phase
 * (it moves in whole quads) so a preview is the same picture, smaller, rather
 * than a differently-wrong one.
 */
EXPORT(develop) i32 develop(u8 *out, i32 cfa, i32 demosaic, i32 black, i32 white,
                            float nr, float ng, float nb, const float *fwd,
                            i32 use_fwd, float gain, const u8 *gamma, i32 step) {
    const int w = F.width, h = F.height;
    if (step < 1) step = 1;
    step &= ~1;                 /* whole quads only */
    if (step < 2) step = 1;
    const int ow = w / step, oh = h / step;
    if (!F.raw || !out || !gamma) return ERR_SIZE;
    const float span = (float)(white - black);
    if (span <= 0.f) return ERR_SIZE;
    const float inv = 1.f / span;
    const float neu[3] = { nr > 0.f ? nr : 1.f, ng > 0.f ? ng : 1.f,
                           nb > 0.f ? nb : 1.f };

    float M[9];
    if (use_fwd && fwd) {
        for (int r = 0; r < 3; r++)
            for (int c = 0; c < 3; c++) {
                float s = 0.f;
                for (int k = 0; k < 3; k++)
                    s += XYZ50_TO_SRGB[r * 3 + k] * fwd[k * 3 + c];
                M[r * 3 + c] = s;
            }
    } else {
        for (int i = 0; i < 9; i++) M[i] = (i % 4 == 0) ? 1.f : 0.f;
    }

    for (int oy = 0; oy < oh; oy++) {
        const int y = oy * step;
        for (int ox = 0; ox < ow; ox++) {
            const int x = ox * step;
            float c3[3];
            if (demosaic == DEMOSAIC_NONE) {
                /* The mosaic as it is: each pixel lights only its own plane.
                 * This is what makes a wrong CFA order and a hot pixel
                 * visible, so it is a mode rather than a diagnostic hack. */
                float v = clampf(((float)F.raw[y * w + x] - black) * inv, 0.f, 1.f);
                int p = plane_at(cfa, x, y);
                c3[0] = c3[1] = c3[2] = 0.f;
                c3[p] = v;
            } else {
                /* Bilinear: average the neighbours that carry each plane.
                 * Edges clamp to the mirrored neighbour rather than going
                 * dark, which is what a naive bounds check does. */
                float sum[3] = {0.f, 0.f, 0.f};
                int cnt[3] = {0, 0, 0};
                for (int dy = -1; dy <= 1; dy++) {
                    int yy = y + dy;
                    if (yy < 0) yy = 1; else if (yy >= h) yy = h - 2;
                    if (yy < 0) yy = 0;
                    for (int dx = -1; dx <= 1; dx++) {
                        int xx = x + dx;
                        if (xx < 0) xx = 1; else if (xx >= w) xx = w - 2;
                        if (xx < 0) xx = 0;
                        int p = plane_at(cfa, xx, yy);
                        sum[p] += (float)F.raw[yy * w + xx];
                        cnt[p]++;
                    }
                }
                for (int p = 0; p < 3; p++)
                    c3[p] = cnt[p] ? clampf((sum[p] / (float)cnt[p] - black) * inv,
                                            0.f, 1.f)
                                   : 0.f;
            }

            c3[0] /= neu[0]; c3[1] /= neu[1]; c3[2] /= neu[2];

            u8 *px = out + ((u32)oy * ow + ox) * 4;
            for (int i = 0; i < 3; i++) {
                float v = M[i * 3] * c3[0] + M[i * 3 + 1] * c3[1]
                        + M[i * 3 + 2] * c3[2];
                v = clampf(v * gain, 0.f, 1.f);
                px[i] = gamma[(int)(v * 1023.f + 0.5f)];
            }
            px[3] = 255;
        }
    }
    return ERR_OK;
}

/*
 * The camera's own reading of one patch of the frame, per CFA plane.
 *
 * For setting the white balance off something known to be neutral. The three
 * means are black-subtracted and returned as they came off the sensor: it is
 * the caller's business to divide them into a neutral, because what counts as
 * neutral is a judgement about the subject and not about the data.
 *
 * Samples the mosaic directly rather than the developed frame, which is the
 * whole point -- the developed frame has already had a white balance applied
 * and reading it back would measure that, not the scene.
 */
EXPORT(sample_patch) i32 sample_patch(i32 cx, i32 cy, i32 radius, i32 black,
                                      i32 cfa, float *out3) {
    const int w = F.width, h = F.height;
    if (!F.raw || !out3) return ERR_SIZE;
    if (radius < 1) radius = 1;

    double sum[3] = {0.0, 0.0, 0.0};
    u32 cnt[3] = {0, 0, 0};
    for (int y = cy - radius; y <= cy + radius; y++) {
        if (y < 0 || y >= h) continue;
        for (int x = cx - radius; x <= cx + radius; x++) {
            if (x < 0 || x >= w) continue;
            int p = plane_at(cfa, x, y);
            double v = (double)F.raw[y * w + x] - black;
            sum[p] += v < 0.0 ? 0.0 : v;
            cnt[p]++;
        }
    }
    /* A box too small to hold all three planes says nothing; the caller gets a
     * refusal rather than a mean over whatever happened to land in it. */
    if (!cnt[0] || !cnt[1] || !cnt[2]) return ERR_SIZE;
    for (int i = 0; i < 3; i++) out3[i] = (float)(sum[i] / cnt[i]);
    return ERR_OK;
}

/* ---- histogram ------------------------------------------------------- */
/* 3 x 256 bins over the developed RGBA, so what it shows is what is on
 * screen -- including the effect of every control above it. */
EXPORT(histogram) void histogram(const u8 *rgba, u32 px, u32 *bins) {
    for (u32 i = 0; i < 768; i++) bins[i] = 0;
    for (u32 i = 0; i < px; i++) {
        bins[rgba[i * 4]]++;
        bins[256 + rgba[i * 4 + 1]]++;
        bins[512 + rgba[i * 4 + 2]]++;
    }
}

/* ---- CFA probe ------------------------------------------------------- */
/*
 * How self-consistent the two green sites are under a given pattern.
 *
 * A Bayer quad has two green photosites on one diagonal. They see the same
 * filter, so across any scene their means land within a fraction of a percent
 * of each other. Guess the pattern with the wrong diagonal and those two
 * "green" positions are really red and blue, which almost never agree.
 *
 * That is scene-independent, which the obvious grey-world test is not: on the
 * amber frame this engine was written against, grey-world ranks the WRONG
 * pattern first, because the scene genuinely is not grey.
 *
 * What it cannot do is separate RGGB from BGGR -- they share a green diagonal
 * and differ only in which corner is red. No statistic of one frame settles
 * that; it needs either the file's own CFAPattern tag or a human looking at
 * two renders. The caller is expected to say so rather than present the top
 * score as an answer.
 */
EXPORT(cfa_score) float cfa_score(i32 cfa) {
    const int w = F.width, h = F.height;
    if (!F.raw || w < 4 || h < 4) return 0.f;

    /* Step in whole 2x2 quads and sample all four sites in each. Stepping by
     * a bare stride lands on one CFA phase for the entire scan and the other
     * three planes come back empty. */
    int quads = (w / 2) * (h / 2);
    int step = quads > (256 * 256) ? 4 : 1;

    double gsum[2] = {0, 0};
    u32 gcnt[2] = {0, 0};
    for (int qy = 0; qy < h / 2; qy += step) {
        for (int qx = 0; qx < w / 2; qx += step) {
            int x = qx * 2, y = qy * 2;
            for (int dy = 0; dy < 2; dy++)
                for (int dx = 0; dx < 2; dx++) {
                    if (plane_at(cfa, x + dx, y + dy) != 1) continue;
                    /* Gr and Gb: the green on the red row and the green on
                     * the blue row. Both greens of a quad share the same
                     * dx==dy relationship, so the row is what tells them
                     * apart. */
                    int which = dy;
                    gsum[which] += (double)F.raw[(y + dy) * w + (x + dx)];
                    gcnt[which]++;
                }
        }
    }
    if (!gcnt[0] || !gcnt[1]) return 0.f;
    float a = (float)(gsum[0] / gcnt[0]), b = (float)(gsum[1] / gcnt[1]);
    if (a <= 0.f || b <= 0.f) return 0.f;
    return a < b ? a / b : b / a;
}
