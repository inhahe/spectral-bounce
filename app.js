"use strict";
/* Spectral Bounce -- bouncing shapes composited in spectral space.
 *
 * Pipeline overview
 * -----------------
 * Colour is NOT stored as RGB while shapes overlap. Instead every shape carries
 * a 16-band spectrum (400..700 nm). Shapes are drawn into a floating-point
 * multi-render-target framebuffer holding those 16 bands across 4 RGBA textures:
 *
 *   Subtractive (filters on white): the framebuffer is cleared to 1.0 and each
 *     shape MULTIPLY-blends its transmittance spectrum in. Overlaps multiply,
 *     exactly like stacking real gels. A final resolve pass multiplies by the
 *     white-light SPD and integrates against the CIE colour-matching functions.
 *
 *   Additive (luminous on black): the framebuffer is cleared to 0.0 and each
 *     shape ADDITIVE-blends its emission spectrum (white x transmittance). The
 *     resolve pass integrates the summed light directly.
 */

// --------------------------------------------------------------------------
// Render-side wavelength grid: 16 bands, 400..700 nm, packed into 4 RGBA px.
// --------------------------------------------------------------------------
const NW = 16;
const RENDER_WL = Array.from({ length: NW }, (_, i) => 400 + i * (300 / (NW - 1)));

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** Standard normal deviate (Box-Muller), shifted/scaled to (mean, sd). */
function gaussian(mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --------------------------------------------------------------------------
// Character sets for glyph shapes
// --------------------------------------------------------------------------
// Printable ASCII (letters, numbers, symbols), code points 0x21..0x7E.
const ASCII_PRINTABLE = Array.from({ length: 0x7e - 0x21 + 1 },
  (_, i) => String.fromCodePoint(0x21 + i));

// Code page 437 (original IBM PC / DOS) mapped to Unicode, all 255 glyphs.
const CP437 = (() => {
  const lo = [0x263a, 0x263b, 0x2665, 0x2666, 0x2663, 0x2660, 0x2022, 0x25d8,
    0x25cb, 0x25d9, 0x2642, 0x2640, 0x266a, 0x266b, 0x263c, 0x25ba, 0x25c4,
    0x2195, 0x203c, 0x00b6, 0x00a7, 0x25ac, 0x21a8, 0x2191, 0x2193, 0x2192,
    0x2190, 0x221f, 0x2194, 0x25b2, 0x25bc];
  const hi = [0x2302,
    0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
    0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
    0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
    0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
    0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
    0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4, 0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
    0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248, 0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0];
  const cps = [...lo];
  for (let c = 0x20; c <= 0x7e; c++) cps.push(c);
  cps.push(...hi);
  return cps.map((cp) => String.fromCodePoint(cp));
})();

// Fonts offered in the dropdown by default (system fonts + a couple of common
// web fonts). "List installed fonts" and "Load font file" can add more.
const COMMON_FONTS = ["Georgia", "Times New Roman", "Arial", "Helvetica",
  "Verdana", "Trebuchet MS", "Courier New", "Consolas", "Comic Sans MS",
  "Impact", "Segoe UI", "Tahoma", "Garamond", "Palatino Linotype", "Cambria",
  "Candara", "Franklin Gothic Medium", "Lucida Console", "Calibri",
  "Century Gothic", "sans-serif", "serif", "monospace"];

// Printable Unicode code-point ranges (BMP minus surrogates/specials, plus a
// large slice of the SMP). A code point is sampled uniformly across these; the
// glyph is only kept if the chosen font actually has it (see GlyphCache).
const UNICODE_RANGES = [[0x21, 0xd7ff], [0xe000, 0xfffd], [0x10000, 0x2fa1f]];

// The main emoji blocks. (Colour emoji render as filter-tinted silhouettes here,
// since only the glyph's coverage feeds the spectral compositing.)
const EMOJI_RANGES = [
  [0x1f300, 0x1f5ff],   // Misc Symbols & Pictographs
  [0x1f600, 0x1f64f],   // Emoticons
  [0x1f680, 0x1f6ff],   // Transport & Map
  [0x1f900, 0x1f9ff],   // Supplemental Symbols & Pictographs
  [0x1fa70, 0x1faff],   // Symbols & Pictographs Extended-A
  [0x2600, 0x26ff],     // Misc Symbols
  [0x2700, 0x27bf],     // Dingbats
];

/** Build a function that returns a code point sampled uniformly across `ranges`. */
function makeCPSampler(ranges) {
  const total = ranges.reduce((a, [lo, hi]) => a + (hi - lo + 1), 0);
  return () => {
    let r = (Math.random() * total) | 0;
    for (const [lo, hi] of ranges) { const n = hi - lo + 1; if (r < n) return lo + r; r -= n; }
    return 0x41;
  };
}
const randomUnicodeCP = makeCPSampler(UNICODE_RANGES);
const randomEmojiCP = makeCPSampler(EMOJI_RANGES);

/** Linear-resample (srcWL, srcVals) onto RENDER_WL. */
function resample(srcWL, srcVals) {
  const out = new Float32Array(NW);
  for (let i = 0; i < NW; i++) {
    const wl = RENDER_WL[i];
    if (wl <= srcWL[0]) { out[i] = srcVals[0]; continue; }
    if (wl >= srcWL[srcWL.length - 1]) { out[i] = srcVals[srcVals.length - 1]; continue; }
    let j = 1;
    while (srcWL[j] < wl) j++;
    const t = (wl - srcWL[j - 1]) / (srcWL[j] - srcWL[j - 1]);
    out[i] = srcVals[j - 1] * (1 - t) + srcVals[j] * t;
  }
  return out;
}

// --------------------------------------------------------------------------
// Data load (fetch JSON files; fall back to embedded bundle for file://).
// --------------------------------------------------------------------------
async function loadSpectra() {
  const names = ["cmf", "filters", "illuminants"];
  try {
    const parts = await Promise.all(
      names.map((n) => fetch(`spectra/${n}.json`).then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }))
    );
    return { cmf: parts[0], filters: parts[1], illuminants: parts[2], source: "spectra/*.json" };
  } catch (e) {
    if (window.EMBEDDED_SPECTRA) {
      const E = window.EMBEDDED_SPECTRA;
      return { ...E, source: "embedded bundle" };
    }
    throw new Error("Could not load spectral data (fetch failed and no embedded bundle).");
  }
}

