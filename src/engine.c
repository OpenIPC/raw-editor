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
static float *g_green;
static i32 g_green_cfa;
static float *g_ds;
static i32 *g_lab;
static i32 *g_stack;
static i32 g_ds_cap;

/* A bump allocator and no free(): every buffer here lives as long as the
 * frame does, and a frame is replaced wholesale. reset_alloc() is what
 * "close the file" means. */
extern u8 __heap_base;
static u32 brk = 0;

EXPORT(reset_alloc) void reset_alloc(void) {
    brk = 0;
    /* Everything the allocator handed out belonged to the frame being
     * replaced, the cached green plane included. Keeping the pointer would
     * hand the next frame the previous one's greens. */
    g_green = 0;
    g_ds = 0;
    g_lab = 0;
    g_stack = 0;
    g_ds_cap = 0;
    g_green_cfa = -1;
}

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
enum { DEMOSAIC_NONE = 0, DEMOSAIC_BILINEAR = 1, DEMOSAIC_GRADIENT = 2, DEMOSAIC_RCD = 3 };

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
    i32 black4[4];  /* BlackLevel per 2x2 position, row-major, when given */
    i32 nblack;     /* how many BlackLevel values the file carried */
    float cm[2][9]; /* ColorMatrix1/2, XYZ -> camera */
    i32 illum[2];   /* CalibrationIlluminant1/2, EXIF LightSource codes */
    i32 ncm;        /* bit per ColorMatrix present */
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
    F.nblack = 0; F.ncm = 0; F.illum[0] = F.illum[1] = 0;

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
            if (d) {
                u32 sz = (type == 3 || type == 8) ? 2 : 4;
                F.black = (i32)(sz == 2 ? rd16(d) : rd32(d));
                /* Four is a 2x2 BlackLevelRepeatDim, which is what majestic
                 * writes: the sensor's per-channel pedestals, which on an
                 * IMX335 at high gain differ by up to 16 codes in 4096
                 * (330/338/339/323 in its driver's top-gain row). */
                if (count == 4) {
                    for (u32 k = 0; k < 4; k++)
                        F.black4[k] = (i32)(sz == 2 ? rd16(d + k * 2) : rd32(d + k * 4));
                    F.nblack = 4;
                } else {
                    F.nblack = 1;
                }
            }
            break;
        case 50721: /* ColorMatrix1 */
        case 50722: /* ColorMatrix2 */
            d = entry_data(e, type, count);
            if (d && count >= 9) {
                int which = tag == 50722;
                for (u32 k = 0; k < 9; k++) F.cm[which][k] = ratio_at(d, k, 1);
                F.ncm |= 1 << which;
            }
            break;
        case 50778: F.illum[0] = (i32)scalar(e, type, count); break;
        case 50779: F.illum[1] = (i32)scalar(e, type, count); break;
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
    if (bits_seen != 8 && bits_seen != 10 && bits_seen != 12 &&
        bits_seen != 14 && bits_seen != 16)
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
EXPORT(dng_cm_ptr) const float *dng_cm_ptr(void) { return &F.cm[0][0]; }
EXPORT(dng_cm_mask) i32 dng_cm_mask(void) { return F.ncm; }
EXPORT(dng_illuminant) i32 dng_illuminant(i32 which) { return F.illum[which & 1]; }
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

    /* The packed cases below step in whole groups -- four pixels to five bytes
     * at 10 bits, two to three at 12, four to seven at 14 -- so a frame whose
     * pixel count is not a multiple of the group has a tail they do not reach.
     * A Bayer frame has even dimensions and never does, but the buffer is read
     * in full by everything downstream, so the tail is unpacked rather than
     * left to whatever the allocator last had there. Zeroing it would only make
     * the wrong answer a repeatable one: the histogram would still count it and
     * the defect scan would still find it. */

    if (F.bits == 8) {
        for (u32 i = 0; i < px; i++) o[i] = s[i];
    } else if (F.bits == 16) {
        /* Nothing to unpack: one little-endian sample per pair of bytes. The
         * older HiSilicon parts write raw this way rather than packing it, so
         * a whole class of camera arrives here and arrived, until now, at
         * "unsupported bit depth". Read byte-wise rather than through a u16
         * pointer: the strip offset carries no alignment guarantee, and TIFF
         * has never promised one. */
        for (u32 i = 0; i < px; i++) o[i] = (u16)(s[i * 2] | (s[i * 2 + 1] << 8));
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
        if (px & 1) {
            const u8 *b = s + pairs * 3;
            o[px - 1] = (u16)((b[0] << 4) | (b[1] >> 4));
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
        const u32 rest = px & 3;
        if (rest) {
            const u8 *b = s + groups * 7; u16 *d = o + groups * 4;
            if (rest > 0) d[0] = (u16)((b[0] << 6) | (b[1] >> 2));
            if (rest > 1) d[1] = (u16)(((b[1] & 0x03) << 12) | (b[2] << 4) | (b[3] >> 4));
            if (rest > 2) d[2] = (u16)(((b[3] & 0x0f) << 10) | (b[4] << 2) | (b[5] >> 6));
        }
    }
    if (F.bits == 10) {
        const u32 rest = px & 3;
        if (rest) {
            const u8 *b = s + (px >> 2) * 5; u16 *d = o + (px >> 2) * 4;
            if (rest > 0) d[0] = (u16)((b[0] << 2) | (b[1] >> 6));
            if (rest > 1) d[1] = (u16)(((b[1] & 0x3f) << 4) | (b[2] >> 4));
            if (rest > 2) d[2] = (u16)(((b[2] & 0x0f) << 6) | (b[3] >> 2));
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

/*
 * Gradient-corrected linear interpolation: Malvar, He and Cutler, 2004.
 *
 * Bilinear averages each plane over the neighbours that carry it and knows
 * nothing about the other two, so an edge that all three planes cross is
 * reconstructed three different ways and the disagreement shows up as colour
 * along it -- the zippering and the red-green fringes on a roof line.
 *
 * This adds a correction term taken from the plane that WAS measured at the
 * pixel: where that plane has a second derivative, the missing ones are
 * assumed to have most of it too. It is still one linear 5x5 filter per case,
 * so it costs a handful of multiplies over bilinear rather than the passes a
 * directional method needs, and it removes most of the colour on edges.
 *
 * The coefficients are the paper's, over 8.
 */
static inline int fold_same_plane(int v, int n) {
    /* Step back inside the frame TWO at a time, so whatever lands here carries
     * the same colour as the pixel it stands in for. Clamping would fold a red
     * neighbour in where a blue one was wanted; reflecting keeps the plane on a
     * large frame and loses it on a small one -- on a two-pixel axis,
     * 2*w-2-x sends an odd coordinate to an even one, and the correction that
     * pulls it back in range breaks the parity again. Folding by two cannot. */
    while (v < 0) v += 2;
    while (v >= n) v -= 2;
    if (v < 0) v = 0;
    return v;
}

static inline float mirrored(int x, int y, int w, int h) {
    x = fold_same_plane(x, w);
    y = fold_same_plane(y, h);
    return (float)F.raw[y * w + x];
}

static void malvar_at(int cfa, int x, int y, int w, int h, float *out) {
    const float c = mirrored(x, y, w, h);
    const float n1 = mirrored(x, y - 1, w, h), s1 = mirrored(x, y + 1, w, h);
    const float w1 = mirrored(x - 1, y, w, h), e1 = mirrored(x + 1, y, w, h);
    const float n2 = mirrored(x, y - 2, w, h), s2 = mirrored(x, y + 2, w, h);
    const float w2 = mirrored(x - 2, y, w, h), e2 = mirrored(x + 2, y, w, h);
    const float nw = mirrored(x - 1, y - 1, w, h), ne = mirrored(x + 1, y - 1, w, h);
    const float sw = mirrored(x - 1, y + 1, w, h), se = mirrored(x + 1, y + 1, w, h);

    const float cross = n1 + s1 + w1 + e1;          /* the four adjacent */
    const float diag = nw + ne + sw + se;           /* the four corners */
    const float far = n2 + s2 + w2 + e2;            /* two away, same plane */
    const float vert = n2 + s2, horz = w2 + e2;

    const int p = plane_at(cfa, x, y);
    if (p == 1) {
        /* Green measured. The other two are each on one axis: one plane along
         * the row, the other down the column. plane_at of a neighbour says
         * which way round this green is. */
        const int rowPlane = plane_at(cfa, x + 1, y);      /* 0 or 2 */
        /* The paper's kernel takes -1 along the axis it interpolates ALONG
         * and +1/2 across it. Folding both into one "subtract everything two
         * away, then add back half" turns that +1/2 into -1/2, which is worse
         * than bilinear -- measured at 10.4 against 5.2 mean error before the
         * sign was put right. */
        const float alongRow = 5.f * c + 4.f * (w1 + e1) - horz + 0.5f * vert - diag;
        const float alongCol = 5.f * c + 4.f * (n1 + s1) - vert + 0.5f * horz - diag;
        out[1] = c;
        out[rowPlane] = alongRow * 0.125f;
        out[rowPlane == 0 ? 2 : 0] = alongCol * 0.125f;
    } else {
        /* Red or blue measured: green comes off the cross with a correction
         * from this plane's curvature, and the opposite plane off the
         * diagonals. */
        out[p] = c;
        out[1] = (4.f * c + 2.f * cross - far) * 0.125f;
        out[p == 0 ? 2 : 0] = (6.f * c + 2.f * diag - 1.5f * far) * 0.125f;
    }
}

/* ---- RCD -------------------------------------------------------------
 *
 * Ratio-corrected demosaicing, after the method Luis Sanz Rodriguez
 * published: decide at every red and blue site whether the detail there runs
 * across or down, interpolate green along whichever it is, and correct that
 * interpolation by the RATIO between the site and its own colour's low pass
 * rather than by adding a difference. Then carry red and blue as colour
 * DIFFERENCES against the finished green, which is where most of the colour
 * on edges comes from in the first place.
 *
 * Written from the method, not ported: RawTherapee's implementation is GPLv3
 * and this tree is not, so its code could not be used here even though it is
 * the reference everyone means by "RCD".
 *
 * Unlike bilinear and the gradient filter, this cannot be done one output
 * pixel at a time -- the chroma step needs green everywhere first -- so the
 * green plane is built once per frame and kept.
 */
static inline int fold_same_plane(int v, int n);
static inline float clampf(float v, float lo, float hi);

static inline float rawf(int x, int y, int w, int h) {
    return (float)F.raw[fold_same_plane(y, h) * w + fold_same_plane(x, w)];
}

static inline float gp(int x, int y, int w, int h) {
    return g_green[fold_same_plane(y, h) * w + fold_same_plane(x, w)];
}

static void rcd_build_green(i32 cfa) {
    const int w = F.width, h = F.height;
    if (g_green && g_green_cfa == cfa) return;
    if (!g_green) {
        g_green = (float *)alloc((u32)w * (u32)h * 4u);
        if (!g_green) return;
    }
    g_green_cfa = cfa;

    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            if (plane_at(cfa, x, y) == 1) {
                g_green[y * w + x] = (float)F.raw[y * w + x];
                continue;
            }
            const float c = rawf(x, y, w, h);
            const float n1 = rawf(x, y - 1, w, h), s1 = rawf(x, y + 1, w, h);
            const float w1 = rawf(x - 1, y, w, h), e1 = rawf(x + 1, y, w, h);
            const float n2 = rawf(x, y - 2, w, h), s2 = rawf(x, y + 2, w, h);
            const float w2 = rawf(x - 2, y, w, h), e2 = rawf(x + 2, y, w, h);

            /* Which way the detail runs. The first term is the slope across the
             * pair of greens, the second the curvature of this site's own
             * colour: an edge shows in one and a fine line in the other. */
            const float dh = (w1 > e1 ? w1 - e1 : e1 - w1)
                + ((2.f * c - w2 - e2) > 0.f ? (2.f * c - w2 - e2) : -(2.f * c - w2 - e2));
            const float dv = (n1 > s1 ? n1 - s1 : s1 - n1)
                + ((2.f * c - n2 - s2) > 0.f ? (2.f * c - n2 - s2) : -(2.f * c - n2 - s2));
            const float wh = 1.f / (1.f + dh * dh);
            const float wv = 1.f / (1.f + dv * dv);

            /*
             * The ratio correction. The mean of the two greens is scaled by how
             * this site compares with the mean of its own colour two away,
             * instead of having that difference added to it. Where the picture
             * is bright the two agree; where it is dark the ratio keeps the
             * result inside the values around it, which is what stops the
             * overshoot an additive correction gives on a hard edge.
             */
            const float eps = 1.f;
            float gh = 0.5f * (w1 + e1) * ((c + eps) / (0.5f * (w2 + e2) + eps));
            float gv = 0.5f * (n1 + s1) * ((c + eps) / (0.5f * (n2 + s2) + eps));

            /* Kept inside the pair it was interpolated from, so a ratio taken
             * across a big step cannot run away. */
            const float hlo = w1 < e1 ? w1 : e1, hhi = w1 < e1 ? e1 : w1;
            const float vlo = n1 < s1 ? n1 : s1, vhi = n1 < s1 ? s1 : n1;
            const float hpad = 0.5f * (hhi - hlo) + 64.f;
            const float vpad = 0.5f * (vhi - vlo) + 64.f;
            gh = clampf(gh, hlo - hpad, hhi + hpad);
            gv = clampf(gv, vlo - vpad, vhi + vpad);

            g_green[y * w + x] = (wh * gh + wv * gv) / (wh + wv);
        }
    }
}

/* Red and blue, as differences against the green that is already there. */
static void rcd_at(i32 cfa, int x, int y, int w, int h, float *out) {
    const int p = plane_at(cfa, x, y);
    const float g = g_green[y * w + x];
    out[1] = g;

    if (p == 1) {
        /* A green site: one colour lies along the row, the other down the
         * column, each one pixel away. */
        const int rowPlane = plane_at(cfa, x + 1, y);
        const float along = 0.5f * ((rawf(x - 1, y, w, h) - gp(x - 1, y, w, h))
            + (rawf(x + 1, y, w, h) - gp(x + 1, y, w, h)));
        const float down = 0.5f * ((rawf(x, y - 1, w, h) - gp(x, y - 1, w, h))
            + (rawf(x, y + 1, w, h) - gp(x, y + 1, w, h)));
        out[rowPlane] = g + along;
        out[rowPlane == 0 ? 2 : 0] = g + down;
    } else {
        out[p] = (float)F.raw[y * w + x];
        /* The opposite colour sits on the four diagonals. Weighted the same way
         * as the green was, so a diagonal edge is followed rather than averaged
         * across. */
        const float d[4] = {
            rawf(x - 1, y - 1, w, h) - gp(x - 1, y - 1, w, h),
            rawf(x + 1, y - 1, w, h) - gp(x + 1, y - 1, w, h),
            rawf(x - 1, y + 1, w, h) - gp(x - 1, y + 1, w, h),
            rawf(x + 1, y + 1, w, h) - gp(x + 1, y + 1, w, h),
        };
        const float a = d[0] - d[3], b = d[1] - d[2];
        const float wa = 1.f / (1.f + a * a), wb = 1.f / (1.f + b * b);
        const float ndg = (wa * (d[0] + d[3]) * 0.5f + wb * (d[1] + d[2]) * 0.5f) / (wa + wb);
        out[p == 0 ? 2 : 0] = g + ndg;
    }
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
    /* RCD carries red and blue as differences against green, so it needs green
     * everywhere before it can place a single output pixel. Built once for the
     * frame and kept, rather than per pixel like the filters above. */
    if (demosaic == DEMOSAIC_RCD) {
        rcd_build_green(cfa);
        if (!g_green) return ERR_SIZE;
    }
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
            } else if (demosaic == DEMOSAIC_RCD) {
                float m[3];
                rcd_at(cfa, x, y, w, h, m);
                for (int p = 0; p < 3; p++)
                    c3[p] = clampf((m[p] - black) * inv, 0.f, 1.f);
            } else if (demosaic == DEMOSAIC_GRADIENT) {
                float m[3];
                malvar_at(cfa, x, y, w, h, m);
                for (int p = 0; p < 3; p++)
                    c3[p] = clampf((m[p] - black) * inv, 0.f, 1.f);
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

            /*
             * White balance, with any plane that reached the sensor ceiling
             * rebuilt from the planes that did not.
             *
             * Clipping is per plane and so is the white balance, which is why
             * the two go wrong together. Green carries a gain of 1.0 and
             * saturates first; red and blue are then scaled past it, and a
             * white car in daylight arrives at the matrix as the reciprocal
             * of AsShotNeutral -- (1.98, 1.00, 1.84), which is not white but
             * magenta, rendered faithfully as such. Measured on a
             * hi3516ev300 + imx335 car park: sRGB 255,194,255, against
             * 253,253,254 from dcraw on the same file.
             *
             * Clamping to 1 would neutralise that, but it would also discard
             * the headroom every unclipped plane has above the neutral -- and
             * pulling that back is exactly what the Exposure slider is for.
             * The same highlight at -2 stops reads 136,135,137 clamped and
             * 177,177,181 with the headroom kept, so clamping costs a real
             * stop of the thing the control exists to recover.
             *
             * So a plane that saturated is raised to the brightest plane that
             * did not: the best lower bound the pixel offers for a value the
             * sensor stopped measuring. A plane that never saturated is left
             * alone, headroom and all. When every plane saturated there is
             * nothing left to measure against, and the largest of them is the
             * bound -- which is what puts a fully blown neutral back at white.
             *
             * This is the floor of highlight reconstruction and not the
             * ceiling; anything better has to model the subject.
             */
            {
                int blown = 0;
                for (int p = 0; p < 3; p++) {
                    /* c3 was clamped into [0,1] above, so a plane that
                     * reached the white level is exactly 1 by now. */
                    if (c3[p] >= 1.f) blown |= 1 << p;
                    c3[p] /= neu[p];
                }
                /* Nothing saturated is the overwhelmingly common case -- 99.5%
                 * of the frame this was measured on -- so the reconstruction
                 * sits behind a branch rather than in the per-pixel path. */
                if (blown) {
                    float ref = 0.f;
                    if (blown == 7) {
                        ref = c3[0] > c3[1] ? c3[0] : c3[1];
                        if (c3[2] > ref) ref = c3[2];
                    } else {
                        for (int p = 0; p < 3; p++)
                            if (!(blown >> p & 1) && c3[p] > ref) ref = c3[p];
                    }
                    for (int p = 0; p < 3; p++)
                        if ((blown >> p & 1) && c3[p] < ref) c3[p] = ref;
                }
            }

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
 *
 * out4[3] is the fraction of the box that was set aside as clipped, so a
 * patch that is mostly ADC ceiling can be weighed accordingly rather than
 * trusted.
 */
EXPORT(sample_patch) i32 sample_patch(i32 cx, i32 cy, i32 radius, i32 black,
                                      i32 cfa, float *out4) {
    const int w = F.width, h = F.height;
    if (!F.raw || !out4) return ERR_SIZE;
    if (radius < 1) radius = 1;

    /* The file's own per-position pedestals, but only while the caller is
     * using the file's black level: a slider someone moved is a decision about
     * the whole frame, and it wins. */
    const int per_pos = F.nblack == 4 && black == F.black;

    /* A clipped photosite is not a measurement of the patch, it is a
     * measurement of the ADC. Left in, it pulls the chart's white -- the patch
     * a white balance leans on hardest -- toward whatever the other channels
     * clipped at, and the fit is then asked to explain a colour the chart does
     * not have. Anything within 2% of the white level is set aside. */
    const i32 white = F.white > 0 ? F.white : (1 << (F.bits > 0 ? F.bits : 16)) - 1;

    double sum[3] = {0.0, 0.0, 0.0}, all[3] = {0.0, 0.0, 0.0};
    u32 cnt[3] = {0, 0, 0}, tot[3] = {0, 0, 0}, clipped = 0, seen = 0;
    for (int y = cy - radius; y <= cy + radius; y++) {
        if (y < 0 || y >= h) continue;
        for (int x = cx - radius; x <= cx + radius; x++) {
            if (x < 0 || x >= w) continue;
            int p = plane_at(cfa, x, y);
            i32 b = per_pos ? F.black4[((y & 1) << 1) | (x & 1)] : black;
            i32 raw = F.raw[y * w + x];
            double v = (double)raw - b;
            if (v < 0.0) v = 0.0;
            all[p] += v; tot[p]++; seen++;
            if (raw >= b + (white - b) * 49 / 50) { clipped++; continue; }
            sum[p] += v;
            cnt[p]++;
        }
    }
    /* A box too small to hold all three planes says nothing; the caller gets a
     * refusal rather than a mean over whatever happened to land in it. */
    if (!tot[0] || !tot[1] || !tot[2]) return ERR_SIZE;
    /* A plane with nothing left unclipped is reported from everything, and the
     * fraction says so -- the caller decides whether to trust it. */
    for (int i = 0; i < 3; i++)
        out4[i] = (float)(cnt[i] ? sum[i] / cnt[i] : all[i] / tot[i]);
    out4[3] = (float)clipped / (float)seen;
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

/* ---- find the chart --------------------------------------------------
 *
 * Where the colour chart is, without being told.
 *
 * The chart is the only thing in a normal frame that is two dozen flat
 * patches of similar size sitting on a regular lattice. Nothing here looks at
 * colour -- a chart photographed under a red lamp is still a chart -- only at
 * shape and arrangement, which is what survives the lighting.
 *
 *   1. shrink the mosaic to a small luma image, working from the greens;
 *   2. mark every pixel whose 3x3 neighbourhood is flat;
 *   3. label the connected flat regions, which are the patches, because the
 *      dark gaps between them are not flat;
 *   4. take each region with a plausible shape as a candidate, and for pairs
 *      of near neighbours propose the lattice they imply;
 *   5. score a lattice by how many of the 24 cells actually contain a
 *      candidate, and keep the best.
 *
 * Step 5 is what makes it robust: a wall or a door panel produces one big flat
 * region, never two dozen on a grid, so it cannot score. The answer is the
 * four corners, and the caller is free to nudge them -- detection assists the
 * corners, it does not replace them.
 */
#define CHART_COLS 6
#define CHART_ROWS 4
#define CHART_DS_TARGET 360      /* the small image is about this wide */
#define CHART_MAX_BLOBS 512
#define CHART_NEIGHBOURS 8

typedef struct { float cx, cy, area, w, h; } Blob;

static i32 chart_downscale(i32 cfa, int *dw, int *dh, int *scale) {
    const int w = F.width, h = F.height;
    int sc = w / CHART_DS_TARGET;
    if (sc < 1) sc = 1;
    sc &= ~1;                    /* whole CFA quads, so every block sees green */
    if (sc < 2) sc = 2;
    const int ow = w / sc, oh = h / sc;
    if (ow < 24 || oh < 16) return ERR_SIZE;
    const u32 need = (u32)ow * (u32)oh;
    if (!g_ds || g_ds_cap < (i32)need) {
        g_ds = (float *)alloc(need * 4u);
        g_lab = (i32 *)alloc(need * 4u);
        g_stack = (i32 *)alloc(need * 4u);
        if (!g_ds || !g_lab || !g_stack) { g_ds = 0; return ERR_SIZE; }
        g_ds_cap = (i32)need;
    }
    for (int y = 0; y < oh; y++)
        for (int x = 0; x < ow; x++) {
            double sum = 0; int n = 0;
            for (int by = 0; by < sc; by++)
                for (int bx = 0; bx < sc; bx++) {
                    const int px = x * sc + bx, py = y * sc + by;
                    if (px >= w || py >= h) continue;
                    if (plane_at(cfa, px, py) != 1) continue;   /* greens carry the luma */
                    sum += F.raw[py * w + px];
                    n++;
                }
            g_ds[y * ow + x] = n ? (float)(sum / n) : 0.f;
        }
    *dw = ow; *dh = oh; *scale = sc;
    return ERR_OK;
}

/* Corners of the quad the lattice implies, half a cell out from the centres of
 * the four corner patches. */
static void chart_corners_from(const float *o, const float *s1, const float *s2,
                               int cols, int rows, float *out8) {
    const float half1[2] = { s1[0] * 0.5f, s1[1] * 0.5f };
    const float half2[2] = { s2[0] * 0.5f, s2[1] * 0.5f };
    const int cc = cols - 1, rr = rows - 1;
    /* top-left, top-right, bottom-right, bottom-left, in chart order */
    out8[0] = o[0] - half1[0] - half2[0];
    out8[1] = o[1] - half1[1] - half2[1];
    out8[2] = o[0] + s1[0] * cc + half1[0] - half2[0];
    out8[3] = o[1] + s1[1] * cc + half1[1] - half2[1];
    out8[4] = o[0] + s1[0] * cc + half1[0] + s2[0] * rr + half2[0];
    out8[5] = o[1] + s1[1] * cc + half1[1] + s2[1] * rr + half2[1];
    out8[6] = o[0] - half1[0] + s2[0] * rr + half2[0];
    out8[7] = o[1] - half1[1] + s2[1] * rr + half2[1];
}

/*
 * out8 receives the four corners in full-frame pixels, chart order: the patch
 * that reads top-left first, then clockwise. Returns how many of the 24 cells
 * were actually found, so a caller can refuse a weak answer; 0 means no
 * lattice worth reporting.
 */
EXPORT(detect_chart) i32 detect_chart(i32 cfa, float *out8) {
    int dw, dh, sc;
    if (!F.raw || !out8) return ERR_SIZE;
    if (chart_downscale(cfa, &dw, &dh, &sc) != ERR_OK) return 0;
    const int n = dw * dh;

    /* How flat is flat? Taken from the picture rather than picked: the median
     * of the local ranges, so a noisy frame and a clean one both get a
     * threshold that means the same thing. */
    float thr;
    {
        static u32 hist[1024];
        for (int i = 0; i < 1024; i++) hist[i] = 0;
        float maxr = 1.f;
        for (int y = 1; y < dh - 1; y++)
            for (int x = 1; x < dw - 1; x++) {
                float lo = g_ds[y * dw + x], hi = lo;
                for (int oy = -1; oy <= 1; oy++)
                    for (int ox = -1; ox <= 1; ox++) {
                        const float v = g_ds[(y + oy) * dw + (x + ox)];
                        if (v < lo) lo = v;
                        if (v > hi) hi = v;
                    }
                const float r = hi - lo;
                if (r > maxr) maxr = r;
            }
        for (int y = 1; y < dh - 1; y++)
            for (int x = 1; x < dw - 1; x++) {
                float lo = g_ds[y * dw + x], hi = lo;
                for (int oy = -1; oy <= 1; oy++)
                    for (int ox = -1; ox <= 1; ox++) {
                        const float v = g_ds[(y + oy) * dw + (x + ox)];
                        if (v < lo) lo = v;
                        if (v > hi) hi = v;
                    }
                int b = (int)((hi - lo) / maxr * 1023.f);
                if (b > 1023) b = 1023;
                hist[b]++;
            }
        u32 total = 0;
        for (int i = 0; i < 1024; i++) total += hist[i];
        /*
         * A MULTIPLE of the noise, not a percentile of everything.
         *
         * Most of a frame is flat, so the median local range is essentially
         * the noise -- and setting the threshold there means half of every
         * flat area fails it, which shatters the patches into speckle instead
         * of filling them. Measured: 230 regions on a frame with 24 patches,
         * the largest of them 47 pixels where a patch is about 1200.
         *
         * Three times the noise fills a flat patch completely and still stops
         * dead at the gaps between them, which are hundreds of counts.
         */
        u32 seen = 0; int med = 0;
        for (int i = 0; i < 1024; i++) { seen += hist[i]; if (seen * 2 >= total) { med = i; break; } }
        thr = (float)med / 1023.f * maxr * 3.f;
        if (thr < 1.f) thr = 1.f;
    }

    for (int i = 0; i < n; i++) g_lab[i] = -1;
    Blob blobs[CHART_MAX_BLOBS];
    int nb = 0;

    for (int y = 1; y < dh - 1 && nb < CHART_MAX_BLOBS; y++) {
        for (int x = 1; x < dw - 1 && nb < CHART_MAX_BLOBS; x++) {
            const int start = y * dw + x;
            if (g_lab[start] != -1) continue;
            float lo = g_ds[start], hi = lo;
            for (int oy = -1; oy <= 1; oy++)
                for (int ox = -1; ox <= 1; ox++) {
                    const float v = g_ds[(y + oy) * dw + (x + ox)];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
            if (hi - lo > thr) { g_lab[start] = -2; continue; }

            int sp = 0, count = 0;
            double sx = 0, sy = 0;
            int minx = x, maxx = x, miny = y, maxy = y;
            g_stack[sp++] = start;
            g_lab[start] = nb;
            while (sp > 0) {
                const int p = g_stack[--sp];
                const int px = p % dw, py = p / dw;
                count++; sx += px; sy += py;
                if (px < minx) minx = px;
                if (px > maxx) maxx = px;
                if (py < miny) miny = py;
                if (py > maxy) maxy = py;
                const int nbr[4] = { p - 1, p + 1, p - dw, p + dw };
                const int okx[4] = { px > 1, px < dw - 2, 1, 1 };
                for (int k = 0; k < 4; k++) {
                    if (!okx[k]) continue;
                    const int q = nbr[k];
                    if (q < dw || q >= n - dw) continue;
                    if (g_lab[q] != -1) continue;
                    const int qx = q % dw, qy = q / dw;
                    if (qx < 1 || qx >= dw - 1 || qy < 1 || qy >= dh - 1) { g_lab[q] = -2; continue; }
                    float qlo = g_ds[q], qhi = qlo;
                    for (int oy = -1; oy <= 1; oy++)
                        for (int ox = -1; ox <= 1; ox++) {
                            const float v = g_ds[(qy + oy) * dw + (qx + ox)];
                            if (v < qlo) qlo = v;
                            if (v > qhi) qhi = v;
                        }
                    if (qhi - qlo > thr) { g_lab[q] = -2; continue; }
                    g_lab[q] = nb;
                    if (sp < n) g_stack[sp++] = q;
                }
            }
            const float bw = (float)(maxx - minx + 1), bh = (float)(maxy - miny + 1);
            /* A patch is a solid, roughly square lump. A wall is far too big
             * and a noise speck far too small; a door frame is long and thin. */
            if (count < 6 || count > n / 12) continue;
            if (bw < 2.f || bh < 2.f) continue;
            const float aspect = bw > bh ? bw / bh : bh / bw;
            if (aspect > 2.2f) continue;
            if ((float)count < 0.55f * bw * bh) continue;
            blobs[nb].cx = (float)(sx / count);
            blobs[nb].cy = (float)(sy / count);
            blobs[nb].area = (float)count;
            blobs[nb].w = bw; blobs[nb].h = bh;
            nb++;
        }
    }
    if (nb < 12) return 0;

    /* The lattice. Each candidate proposes, with two of its near neighbours,
     * the two steps of a grid; every other candidate then votes by landing on
     * a cell of it or not. */
    int best = 0;
    float bo[2] = {0, 0}, bs1[2] = {0, 0}, bs2[2] = {0, 0};
    int bcols = CHART_COLS, brows = CHART_ROWS;

    for (int i = 0; i < nb; i++) {
        int near[CHART_NEIGHBOURS];
        float nd[CHART_NEIGHBOURS];
        int nn = 0;
        for (int j = 0; j < nb; j++) {
            if (j == i) continue;
            const float dx = blobs[j].cx - blobs[i].cx, dy = blobs[j].cy - blobs[i].cy;
            const float d = dx * dx + dy * dy;
            if (nn < CHART_NEIGHBOURS) { near[nn] = j; nd[nn] = d; nn++; }
            else {
                int worst = 0;
                for (int k = 1; k < nn; k++) if (nd[k] > nd[worst]) worst = k;
                if (d < nd[worst]) { near[worst] = j; nd[worst] = d; }
            }
        }
        for (int a = 0; a < nn; a++) {
            for (int b = 0; b < nn; b++) {
                if (a == b) continue;
                float s1[2] = { blobs[near[a]].cx - blobs[i].cx, blobs[near[a]].cy - blobs[i].cy };
                float s2[2] = { blobs[near[b]].cx - blobs[i].cx, blobs[near[b]].cy - blobs[i].cy };
                const float l1 = s1[0] * s1[0] + s1[1] * s1[1];
                const float l2 = s2[0] * s2[0] + s2[1] * s2[1];
                if (l1 < 4.f || l2 < 4.f) continue;
                /* Roughly the same pitch both ways, and roughly square to each
                 * other: the chart's cells are, whatever angle it is seen at. */
                const float ratio = l1 > l2 ? l1 / l2 : l2 / l1;
                if (ratio > 2.0f) continue;
                const float dot = s1[0] * s2[0] + s1[1] * s2[1];
                if (dot * dot > 0.25f * l1 * l2) continue;

                /* Invert the two steps so a candidate can be asked which cell
                 * it would be. */
                const float det = s1[0] * s2[1] - s1[1] * s2[0];
                if (det > -1e-3f && det < 1e-3f) continue;
                const float inv[4] = { s2[1] / det, -s2[0] / det, -s1[1] / det, s1[0] / det };

                for (int orient = 0; orient < 2; orient++) {
                    const int cols = orient ? CHART_ROWS : CHART_COLS;
                    const int rows = orient ? CHART_COLS : CHART_ROWS;
                    /* Where the corner cell would be, if this candidate is the
                     * cell at (ox,oy) of the grid. Every placement is tried. */
                    for (int oy = 0; oy < rows; oy++) {
                        for (int ox = 0; ox < cols; ox++) {
                            unsigned char seen[CHART_COLS * CHART_ROWS];
                            for (int k = 0; k < cols * rows; k++) seen[k] = 0;
                            int hits = 0;
                            for (int j = 0; j < nb; j++) {
                                const float dx = blobs[j].cx - blobs[i].cx;
                                const float dy = blobs[j].cy - blobs[i].cy;
                                const float u = inv[0] * dx + inv[1] * dy;
                                const float v = inv[2] * dx + inv[3] * dy;
                                const float ru = u < 0 ? -(float)(int)(0.5f - u) : (float)(int)(u + 0.5f);
                                const float rv = v < 0 ? -(float)(int)(0.5f - v) : (float)(int)(v + 0.5f);
                                const float eu = u - ru, ev = v - rv;
                                if (eu * eu + ev * ev > 0.09f) continue;   /* within 0.3 of a cell */
                                /* And the same size as the patch that proposed
                                 * the lattice. A chart's cells are all one
                                 * size; a scattering of background regions is
                                 * not, so this is what stops a grid being
                                 * found in things that merely happen to line
                                 * up. */
                                const float ar = blobs[j].area > blobs[i].area
                                    ? blobs[j].area / blobs[i].area
                                    : blobs[i].area / blobs[j].area;
                                if (ar > 2.0f) continue;
                                const int cu = (int)ru + ox, cv = (int)rv + oy;
                                if (cu < 0 || cu >= cols || cv < 0 || cv >= rows) continue;
                                if (seen[cv * cols + cu]) continue;
                                seen[cv * cols + cu] = 1;
                                hits++;
                            }
                            if (hits > best) {
                                best = hits;
                                bo[0] = blobs[i].cx - s1[0] * ox - s2[0] * oy;
                                bo[1] = blobs[i].cy - s1[1] * ox - s2[1] * oy;
                                bs1[0] = s1[0]; bs1[1] = s1[1];
                                bs2[0] = s2[0]; bs2[1] = s2[1];
                                bcols = cols; brows = rows;
                            }
                        }
                    }
                }
            }
        }
    }

    /* Three quarters of the chart, or it is not a chart. Low enough that a
     * patch lost to a reflection or a shadow does not sink the answer, high
     * enough that a coincidence cannot reach it. */
    if (best < 18) return 0;

    /* The long axis is the chart's six columns. The search is free to call
     * either step "across", so whichever one spans six cells becomes s1 --
     * otherwise the corners come back describing the chart stood on end. */
    if (bcols != CHART_COLS) {
        float t[2];
        t[0] = bs1[0]; t[1] = bs1[1];
        bs1[0] = bs2[0]; bs1[1] = bs2[1];
        bs2[0] = t[0]; bs2[1] = t[1];
        bcols = CHART_COLS; brows = CHART_ROWS;
    }

    /*
     * The basis has to be right-handed before anything is asked of it.
     *
     * Nothing so far has fixed which way round the two steps run: the lattice
     * search takes them from whichever neighbours it happened to try, and the
     * swap just above exchanges them, which reverses the handedness outright.
     * A left-handed basis describes the chart MIRRORED, and a camera cannot
     * see a flat chart mirrored -- so the placements built from it are all
     * wrong, and the ramp test below then chooses between two of them and
     * reports the less wrong one with every appearance of success. On the lab
     * frame it did exactly that: the quad landed on the chart to the pixel,
     * wound the wrong way round, with the patches numbered from the far
     * corner.
     *
     * Negating the row step fixes the handedness; moving the origin to the
     * far row keeps the lattice over the same blobs. What is left is the two
     * proper placements -- a chart the right way up and the same chart turned
     * 180 degrees -- which is exactly what the ramp test is able to decide.
     */
    if (bs1[0] * bs2[1] - bs1[1] * bs2[0] < 0.f) {
        bo[0] += bs2[0] * (float)(brows - 1);
        bo[1] += bs2[1] * (float)(brows - 1);
        bs2[0] = -bs2[0]; bs2[1] = -bs2[1];
    }

    /*
     * Which end is the top left.
     *
     * A lattice is symmetric: nothing about the grid says which corner holds
     * the dark skin patch and which the black one, and getting it wrong hands
     * the solver twenty-four patches in the wrong order -- which it cannot
     * detect, because every one of them is a plausible colour.
     *
     * The chart says so itself, without anybody looking at colour: its bottom
     * row is the neutral ramp, and a ramp runs one way. Both placements are
     * scored by how steadily that row falls from white to black, and the
     * better one wins. Turned 180 degrees, a falling ramp reads as a rising
     * one, so the two are never close.
     */
    {
        float bestFall = -1e30f;
        float fo[2], f1[2], f2[2];
        fo[0] = bo[0]; fo[1] = bo[1];
        f1[0] = bs1[0]; f1[1] = bs1[1];
        f2[0] = bs2[0]; f2[1] = bs2[1];
        for (int flip = 0; flip < 2; flip++) {
            float o[2], s1[2], s2[2];
            if (!flip) {
                o[0] = bo[0]; o[1] = bo[1];
                s1[0] = bs1[0]; s1[1] = bs1[1];
                s2[0] = bs2[0]; s2[1] = bs2[1];
            } else {
                /* The same grid entered from the opposite corner. */
                o[0] = bo[0] + bs1[0] * (CHART_COLS - 1) + bs2[0] * (CHART_ROWS - 1);
                o[1] = bo[1] + bs1[1] * (CHART_COLS - 1) + bs2[1] * (CHART_ROWS - 1);
                s1[0] = -bs1[0]; s1[1] = -bs1[1];
                s2[0] = -bs2[0]; s2[1] = -bs2[1];
            }
            /*
             * MONOTONIC, not merely falling. A ramp goes down at every step;
             * the top row of a chart, read backwards, can easily go down
             * overall while wandering on the way -- on the lab frame it did,
             * and the chart came back upside down with its patches handed to
             * the solver in the wrong order, which nothing downstream could
             * have noticed because every one of them is a plausible colour.
             *
             * So the steps that go the right way are counted, and the size of
             * the fall only breaks ties.
             */
            float fall = 0.f;
            float prev = 0.f;
            int steps = 0, ok = 1;
            for (int c = 0; c < CHART_COLS; c++) {
                const float px = o[0] + s1[0] * c + s2[0] * (CHART_ROWS - 1);
                const float py = o[1] + s1[1] * c + s2[1] * (CHART_ROWS - 1);
                const int ix = (int)(px + 0.5f), iy = (int)(py + 0.5f);
                if (ix < 1 || iy < 1 || ix >= dw - 1 || iy >= dh - 1) { ok = 0; break; }
                /* The mean of a small block: one pixel of a downscaled frame is
                 * still one noisy sample. */
                float v = 0.f;
                for (int oy = -1; oy <= 1; oy++)
                    for (int ox = -1; ox <= 1; ox++) v += g_ds[(iy + oy) * dw + (ix + ox)];
                v /= 9.f;
                if (c) { fall += prev - v; if (v < prev) steps++; }
                prev = v;
            }
            if (!ok) continue;
            /* Each step the right way is worth more than any amount of fall. */
            fall += (float)steps * 1e6f;
            if (fall > bestFall) {
                bestFall = fall;
                fo[0] = o[0]; fo[1] = o[1];
                f1[0] = s1[0]; f1[1] = s1[1];
                f2[0] = s2[0]; f2[1] = s2[1];
            }
        }
        bo[0] = fo[0]; bo[1] = fo[1];
        bs1[0] = f1[0]; bs1[1] = f1[1];
        bs2[0] = f2[0]; bs2[1] = f2[1];
    }

    /*
     * The lattice is affine -- two steps and an origin -- and a chart seen at
     * an angle is not: its far cells are closer together than its near ones.
     * Reading the corners straight off the lattice put them 27 px out on a
     * frame where a square chart was 1.8.
     *
     * Every matched patch knows its cell now, so the mapping from chart space
     * to the picture can be solved properly, from all of them at once, and the
     * corners read off that.
     */
    float c8[8];
    {
        float A[8][9];
        int rows_used = 0;
        float src[CHART_COLS * CHART_ROWS][2], dst[CHART_COLS * CHART_ROWS][2];
        int m = 0;
        const float det = bs1[0] * bs2[1] - bs1[1] * bs2[0];
        const float inv[4] = { bs2[1] / det, -bs2[0] / det, -bs1[1] / det, bs1[0] / det };
        for (int j = 0; j < nb && m < CHART_COLS * CHART_ROWS; j++) {
            const float dx = blobs[j].cx - bo[0], dy = blobs[j].cy - bo[1];
            const float u = inv[0] * dx + inv[1] * dy, v = inv[2] * dx + inv[3] * dy;
            const int cu = (int)(u + (u < 0 ? -0.5f : 0.5f));
            const int cv = (int)(v + (v < 0 ? -0.5f : 0.5f));
            if (cu < 0 || cu >= bcols || cv < 0 || cv >= brows) continue;
            const float eu = u - cu, ev = v - cv;
            if (eu * eu + ev * ev > 0.09f) continue;
            /* Chart space: the centre of cell (cu,cv) in a unit square. */
            src[m][0] = ((float)cu + 0.5f) / (float)bcols;
            src[m][1] = ((float)cv + 0.5f) / (float)brows;
            dst[m][0] = blobs[j].cx;
            dst[m][1] = blobs[j].cy;
            m++;
        }
        /* Eight unknowns, so eight equations from the normal form: every pair
         * contributes two rows and they are accumulated rather than stored. */
        float N[8][9];
        for (int r = 0; r < 8; r++) for (int c = 0; c < 9; c++) N[r][c] = 0.f;
        for (int k = 0; k < m; k++) {
            const float u = src[k][0], v = src[k][1], X = dst[k][0], Y = dst[k][1];
            const float r1[9] = { u, v, 1, 0, 0, 0, -u * X, -v * X, X };
            const float r2[9] = { 0, 0, 0, u, v, 1, -u * Y, -v * Y, Y };
            for (int a = 0; a < 8; a++)
                for (int b = 0; b < 9; b++)
                    N[a][b] += r1[a] * r1[b] + r2[a] * r2[b];
        }
        (void)A; (void)rows_used;
        /* Gauss-Jordan with partial pivoting on the 8x9 normal system. */
        int ok = m >= 6;
        for (int col = 0; col < 8 && ok; col++) {
            int piv = col;
            for (int r = col + 1; r < 8; r++)
                if ((N[r][col] < 0 ? -N[r][col] : N[r][col]) >
                    (N[piv][col] < 0 ? -N[piv][col] : N[piv][col])) piv = r;
            const float pv = N[piv][col];
            if (pv > -1e-9f && pv < 1e-9f) { ok = 0; break; }
            for (int c = 0; c < 9; c++) { const float t = N[col][c]; N[col][c] = N[piv][c]; N[piv][c] = t; }
            for (int r = 0; r < 8; r++) {
                if (r == col) continue;
                const float f = N[r][col] / N[col][col];
                for (int c = col; c < 9; c++) N[r][c] -= f * N[col][c];
            }
        }
        if (ok) {
            float H[9];
            for (int r = 0; r < 8; r++) H[r] = N[r][8] / N[r][r];
            H[8] = 1.f;
            const float uu[4] = {0.f, 1.f, 1.f, 0.f}, vv[4] = {0.f, 0.f, 1.f, 1.f};
            for (int k = 0; k < 4; k++) {
                const float wq = H[6] * uu[k] + H[7] * vv[k] + H[8];
                c8[k * 2] = (H[0] * uu[k] + H[1] * vv[k] + H[2]) / wq;
                c8[k * 2 + 1] = (H[3] * uu[k] + H[4] * vv[k] + H[5]) / wq;
            }
        } else {
            chart_corners_from(bo, bs1, bs2, bcols, brows, c8);
        }
    }
    for (int k = 0; k < 8; k++) out8[k] = c8[k] * (float)sc + (float)sc * 0.5f;
    return best;
}

/* ---- diagnose --------------------------------------------------------
 *
 * What is wrong with the sensor rather than with the picture: pixels that do
 * not work, a black level the file may be lying about, highlights already
 * gone, and how much of what is left is noise.
 *
 * Everything here is measured on the MOSAIC. A demosaiced frame has had every
 * one of these smeared across its neighbours -- a dead pixel becomes a soft
 * dark spot, clipping spreads into channels that never clipped -- so a
 * diagnosis taken from the developed image would be a diagnosis of the
 * interpolation.
 *
 * No square root anywhere: this translation unit has no libc, which is why the
 * gamma curve is built in JS. The noise comes back as a VARIANCE and the
 * caller takes the root, and the defect test compares squares so it never
 * needs one.
 */

/* Where the same plane sits two pixels away, which is the nearest pixel that
 * measures the same colour. Returns 4 only when all four exist. */
static inline int same_plane_neighbours(int x, int y, int w, int h, u16 *out) {
    int n = 0;
    if (x >= 2) out[n++] = F.raw[y * w + (x - 2)];
    if (x < w - 2) out[n++] = F.raw[y * w + (x + 2)];
    if (y >= 2) out[n++] = F.raw[(y - 2) * w + x];
    if (y < h - 2) out[n++] = F.raw[(y + 2) * w + x];
    return n;
}

/* One plane at a time: three passes over the frame rather than three sets of
 * histograms resident at once, because 14 bits of bins is 64 KB and the wasm
 * starts with a megabyte. g_hist counts values, g_dhist counts how far each
 * pixel sits from its neighbours. */
static u32 g_hist[1 << 14];
static u32 g_dhist[1 << 14];

/*
 * stats, in order:
 *   0..2   fraction of each plane at or above the white level
 *   3..5   noise VARIANCE of each plane, in raw counts squared
 *   6..8   the darkest value each plane reaches
 *   9..11  each plane's 0.1st percentile: the black level the frame itself
 *          implies, a floor that one stuck pixel cannot drag down
 *   12     how many defects were found, which may exceed how many were stored
 *   13     Clark-Evans index R over the defects that were stored, or 0
 *   14     its z score
 *   15     how many points that index was computed over
 *   16     the background cut the brightness gate applied, in raw counts
 *   17     spatial sigma of the deviation field, for the Gaussian overlay
 *   18     histogram bin width, in raw counts
 *   19     value at the left edge of the first bin
 *   20     how many bins were filled
 *
 * defects receives x,y pairs, up to max_defects of them.
 * hist, when given, receives HIST_BINS counts of the deviation field: how far
 * each pixel sits from the mean of its same-colour neighbours. That field is
 * the quantity a defect is judged on, so its distribution is what says whether
 * the judgement means anything.
 */
#define DIAG_STATS 21
#define HIST_BINS 256

/*
 * A square root, without a libc to ask for one.
 *
 * __builtin_sqrt compiles to the wasm f64.sqrt instruction, so this costs an
 * instruction rather than a link against a maths library the freestanding
 * build does not have. Everywhere else in this engine hands the root back to
 * the caller in JS for that reason; the two places below need it here, because
 * a distance is not something the caller can take the root of afterwards.
 */
static inline double sqrtd(double v) { return __builtin_sqrt(v); }

/*
 * The local background at one site: a box mean over the same-colour plane,
 * seven plane-pixels across, which is the first stage of the highpass cascade
 * EMVA 1288 section 8.1 specifies (7x7 box, 11x11 box, 3x3 binomial, then
 * subtracted from the original).
 *
 * Only the lowpass half is built here, and deliberately. EMVA subtracts the
 * cascade to remove lens shading and illumination falloff before measuring
 * spatial nonuniformity; this scan already subtracts the mean of a pixel's
 * four same-colour neighbours, which removes everything smooth over a wider
 * span than the cascade does. Running the full cascade as well would highpass
 * an already highpassed field. What is wanted from it is the other half: the
 * local signal level, which is what says whether the photo term is small
 * enough here for a dark-current defect to be visible at all.
 */
static float local_background(int x, int y, int w, int h) {
    int s = 0, n = 0;
    for (int dy = -6; dy <= 6; dy += 2) {
        const int yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (int dx = -6; dx <= 6; dx += 2) {
            const int xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += F.raw[yy * w + xx];
            n++;
        }
    }
    return n ? (float)s / (float)n : 0.f;
}

/*
 * Clark-Evans nearest-neighbour index.
 *
 * Chapman and colleagues report that hot pixels are randomly spaced across an
 * imager, and verify their own defect sets against complete spatial randomness
 * for exactly this reason: a random creation process leaves a random pattern,
 * while anything driven by the picture sits where the picture had detail.
 *
 * R is the mean nearest-neighbour distance over the value a Poisson process of
 * the same density would give. R = 1 is random, R below 1 clustered, R above 1
 * dispersed. On a frame of a furnished room this comes back near 0.5, which is
 * the scan announcing that it is describing the furniture.
 */
static void clark_evans(const i32 *pts, int n, int w, int h, float *out_r, float *out_z) {
    *out_r = 0.f;
    *out_z = 0.f;
    if (n < 3) return;
    double sum = 0.0;
    for (int i = 0; i < n; i++) {
        double best = 1e30;
        for (int j = 0; j < n; j++) {
            if (j == i) continue;
            const double dx = (double)(pts[i * 2] - pts[j * 2]);
            const double dy = (double)(pts[i * 2 + 1] - pts[j * 2 + 1]);
            const double d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
        }
        sum += sqrtd(best);
    }
    const double area = (double)w * (double)h;
    const double obs = sum / n;
    const double expd = 0.5 * sqrtd(area / n);
    if (!(expd > 0.0)) return;
    *out_r = (float)(obs / expd);
    /* Clark & Evans (1954): the standard error of the mean nearest-neighbour
     * distance under randomness. */
    const double se = 0.26136 / sqrtd((double)n * (double)n / area);
    if (se > 0.0) *out_z = (float)((obs - expd) / se);
}

EXPORT(diagnose) i32 diagnose(i32 cfa, i32 white, float sigmas, float bg_percentile,
                              float *stats, i32 *defects, i32 max_defects, u32 *hist) {
    const int w = F.width, h = F.height;
    if (!F.raw || !stats) return ERR_SIZE;
    for (int i = 0; i < DIAG_STATS; i++) stats[i] = 0.f;
    if (hist) for (int i = 0; i < HIST_BINS; i++) hist[i] = 0u;
    if (w < 5 || h < 5) return ERR_SIZE;
    if (sigmas <= 0.f) sigmas = 8.f;
    if (!(bg_percentile > 0.f) || bg_percentile > 100.f) bg_percentile = 100.f;

    u32 clipped[3] = {0, 0, 0}, total[3] = {0, 0, 0};
    u32 lowest[3] = {0xffffu, 0xffffu, 0xffffu};

    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            const int p = plane_at(cfa, x, y);
            const u32 v = F.raw[y * w + x];
            total[p]++;
            if ((i32)v >= white) clipped[p]++;
            if (v < lowest[p]) lowest[p] = v;
        }
    }
    for (int p = 0; p < 3; p++) {
        stats[p] = total[p] ? (float)((double)clipped[p] / total[p]) : 0.f;
        stats[6 + p] = (float)(lowest[p] == 0xffffu ? 0u : lowest[p]);
    }

    for (int p = 0; p < 3; p++) {
        const int bins = 1 << 14;
        for (int i = 0; i < bins; i++) { g_hist[i] = 0; g_dhist[i] = 0; }
        u32 dcnt = 0;
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                if (plane_at(cfa, x, y) != p) continue;
                u32 v = F.raw[y * w + x];
                g_hist[v >= (u32)bins ? bins - 1 : v]++;
                if (x < 2 || x >= w - 2 || y < 2 || y >= h - 2) continue;
                u16 nb[4];
                if (same_plane_neighbours(x, y, w, h, nb) != 4) continue;
                /* Four neighbours summed rather than averaged, so the distance
                 * stays an integer and can index a bin: |4v - sum| is four
                 * times the difference from their mean. */
                i32 d4 = 4 * (i32)v - (i32)nb[0] - (i32)nb[1] - (i32)nb[2] - (i32)nb[3];
                u32 a = (u32)((d4 < 0 ? -d4 : d4) + 2) / 4;
                g_dhist[a >= (u32)bins ? bins - 1 : a]++;
                dcnt++;
            }

        const u32 want = total[p] / 1000;
        u32 seen = 0;
        for (int i = 0; i < bins; i++) {
            seen += g_hist[i];
            if (seen > want) { stats[9 + p] = (float)i; break; }
        }

        /*
         * The MEDIAN distance, not the mean square of it.
         *
         * A frame is mostly flat and occasionally an edge, and squaring gives
         * the edges all the say: on a synthetic frame with one hard boundary
         * across it, a mean-square estimate read 98 counts where 12 had been
         * added. The median does not notice a minority of large values at all,
         * which is the whole point -- a noise figure is about the flat parts.
         *
         * For a Gaussian the median absolute deviation is 0.6745 sigma, so
         * sigma is the median times 1.4826; and the distance from four
         * neighbours' mean carries 1.25 times the variance of one pixel.
         */
        u32 half = dcnt / 2, run = 0;
        double med = 0;
        for (int i = 0; i < bins; i++) {
            run += g_dhist[i];
            if (run > half) { med = i; break; }
        }
        const double sigma = med * 1.4826 / 1.118033988749895;   /* sqrt(1.25) */
        stats[3 + p] = (float)(dcnt ? sigma * sigma : 0.0);
    }

    /*
     * A defect is a pixel that disagrees with EVERY one of its same-colour
     * neighbours, in the same direction, by more than the noise explains.
     *
     * "Every one" is what keeps edges out of the list. A pixel on the bright
     * side of an edge towers over the neighbours behind it and sits level with
     * the ones beside it, so it fails the test; a real hot pixel has nothing
     * standing beside it.
     */
    /*
     * The brightness gate.
     *
     * I = m*(Rphoto*Te + Rdark*Te + b): a defect lives in the dark terms, so
     * it is easiest to see where the photo term is smallest. A laboratory sets
     * that term to zero by capping the lens. Failing that, the shadows in an
     * ordinary scene are where it comes closest -- and shadows also carry the
     * least texture, which is what generates the false positives.
     *
     * Measured on a lab frame: taking only the darkest quarter of candidates
     * moved the Clark-Evans index of the surviving set from 0.57 to 0.87, in
     * other words from plainly clustered towards plainly random.
     *
     * The cut comes from a sparse sample of the frame, so it costs one pass
     * over one pixel in sixty-four rather than a background for every site.
     */
    float bg_cut = 3.4e38f;
    if (bg_percentile < 100.f) {
        for (int i = 0; i < (1 << 14); i++) g_hist[i] = 0u;
        u32 sampled = 0;
        for (int y = 6; y < h - 6; y += 8) {
            for (int x = 6; x < w - 6; x += 8) {
                int b = (int)local_background(x, y, w, h);
                if (b < 0) b = 0;
                if (b > (1 << 14) - 1) b = (1 << 14) - 1;
                g_hist[b]++;
                sampled++;
            }
        }
        if (sampled) {
            const u32 want = (u32)((double)sampled * bg_percentile / 100.0);
            u32 acc = 0;
            for (int i = 0; i < (1 << 14); i++) {
                acc += g_hist[i];
                if (acc >= want) { bg_cut = (float)i; break; }
            }
        }
    }
    stats[16] = bg_cut > 3.0e38f ? 0.f : bg_cut;

    /*
     * The deviation field, histogrammed.
     *
     * EMVA 1288 declines to say when a pixel is defective -- "it will not be
     * possible to find a common denominator" -- and asks for the distribution
     * instead, plotted on a logarithmic axis so a single outlying pixel is
     * visible against millions of ordinary ones. This builds that histogram
     * over the quantity the scan actually judges: how far a pixel sits from
     * the mean of its four same-colour neighbours.
     *
     * The bin width is chosen from the noise rather than from the extremes, so
     * the shape near zero is resolved and the tail is where the outliers land.
     */
    double noise_var = 0.0;
    for (int p = 0; p < 3; p++) noise_var += stats[3 + p];
    noise_var /= 3.0;
    if (noise_var < 1.0) noise_var = 1.0;
    const float hist_w = (float)(sqrtd(noise_var) * 0.25);
    const float hist_lo = -(float)(HIST_BINS / 2) * hist_w;
    stats[18] = hist_w;
    stats[19] = hist_lo;
    stats[20] = (float)HIST_BINS;

    double dev_sum = 0.0, dev_sq = 0.0;
    u32 dev_n = 0;

    i32 found = 0;
    for (int y = 2; y < h - 2; y++) {
        for (int x = 2; x < w - 2; x++) {
            u16 nb[4];
            if (same_plane_neighbours(x, y, w, h, nb) != 4) continue;
            /* The deviation goes into the histogram for every site that has a
             * full set of neighbours, gated or not, defect or not: the point
             * of the distribution is what the ordinary population looks like. */
            {
                const double mean4 = (nb[0] + nb[1] + nb[2] + nb[3]) * 0.25;
                const double d = (double)F.raw[y * w + x] - mean4;
                dev_sum += d; dev_sq += d * d; dev_n++;
                if (hist) {
                    int b = (int)((d - hist_lo) / hist_w);
                    if (b < 0) b = 0;
                    if (b > HIST_BINS - 1) b = HIST_BINS - 1;
                    hist[b]++;
                }
            }
            /*
             * A clipped pixel says nothing about itself. It stopped counting
             * at the white level, so if it saturated and its neighbours came
             * up just short it stands above all four by construction -- and
             * the brightest edge in the frame is where that happens most.
             * Measured on a real frame: the rim of a blown highlight accounted
             * for most of 2463 reported defects, in a dense line that was
             * plainly an edge rather than a scatter of bad pixels.
             *
             * The neighbours are excluded for the same reason from the other
             * side: a pixel surrounded by saturation is being compared with
             * values that are censored rather than measured.
             */
            const i32 lim = white;
            if ((i32)F.raw[y * w + x] >= lim) continue;
            if ((i32)nb[0] >= lim || (i32)nb[1] >= lim ||
                (i32)nb[2] >= lim || (i32)nb[3] >= lim) continue;
            /* Too bright for the dark terms to show through. */
            if (bg_cut < 3.0e38f && local_background(x, y, w, h) > bg_cut) continue;
            const int p = plane_at(cfa, x, y);
            /* A floor of one count, so a synthetic frame with no noise at all
             * does not make every pixel a defect. */
            const double var = stats[3 + p] > 1.0 ? stats[3 + p] : 1.0;
            const double margin2 = (double)sigmas * sigmas * var;
            const double v = F.raw[y * w + x];
            /*
             * The neighbours must also agree with EACH OTHER.
             *
             * "Higher than all four" does not mean isolated: it is equally
             * true of the crest of a thin bright line, where the neighbours
             * two pixels away sit on either side of the ridge. On a real
             * frame that lit up the whole white piping of a chair, thousands
             * of pixels of it, and no rule about the candidate alone can tell
             * that from a hot pixel -- the difference is in the neighbourhood.
             * Around a bad pixel the four are all reading the same flat
             * surface and land within the noise of one another; across a
             * ridge or a corner they do not.
             */
            u16 lo = nb[0], hi = nb[0];
            for (int i = 1; i < 4; i++) {
                if (nb[i] < lo) lo = nb[i];
                if (nb[i] > hi) hi = nb[i];
            }
            const double spread = (double)hi - lo;
            /* Five sigma, not three. The RANGE of four Gaussian samples averages
             * about 2.06 sigma and varies by nearly 0.9 of one, so a three-sigma
             * limit throws away a useful fraction of perfectly flat
             * neighbourhoods -- it lost one of four planted defects. Five keeps
             * them and still excludes a ridge by two orders of magnitude: the
             * piping this was written for spans thousands of counts where five
             * sigma is twenty-six. */
            if (spread * spread > 25.0 * var) continue;

            int above = 1, below = 1;
            for (int i = 0; i < 4; i++) {
                const double d = v - nb[i];
                if (!(d > 0 && d * d > margin2)) above = 0;
                if (!(d < 0 && d * d > margin2)) below = 0;
            }
            if (!above && !below) continue;
            if (defects && found < max_defects) {
                defects[found * 2] = x;
                defects[found * 2 + 1] = y;
            }
            found++;
        }
    }
    stats[12] = (float)found;
    if (dev_n > 1) {
        const double m = dev_sum / dev_n;
        const double v = dev_sq / dev_n - m * m;
        stats[17] = (float)sqrtd(v > 0.0 ? v : 0.0);
    }
    /* Over the defects that were STORED, which is what the caller can see. A
     * run that overflowed max_defects reports the index of the prefix it kept;
     * stats[15] says how many that was so the caller need not guess. */
    {
        const int n = found < max_defects ? found : max_defects;
        if (defects && n >= 3) {
            float r = 0.f, z = 0.f;
            clark_evans(defects, n, w, h, &r, &z);
            stats[13] = r;
            stats[14] = z;
            stats[15] = (float)n;
        }
    }
    return found;
}