// --------------------------------------------------------------------------
// CIE resolve maths (done on the render grid, mirrored by the resolve shader).
// --------------------------------------------------------------------------
// XYZ -> linear sRGB (D65)
const M_XYZ2RGB = [
  3.2406, -1.5372, -0.4986,
  -0.9689, 1.8758, 0.0415,
  0.0557, -0.2040, 1.0570,
];
function xyz2rgb(X, Y, Z) {
  return [
    M_XYZ2RGB[0] * X + M_XYZ2RGB[1] * Y + M_XYZ2RGB[2] * Z,
    M_XYZ2RGB[3] * X + M_XYZ2RGB[4] * Y + M_XYZ2RGB[5] * Z,
    M_XYZ2RGB[6] * X + M_XYZ2RGB[7] * Y + M_XYZ2RGB[8] * Z,
  ];
}
function srgbEncode(c) {
  c = clamp(c, 0, 1);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Integrate a spectrum (length NW) against CMFs -> raw XYZ. */
function specToXYZ(spec, cmf) {
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i < NW; i++) { X += spec[i] * cmf.x[i]; Y += spec[i] * cmf.y[i]; Z += spec[i] * cmf.z[i]; }
  return [X, Y, Z];
}

// --------------------------------------------------------------------------
// WebGL renderer
// --------------------------------------------------------------------------
const SHAPE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;         // quad corner in [-1,1]
uniform vec2  u_res;                          // framebuffer size (px)
uniform vec2  u_center;                       // shape centre (px)
uniform vec2  u_half;                         // half-extents (px)
uniform float u_rot;
out vec2 v_local;                             // [-1,1] local coords
out vec2 v_uv;                                // [0,1] for glyph sampling
void main() {
  v_local = a_corner;
  v_uv = a_corner * 0.5 + 0.5;
  float c = cos(u_rot), s = sin(u_rot);
  vec2 local = a_corner * u_half;
  vec2 world = u_center + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  vec2 clip = (world / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const SHAPE_FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_uv;
uniform int   u_type;        // 0 rect/square, 1 circle, 2 glyph
uniform vec4  u_spec[4];      // 16-band spectrum for this shape
uniform sampler2D u_glyph;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
layout(location=2) out vec4 o2;
layout(location=3) out vec4 o3;
void main() {
  if (u_type == 1) {
    if (dot(v_local, v_local) > 1.0) discard;          // circle
  } else if (u_type == 2) {
    if (texture(u_glyph, v_uv).a < 0.5) discard;  // glyph coverage
  }
  o0 = u_spec[0]; o1 = u_spec[1]; o2 = u_spec[2]; o3 = u_spec[3];
}`;

const RESOLVE_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // full-screen triangle
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const RESOLVE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_t0, u_t1, u_t2, u_t3;
uniform vec4  u_white[4];
uniform vec4  u_cmfX[4], u_cmfY[4], u_cmfZ[4];   // pre-scaled by 1/Yw
uniform mat3  u_xyz2rgb;
uniform vec3  u_wb;          // white-balance (per-channel) so white -> (1,1,1)
uniform float u_exposure;
uniform int   u_applyWhite;  // 1 subtractive, 0 additive
out vec4 frag;

vec3 srgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = 12.92 * c;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
void main() {
  vec4 a0 = texture(u_t0, v_uv);
  vec4 a1 = texture(u_t1, v_uv);
  vec4 a2 = texture(u_t2, v_uv);
  vec4 a3 = texture(u_t3, v_uv);
  if (u_applyWhite == 1) { a0 *= u_white[0]; a1 *= u_white[1]; a2 *= u_white[2]; a3 *= u_white[3]; }
  float X = dot(a0, u_cmfX[0]) + dot(a1, u_cmfX[1]) + dot(a2, u_cmfX[2]) + dot(a3, u_cmfX[3]);
  float Y = dot(a0, u_cmfY[0]) + dot(a1, u_cmfY[1]) + dot(a2, u_cmfY[2]) + dot(a3, u_cmfY[3]);
  float Z = dot(a0, u_cmfZ[0]) + dot(a1, u_cmfZ[1]) + dot(a2, u_cmfZ[2]) + dot(a3, u_cmfZ[3]);
  vec3 rgb = u_xyz2rgb * vec3(X, Y, Z);
  rgb *= u_wb * u_exposure;
  frag = vec4(srgb(rgb), 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error("Shader compile error:\n" + gl.getShaderInfoLog(sh));
  return sh;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error("Program link error:\n" + gl.getProgramInfoLog(p));
  return p;
}

class SpectralRenderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 is required but not available in this browser.");
    this.gl = gl;
    this.canvas = canvas;

    const forceNoFloat = /[?&]nofloat\b/.test(location.search);
    const floatOK = forceNoFloat ? null : gl.getExtension("EXT_color_buffer_float");
    this.texType = floatOK ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    this.texInternal = floatOK ? gl.RGBA16F : gl.RGBA8;
    this.floatOK = !!floatOK;

    this.shapeProg = program(gl, SHAPE_VS, SHAPE_FS);
    this.resolveProg = program(gl, RESOLVE_VS, RESOLVE_FS);

    // quad geometry (triangle strip)
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    // empty VAO for the full-screen resolve triangle
    this.emptyVAO = gl.createVertexArray();

    this.fbo = gl.createFramebuffer();
    this.textures = [];
    this.width = 0; this.height = 0;

    this._cacheUniforms();
  }

  _cacheUniforms() {
    const gl = this.gl;
    const p = this.shapeProg;
    this.uShape = {
      res: gl.getUniformLocation(p, "u_res"),
      center: gl.getUniformLocation(p, "u_center"),
      half: gl.getUniformLocation(p, "u_half"),
      rot: gl.getUniformLocation(p, "u_rot"),
      type: gl.getUniformLocation(p, "u_type"),
      spec: gl.getUniformLocation(p, "u_spec"),
      glyph: gl.getUniformLocation(p, "u_glyph"),
    };
    const r = this.resolveProg;
    this.uRes = {
      t0: gl.getUniformLocation(r, "u_t0"), t1: gl.getUniformLocation(r, "u_t1"),
      t2: gl.getUniformLocation(r, "u_t2"), t3: gl.getUniformLocation(r, "u_t3"),
      white: gl.getUniformLocation(r, "u_white"),
      cmfX: gl.getUniformLocation(r, "u_cmfX"),
      cmfY: gl.getUniformLocation(r, "u_cmfY"),
      cmfZ: gl.getUniformLocation(r, "u_cmfZ"),
      xyz2rgb: gl.getUniformLocation(r, "u_xyz2rgb"),
      wb: gl.getUniformLocation(r, "u_wb"),
      exposure: gl.getUniformLocation(r, "u_exposure"),
      applyWhite: gl.getUniformLocation(r, "u_applyWhite"),
    };
  }

  resize(w, h) {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const attach = [];
    for (let i = 0; i < 4; i++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.texInternal, w, h, 0, gl.RGBA, this.texType, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      attach.push(gl.COLOR_ATTACHMENT0 + i);
      this.textures.push(t);
    }
    gl.drawBuffers(attach);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Framebuffer incomplete: 0x" + st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Draw a frame. shapes: array with {type, x,y, hw,hh, rot, spec:Float32Array(16), glyphTex?}
   *  target: optional {fbo, w, h} to resolve into (default = on-screen framebuffer). */
  render(shapes, mode, resolveUniforms, target) {
    const gl = this.gl;
    const additive = mode === "additive";

    // --- pass 1: accumulate spectra into the MRT framebuffer ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    const c = additive ? 0.0 : 1.0;
    gl.clearColor(c, c, c, c);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    if (additive) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.DST_COLOR, gl.ZERO);   // multiply

    gl.useProgram(this.shapeProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.uShape.res, this.width, this.height);
    // Glyph sampler lives on a dedicated unit (4) that the resolve pass never
    // uses. The resolve pass leaves this.textures bound to units 0-3, and those
    // are colour attachments of this.fbo -- pointing the glyph sampler there too
    // would form a feedback loop and make pass-1 draws a no-op.
    gl.uniform1i(this.uShape.glyph, 4);

    for (const s of shapes) {
      gl.uniform2f(this.uShape.center, s.x, s.y);
      gl.uniform2f(this.uShape.half, s.hw, s.hh);
      gl.uniform1f(this.uShape.rot, s.rot);
      gl.uniform1i(this.uShape.type, s.type === "circle" ? 1 : s.type === "glyph" ? 2 : 0);
      gl.uniform4fv(this.uShape.spec, additive ? s.emit : s.spec);
      if (s.type === "glyph" && s.glyphTex) {
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, s.glyphTex);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);

    // --- pass 2: resolve spectra -> sRGB (to screen, or to a probe target) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
    gl.useProgram(this.resolveProg);
    gl.bindVertexArray(this.emptyVAO);
    for (let i = 0; i < 4; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.textures[i]); }
    gl.uniform1i(this.uRes.t0, 0); gl.uniform1i(this.uRes.t1, 1);
    gl.uniform1i(this.uRes.t2, 2); gl.uniform1i(this.uRes.t3, 3);
    const u = resolveUniforms;
    gl.uniform4fv(this.uRes.white, u.white);
    gl.uniform4fv(this.uRes.cmfX, u.cmfX);
    gl.uniform4fv(this.uRes.cmfY, u.cmfY);
    gl.uniform4fv(this.uRes.cmfZ, u.cmfZ);
    gl.uniformMatrix3fv(this.uRes.xyz2rgb, false, u.xyz2rgbColMajor);
    gl.uniform3fv(this.uRes.wb, u.wb);
    gl.uniform1f(this.uRes.exposure, u.brightness);
    gl.uniform1i(this.uRes.applyWhite, additive ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Resolve a frame into a private RGBA8 framebuffer and read back the centre
   *  pixel. Reading an offscreen RGBA8 target is reliable everywhere, unlike
   *  reading the double-buffered default framebuffer. Used once at startup to
   *  sanity-check the float render target. */
  probeCentre(shapes, mode, resolveUniforms) {
    const gl = this.gl;
    const PS = 8;
    if (!this.probeFBO) {
      this.probeTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.probeTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PS, PS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.probeFBO = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.probeTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    this.render(shapes, mode, resolveUniforms, { fbo: this.probeFBO, w: PS, h: PS });
    const buf = new Uint8Array(4 * PS * PS);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFBO);
    gl.readPixels(0, 0, PS, PS, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const c = (PS * (PS / 2) + PS / 2) * 4;   // centre pixel
    return buf.subarray(c, c + 4);
  }

  /** Recreate the spectral buffer as 8-bit (fallback when float targets misbehave). */
  forceByteBuffer() {
    this.floatOK = false;
    this.texType = this.gl.UNSIGNED_BYTE;
    this.texInternal = this.gl.RGBA8;
    const w = this.width, h = this.height;
    this.width = this.height = 0;   // force resize() to rebuild textures
    this.resize(w, h);
  }
}

// --------------------------------------------------------------------------
// Glyph texture cache
// --------------------------------------------------------------------------
class GlyphCache {
  constructor(gl) { this.gl = gl; this.map = new Map(); this._notdef = null; }

  /** Does `font` actually have a glyph for `ch`? Renders the character and a
   *  guaranteed-missing reference code point (U+10FFFF) to a small canvas and
   *  compares: an unsupported character rasterises identically to the font's
   *  .notdef box (or to nothing at all). Lets the Unicode/CP437 sets skip tofu. */
  supported(font, ch) {
    const S = 24;
    if (!this._pc) {
      this._pc = document.createElement("canvas");
      this._pc.width = this._pc.height = S;
      this._px = this._pc.getContext("2d", { willReadFrequently: true });
    }
    const ctx = this._px;
    const draw = (c) => {
      ctx.clearRect(0, 0, S, S);
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `18px ${font}`;
      ctx.fillText(c, S / 2, S / 2);
      return ctx.getImageData(0, 0, S, S).data;
    };
    if (!this._notdef || this._notdef.font !== font)
      this._notdef = { font, data: draw(String.fromCodePoint(0x10ffff)) };
    const nd = this._notdef.data, img = draw(ch);
    let ink = 0, diff = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i] > 40) ink++;
      if (Math.abs(img[i] - nd[i]) > 40) diff++;
    }
    return ink > 4 && diff > 4;   // has ink AND differs from the notdef glyph
  }

  get(font, ch) {
    const key = font + "|" + ch;
    let tex = this.map.get(key);
    if (tex) return tex;
    const S = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const c = cv.getContext("2d");
    c.clearRect(0, 0, S, S);
    c.fillStyle = "#fff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    // shrink to fit
    let px = S * 0.8;
    c.font = `bold ${px}px ${font}`;
    const w = c.measureText(ch).width || px;
    if (w > S * 0.86) { px *= (S * 0.86) / w; c.font = `bold ${px}px ${font}`; }
    c.fillText(ch, S / 2, S / 2 + px * 0.04);

    const gl = this.gl;
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.map.set(key, tex);
    return tex;
  }
}

// --------------------------------------------------------------------------
// Physics
// --------------------------------------------------------------------------
class Shape {
  constructor(type, x, y, size, opts) {
    this.type = type;
    this.x = x; this.y = y;
    const ang = rand(0, Math.PI * 2), sp = opts.speed;
    this.vx = Math.cos(ang) * sp; this.vy = Math.sin(ang) * sp;
    this.rot = rand(0, Math.PI * 2);
    this.spin = (type === "circle") ? 0 : rand(-1.2, 1.2);

    if (type === "rect") { this.hw = size; this.hh = size * rand(0.32, 0.62); }
    else if (type === "glyph") { this.hw = this.hh = size; }
    else { this.hw = this.hh = size; }               // circle & square

    // bounding radius for collisions
    if (type === "circle") this.br = size;
    else if (type === "glyph") this.br = size * 0.62;
    else this.br = Math.hypot(this.hw, this.hh);

    this.mass = this.br * this.br;
    this.filterName = opts.filterName;
    this.spec = opts.spec;      // transmittance (16)
    this.emit = opts.emit;      // white*T (16)
    this.glyphChar = opts.glyphChar;
    this.glyphTex = null;
  }
}

function stepPhysics(shapes, W, H, dt) {
  // Shapes pass freely through one another (so their colours overlap and
  // combine); they only bounce off the walls.
  for (const s of shapes) {
    s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.spin * dt;
    if (s.x - s.br < 0) { s.x = s.br; s.vx = Math.abs(s.vx); }
    else if (s.x + s.br > W) { s.x = W - s.br; s.vx = -Math.abs(s.vx); }
    if (s.y - s.br < 0) { s.y = s.br; s.vy = Math.abs(s.vy); }
    else if (s.y + s.br > H) { s.y = H - s.br; s.vy = -Math.abs(s.vy); }
  }
}

// --------------------------------------------------------------------------
// Application
// --------------------------------------------------------------------------
class App {
  constructor(data) {
    this.data = data;
    this.canvas = document.getElementById("gl");
    this.renderer = new SpectralRenderer(this.canvas);
    this.glyphs = new GlyphCache(this.renderer.gl);
    this.shapes = [];
    this.paused = false;
    this.mode = "subtractive";
    this.ss = clamp(window.devicePixelRatio || 1, 1, 2);

    // resample CMF & filters onto render grid
    this.cmf = {
      x: resample(data.cmf.wavelengths, data.cmf.x),
      y: resample(data.cmf.wavelengths, data.cmf.y),
      z: resample(data.cmf.wavelengths, data.cmf.z),
    };
    this.filterSpecs = {};   // name -> Float32Array(16)
    const fw = data.filters.wavelengths;
    for (const [name, f] of Object.entries(data.filters.filters))
      this.filterSpecs[name] = resample(fw, f.transmittance);

    this.illumSpecs = {};    // name -> Float32Array(16)
    const iw = data.illuminants.wavelengths;
    for (const [name, il] of Object.entries(data.illuminants.illuminants))
      this.illumSpecs[name] = resample(iw, il.spd);
    this.illumName = data.illuminants.default || Object.keys(this.illumSpecs)[0];

    this.buildUI();
    this.setIlluminant(this.illumName);
    this.spawned = false;
    this.onResize();                       // sizes buffer, self-tests, spawns
    if ("ResizeObserver" in window) { this._ro = new ResizeObserver(() => this.onResize()); this._ro.observe(this.canvas); }
    window.addEventListener("resize", () => this.onResize());
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Per-channel white-balance fixed to the *reference* (default) illuminant.
   *  Using a fixed reference -- instead of re-balancing to whatever light is
   *  currently selected -- means switching illuminants visibly tints the scene
   *  (warm under 3200 K, cool under 9500 K) and shifts every filter's colour,
   *  rather than being normalised away to look identical. The reference light
   *  itself reads as neutral white. */
  _refWB() {
    if (this._refWBv) return this._refWBv;
    const ref = this.illumSpecs[this.data.illuminants.default] || this.illumSpecs[this.illumName];
    let Yr = 0; for (let i = 0; i < NW; i++) Yr += ref[i] * this.cmf.y[i];
    const kr = 1 / Yr;
    const [Xr, Yr2, Zr] = specToXYZ(ref, this.cmf);
    const wb0 = xyz2rgb(Xr * kr, Yr2 * kr, Zr * kr);
    this._refWBv = wb0.map((v) => 1 / Math.max(v, 1e-4));
    return this._refWBv;
  }

  // ---- resolve uniforms depend on chosen illuminant ----
  setIlluminant(name) {
    this.illumName = name;
    const white = this.illumSpecs[name];
    // normalise so the selected white -> Y = 1 (equal luminance across lights)
    let Yw = 0;
    for (let i = 0; i < NW; i++) Yw += white[i] * this.cmf.y[i];
    const k = 1 / Yw;
    const wb = this._refWB();

    const packVec4 = (arr) => { const o = new Float32Array(16); o.set(arr); return o; };
    const cmfXs = this.cmf.x.map((v) => v * k);
    const cmfYs = this.cmf.y.map((v) => v * k);
    const cmfZs = this.cmf.z.map((v) => v * k);
    // column-major mat3 for GLSL
    const m = M_XYZ2RGB;
    const colMajor = new Float32Array([
      m[0], m[3], m[6],
      m[1], m[4], m[7],
      m[2], m[5], m[8],
    ]);
    this.resolveUniforms = {
      white: packVec4(white),
      cmfX: packVec4(cmfXs), cmfY: packVec4(cmfYs), cmfZ: packVec4(cmfZs),
      xyz2rgbColMajor: colMajor,
      wb: new Float32Array(wb),
      brightness: this.brightness || 1,
    };
    this.recomputeEmission();
  }

  /** emission spectrum for additive mode = white * transmittance */
  recomputeEmission() {
    const white = this.illumSpecs[this.illumName];
    for (const s of this.shapes) {
      const e = new Float32Array(16);
      for (let i = 0; i < NW; i++) e[i] = s.spec[i] * white[i];
      s.emit = e;
    }
  }

  /** approximate on-screen swatch colour for a filter (for UI chips), using the
   *  same fixed reference white balance as the renderer so chips track the light */
  swatchCSS(spec) {
    const white = this.illumSpecs[this.illumName];
    const lit = spec.map((v, i) => v * white[i]);
    let [X, Y, Z] = specToXYZ(lit, this.cmf);
    let Yw = 0; for (let i = 0; i < NW; i++) Yw += white[i] * this.cmf.y[i];
    const k = 1 / Yw;
    const wb = this._refWB();
    let rgb = xyz2rgb(X * k, Y * k, Z * k).map((v, i) => v * wb[i]);
    rgb = rgb.map((v) => Math.round(srgbEncode(v) * 255));
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  activeFilters() {
    return Object.keys(this.filterSpecs).filter((n) => this.filterChecked[n]);
  }
  activeClasses() {
    const cl = [];
    if (document.getElementById("cls-circle").checked) cl.push("circle");
    if (document.getElementById("cls-square").checked) cl.push("square");
    if (document.getElementById("cls-rect").checked) cl.push("rect");
    if (document.getElementById("cls-glyph").checked) cl.push("glyph");
    return cl;
  }

  currentFont() { return document.getElementById("font").value || "sans-serif"; }

  /** Pick one character for a glyph shape from the current character set,
   *  skipping characters the chosen font can't actually draw (except for the
   *  user's own custom string, which is used verbatim). */
  pickGlyphChar(font) {
    const cs = document.getElementById("charset").value;
    if (cs === "custom") {
      const pool = (document.getElementById("glyph-chars").value || "A").split("");
      return pool.length ? pick(pool) : "A";
    }
    if (cs === "unicode" || cs === "emoji") {
      const sampler = cs === "emoji" ? randomEmojiCP : randomUnicodeCP;
      for (let i = 0; i < 64; i++) {
        const ch = String.fromCodePoint(sampler());
        if (this.glyphs.supported(font, ch)) return ch;
      }
      return "?";
    }
    const pool = cs === "cp437" ? CP437 : ASCII_PRINTABLE;
    for (let i = 0; i < 64; i++) { const ch = pick(pool); if (this.glyphs.supported(font, ch)) return ch; }
    return pick(pool);
  }

  respawn() {
    const W = this.renderer.width || this.canvas.clientWidth * this.ss;
    const H = this.renderer.height || this.canvas.clientHeight * this.ss;
    const classes = this.activeClasses();
    const filters = this.activeFilters();
    const font = this.currentFont();
    const n = +document.getElementById("count").value;
    const white = this.illumSpecs[this.illumName];
    this.shapes = [];
    if (!classes.length || !filters.length) { this.setStatus(); return; }

    const base = Math.min(W, H);
    for (let i = 0; i < n; i++) {
      const type = pick(classes);
      const size = rand(base * 0.045, base * 0.11);
      const fname = pick(filters);
      const spec = this.filterSpecs[fname];
      const emit = new Float32Array(16);
      for (let k = 0; k < NW; k++) emit[k] = spec[k] * white[k];
      // per-shape speed from a normal distribution (mean = this.speed*base,
      // std-dev = this.spread * mean), never negative.
      const mul = Math.max(0.05, gaussian(1, this.spread));
      const s = new Shape(type, rand(size, W - size), rand(size, H - size), size, {
        speed: this.speed * base * mul,
        filterName: fname, spec, emit,
        glyphChar: type === "glyph" ? this.pickGlyphChar(font) : null,
      });
      s.speedMul = mul;
      if (type === "glyph") s.glyphTex = this.glyphs.get(font, s.glyphChar);
      this.shapes.push(s);
    }
    this.setStatus();
  }

  /** Re-pick and re-rasterise every glyph shape's character (used when the font
   *  or character set changes) without disturbing positions or velocities. */
  reglyph() {
    const font = this.currentFont();
    for (const s of this.shapes)
      if (s.type === "glyph") { s.glyphChar = this.pickGlyphChar(font); s.glyphTex = this.glyphs.get(font, s.glyphChar); }
  }

  /** Apply the current CSS size to the render buffer. Returns true if valid. */
  resize() {
    const w = Math.round(this.canvas.clientWidth * this.ss);
    const h = Math.round(this.canvas.clientHeight * this.ss);
    if (w < 2 || h < 2) return false;
    this._prevW = this.renderer.width; this._prevH = this.renderer.height;
    this.renderer.resize(w, h);
    return true;
  }

  onResize() {
    if (!this.resize()) return;
    if (!this.spawned) {
      this.respawn();
      this.spawned = true;
    } else if (this._prevW > 0 && this._prevH > 0 &&
               (this._prevW !== this.renderer.width || this._prevH !== this.renderer.height)) {
      // keep shapes in frame when the canvas changes size
      const sx = this.renderer.width / this._prevW, sy = this.renderer.height / this._prevH;
      for (const s of this.shapes) { s.x *= sx; s.y *= sy; }
    }
  }

  /** Sanity-check the float render target once at startup. Most software
   *  rasterizers and all real GPUs render the float MRT correctly, but some
   *  drivers report EXT_color_buffer_float yet read the target back as black.
   *  In that case an empty subtractive frame -- which should be pure white --
   *  resolves to black; detect that and drop to the 8-bit buffer, which is
   *  universally supported. (No shapes are drawn here, so this can't be tripped
   *  up by shape-specific issues.) */
  _validateRenderPath() {
    if (!this.renderer.floatOK) return;
    if (!this.renderer.width || !this.renderer.height) return;
    const bg = this.renderer.probeCentre([], "subtractive", this.resolveUniforms);
    const bright = bg[0] > 200 && bg[1] > 200 && bg[2] > 200;
    if (!bright) this.renderer.forceByteBuffer();
  }

  frame(t) {
    if (this.renderer.width < 2) { this.onResize(); this.last = t; requestAnimationFrame((tt) => this.frame(tt)); return; }
    if (!this._validated) { this._validateRenderPath(); this._validated = true; this.setStatus(); }
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    if (!this.paused && this.shapes.length) stepPhysics(this.shapes, this.renderer.width, this.renderer.height, dt);
    this.resolveUniforms.brightness = this.brightness;
    this.renderer.render(this.shapes, this.mode, this.resolveUniforms);
    requestAnimationFrame((tt) => this.frame(tt));
  }

  setStatus() {
    const el = document.getElementById("status");
    const nf = this.activeFilters().length;
    el.textContent = `${this.shapes.length} shapes - ${nf} filters - ` +
      `${this.renderer.floatOK ? "float" : "8-bit"} spectral buffer - data: ${this.data.source}`;
  }

  // ---- UI ----
  buildUI() {
    // speed / spread / brightness defaults (speed is a fraction of min(W,H)/s;
    // spread is the bell-curve std-dev as a fraction of the mean speed;
    // brightness is a final output multiplier applied in both modes)
    this.speed = 0.18; this.spread = 0.4; this.brightness = 1.0;

    const bindRange = (id, outId, fn, fmt) => {
      const el = document.getElementById(id), out = document.getElementById(outId);
      const upd = () => { fn(+el.value); out.innerHTML = fmt(+el.value); };
      el.addEventListener("input", upd); upd();
    };
    bindRange("count", "count-out", () => {}, (v) => v);
    document.getElementById("count").addEventListener("change", () => this.respawn());
    bindRange("speed", "speed-out", (v) => { this.speed = 0.18 * (v / 100); this.rescaleSpeed(); },
      (v) => (v / 100).toFixed(1) + "\u00d7");
    bindRange("spread", "spread-out", (v) => { this.spread = v / 100; this.resampleSpread(); },
      (v) => (v / 100).toFixed(2));
    bindRange("brightness", "brightness-out", (v) => { this.brightness = v / 100; },
      (v) => (v / 100).toFixed(1) + "\u00d7");

    // mode
    for (const r of document.querySelectorAll('input[name=mode]'))
      r.addEventListener("change", (e) => { if (e.target.checked) { this.mode = e.target.value; this.applyBg(); } });
    this.applyBg();

    // classes
    for (const id of ["cls-circle", "cls-square", "cls-rect", "cls-glyph"])
      document.getElementById(id).addEventListener("change", () => this.respawn());

    // font dropdown (+ loaded fonts), file loader, installed-font enumeration
    this.customFonts = new Set();
    const fontSel = document.getElementById("font");
    for (const f of COMMON_FONTS) this.addFontOption(f, false);
    fontSel.value = "Georgia";
    fontSel.addEventListener("change", () => { this.glyphs = new GlyphCache(this.renderer.gl); this.reglyph(); });
    document.getElementById("font-file").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const fam = await this.loadFontFile(file);
        this.addFontOption(fam, true);
        fontSel.value = fam;
        this.glyphs = new GlyphCache(this.renderer.gl);
        this.reglyph();
        this.flashStatus(`Loaded font "${fam}".`);
      } catch (err) { this.flashStatus("Could not load font: " + (err && err.message || err)); }
    });

    // character set
    document.getElementById("charset").addEventListener("change", () => { this.updateCharsetUI(); this.reglyph(); });
    document.getElementById("glyph-chars").addEventListener("input", () => this.reglyph());
    this.updateCharsetUI();

    // illuminant select
    const sel = document.getElementById("illuminant");
    for (const name of Object.keys(this.illumSpecs)) {
      const o = document.createElement("option");
      o.value = o.textContent = name;
      if (name === this.illumName) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => { this.setIlluminant(sel.value); this.renderFilterChips(); });

    // filter chips (all enabled by default)
    this.filterChecked = {};
    for (const name of Object.keys(this.filterSpecs))
      this.filterChecked[name] = true;
    this.renderFilterChips();

    this.applyURLParams();

    document.getElementById("respawn").addEventListener("click", () => this.respawn());
    const pauseBtn = document.getElementById("pause");
    pauseBtn.addEventListener("click", () => {
      this.paused = !this.paused;
      pauseBtn.textContent = this.paused ? "Play" : "Pause";
      pauseBtn.classList.toggle("active", this.paused);
    });
  }

  /** Add a font family to the dropdown (no duplicates). */
  addFontOption(fam, custom) {
    const sel = document.getElementById("font");
    if ([...sel.options].some((o) => o.value === fam)) return;
    const o = document.createElement("option");
    o.value = fam;
    o.textContent = fam + (custom ? "  (loaded)" : "");
    sel.appendChild(o);
  }

  /** Load a user-supplied font file (ttf/otf/woff/woff2) via the FontFace API
   *  and register it with the document so canvas/glyph rendering can use it. */
  async loadFontFile(file) {
    const buf = await file.arrayBuffer();
    let family = file.name.replace(/\.[^.]+$/, "").trim() || "Custom Font";
    if (this.customFonts.has(family)) family += " " + (this.customFonts.size + 1);
    const ff = new FontFace(family, buf);
    await ff.load();
    document.fonts.add(ff);
    this.customFonts.add(family);
    return family;
  }

  /** Show the custom-characters field only when the "Custom" set is selected. */
  updateCharsetUI() {
    const cs = document.getElementById("charset").value;
    document.getElementById("chars-wrap").style.display = cs === "custom" ? "" : "none";
  }

  /** Briefly show a transient message in the status line, then restore it. */
  flashStatus(msg) {
    const el = document.getElementById("status");
    el.textContent = msg;
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => this.setStatus(), 5000);
  }

  /** Optional deep-link config, e.g. ?mode=additive&classes=circle,glyph&count=30 */
  applyURLParams() {
    const q = new URLSearchParams(location.search);
    if (![...q.keys()].length) return;
    const setRange = (id, val) => {
      const el = document.getElementById(id);
      el.value = val; el.dispatchEvent(new Event("input"));
    };
    if (q.has("mode")) {
      const m = q.get("mode");
      const r = document.querySelector(`input[name=mode][value="${m}"]`);
      if (r) { r.checked = true; this.mode = m; this.applyBg(); }
    }
    if (q.has("classes")) {
      const want = new Set(q.get("classes").split(","));
      for (const [id, cl] of [["cls-circle", "circle"], ["cls-square", "square"],
                              ["cls-rect", "rect"], ["cls-glyph", "glyph"]])
        document.getElementById(id).checked = want.has(cl);
    }
    if (q.has("font")) { this.addFontOption(q.get("font"), false); document.getElementById("font").value = q.get("font"); }
    if (q.has("charset")) {
      const cs = q.get("charset");
      if ([...document.getElementById("charset").options].some((o) => o.value === cs))
        document.getElementById("charset").value = cs;
      this.updateCharsetUI();
    }
    if (q.has("chars")) {
      document.getElementById("glyph-chars").value = q.get("chars");
      document.getElementById("charset").value = "custom";
      this.updateCharsetUI();
    }
    if (q.has("count")) setRange("count", clamp(+q.get("count"), 1, 120));
    if (q.has("speed")) setRange("speed", clamp(+q.get("speed"), 0, 300));
    if (q.has("spread")) setRange("spread", clamp(+q.get("spread"), 0, 150));
    const bkey = q.has("brightness") ? "brightness" : (q.has("exposure") ? "exposure" : null);
    if (bkey) setRange("brightness", clamp(+q.get(bkey), 0, 400));
    if (q.has("illuminant") && this.illumSpecs[q.get("illuminant")]) {
      document.getElementById("illuminant").value = q.get("illuminant");
      this.setIlluminant(q.get("illuminant"));
      this.renderFilterChips();
    }
  }

  applyBg() {
    document.getElementById("stage").style.background = this.mode === "additive" ? "#000" : "#fff";
  }

  /** Rescale live velocities to the new mean speed, keeping each shape's
   *  distribution multiplier so the bell-curve spread is preserved. */
  rescaleSpeed() {
    const base = Math.min(this.renderer.width, this.renderer.height) || 700;
    for (const s of this.shapes) {
      const cur = Math.hypot(s.vx, s.vy) || 1;
      const want = this.speed * base * (s.speedMul != null ? s.speedMul : 1);
      s.vx = s.vx / cur * want; s.vy = s.vy / cur * want;
    }
  }

  /** Re-draw each shape's speed multiplier from the bell curve (used when the
   *  spread slider changes) and rescale, without moving anything. */
  resampleSpread() {
    const base = Math.min(this.renderer.width, this.renderer.height) || 700;
    for (const s of this.shapes) {
      s.speedMul = Math.max(0.05, gaussian(1, this.spread));
      const cur = Math.hypot(s.vx, s.vy) || 1;
      const want = this.speed * base * s.speedMul;
      s.vx = s.vx / cur * want; s.vy = s.vy / cur * want;
    }
  }

  renderFilterChips() {
    const box = document.getElementById("filter-list");
    box.innerHTML = "";
    for (const name of Object.keys(this.filterSpecs)) {
      const chip = document.createElement("label");
      chip.className = "chip" + (this.filterChecked[name] ? "" : " off");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = this.filterChecked[name];
      cb.addEventListener("change", () => {
        this.filterChecked[name] = cb.checked;
        chip.classList.toggle("off", !cb.checked);
        this.respawn();
      });
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = this.swatchCSS(this.filterSpecs[name]);
      chip.appendChild(cb); chip.appendChild(sw);
      chip.appendChild(document.createTextNode(name));
      box.appendChild(chip);
    }
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
(async function main() {
  try {
    const data = await loadSpectra();
    window.__app = new App(data);
  } catch (e) {
    console.error(e);
    const el = document.getElementById("error");
    el.classList.remove("hidden");
    el.textContent = "Spectral Bounce failed to start:\n\n" + (e && e.stack || e);
  }
})();
