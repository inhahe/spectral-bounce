#!/usr/bin/env python3
"""
Generate spectral data files for the Spectral Bounce web app.

Outputs (into ./spectra/):
  - cmf.json          CIE 1931 2-deg color-matching functions (x,y,z)
  - illuminants.json  Spectral power distributions of white lights
                      (default: 6500K blackbody radiation)
  - filters.json      Transmittance envelopes for a set of standard filters

Also writes ../spectra_bundle.js which embeds the same data as a global
`window.EMBEDDED_SPECTRA` so the app works when opened directly from file://
(no local web server needed).

All spectra are stored on a 380..730 nm grid at 5 nm spacing. The renderer
resamples them onto its own coarser wavelength grid at load time.
"""

import json
import math
import os

# ---------------------------------------------------------------------------
# Wavelength grid (nanometres)
# ---------------------------------------------------------------------------
LAMBDA_MIN = 380
LAMBDA_MAX = 730
LAMBDA_STEP = 5
WAVELENGTHS = list(range(LAMBDA_MIN, LAMBDA_MAX + 1, LAMBDA_STEP))


# ---------------------------------------------------------------------------
# CIE 1931 2-degree color matching functions
# Analytic multi-lobe Gaussian approximation from
# Wyman, Sloan & Shirley (2013), "Simple Analytic Approximations to the
# CIE XYZ Color Matching Functions", JCGT.
# ---------------------------------------------------------------------------
def _g(x, mu, s1, s2):
    """Piecewise Gaussian: sigma s1 below the peak, s2 above."""
    s = s1 if x < mu else s2
    t = (x - mu) / s
    return math.exp(-0.5 * t * t)


def cie_x(l):
    return (1.056 * _g(l, 599.8, 37.9, 31.0)
            + 0.362 * _g(l, 442.0, 16.0, 26.7)
            - 0.065 * _g(l, 501.1, 20.4, 26.2))


def cie_y(l):
    return (0.821 * _g(l, 568.8, 46.9, 40.5)
            + 0.286 * _g(l, 530.9, 16.3, 31.1))


def cie_z(l):
    return (1.217 * _g(l, 437.0, 11.8, 36.0)
            + 0.681 * _g(l, 459.0, 26.0, 13.8))


# ---------------------------------------------------------------------------
# Blackbody radiation (Planck's law), relative spectral power distribution.
# ---------------------------------------------------------------------------
def blackbody_spd(temperature_k):
    """Relative SPD of an ideal blackbody, normalised so peak value == 1."""
    h = 6.62607015e-34   # Planck constant   (J s)
    c = 2.99792458e8     # speed of light    (m/s)
    kB = 1.380649e-23    # Boltzmann constant (J/K)
    vals = []
    for lam_nm in WAVELENGTHS:
        lam = lam_nm * 1e-9
        # spectral radiance (per wavelength), constant factors cancel on normalise
        num = 2.0 * h * c * c / (lam ** 5)
        den = math.exp(h * c / (lam * kB * temperature_k)) - 1.0
        vals.append(num / den)
    peak = max(vals)
    return [v / peak for v in vals]


# ---------------------------------------------------------------------------
# Filter transmittance envelopes.
# These are physically-plausible, smoothly varying curves in [0.02, 0.96].
# ---------------------------------------------------------------------------
def logistic(l, center, k):
    return 1.0 / (1.0 + math.exp(-k * (l - center)))


def gauss(l, center, sigma):
    t = (l - center) / sigma
    return math.exp(-0.5 * t * t)


def _clampf(v, lo=0.02, hi=0.96):
    return max(lo, min(hi, v))


def build_filters():
    f = {}

    def longpass(center, k, floor=0.03, ceil=0.94):
        return [_clampf(floor + (ceil - floor) * logistic(l, center, k)) for l in WAVELENGTHS]

    def shortpass(center, k, floor=0.03, ceil=0.94):
        return [_clampf(floor + (ceil - floor) * logistic(l, center, -k)) for l in WAVELENGTHS]

    def band(center, sigma, floor=0.03, peak=0.9):
        return [_clampf(floor + (peak - floor) * gauss(l, center, sigma)) for l in WAVELENGTHS]

    def notch(center, sigma, base=0.92, depth=0.88):
        # passes everything except a dip around `center` (e.g. magenta blocks green)
        return [_clampf(base - depth * gauss(l, center, sigma)) for l in WAVELENGTHS]

    # Primaries / pure colours ------------------------------------------------
    f["Red 25"]        = longpass(600, 0.09)          # deep red longpass
    f["Deep Red 29"]   = longpass(618, 0.11)
    f["Orange 21"]     = longpass(560, 0.08)
    f["Amber 15"]      = longpass(520, 0.07, floor=0.04)
    f["Yellow 12"]     = longpass(486, 0.10, floor=0.04)
    f["Green 58"]      = band(535, 33)
    f["Deep Green 61"] = band(520, 24, peak=0.82)
    f["Blue 47"]       = band(452, 27, peak=0.82)
    f["Deep Blue 47B"] = band(440, 20, peak=0.78)

    # Secondaries -------------------------------------------------------------
    f["Cyan"]          = shortpass(572, 0.09)         # passes blue+green, blocks red
    f["Magenta"]       = notch(540, 42)               # passes blue+red, blocks green
    f["Yellow (minus-blue)"] = shortpass(0, 0)        # placeholder, overwritten below
    f["Yellow (minus-blue)"] = longpass(478, 0.11, floor=0.05)

    # Character gels ----------------------------------------------------------
    f["Lavender"]      = [_clampf(0.30 + 0.55 * gauss(l, 450, 40) + 0.45 * gauss(l, 640, 45))
                          for l in WAVELENGTHS]
    f["Straw"]         = [_clampf(0.10 + 0.85 * logistic(l, 500, 0.06)) for l in WAVELENGTHS]
    f["Teal"]          = band(490, 45, peak=0.85)
    f["Rose Pink"]     = [_clampf(0.20 + 0.72 * gauss(l, 620, 55) + 0.42 * gauss(l, 440, 35))
                          for l in WAVELENGTHS]
    f["Neutral Density 0.3"] = [0.50 for _ in WAVELENGTHS]
    f["Neutral Density 0.6"] = [0.25 for _ in WAVELENGTHS]

    return f


# ---------------------------------------------------------------------------
# Assemble & write
# ---------------------------------------------------------------------------
def main():
    here = os.path.dirname(os.path.abspath(__file__))
    spectra_dir = os.path.join(here, "spectra")
    os.makedirs(spectra_dir, exist_ok=True)

    cmf = {
        "wavelengths": WAVELENGTHS,
        "x": [round(cie_x(l), 6) for l in WAVELENGTHS],
        "y": [round(cie_y(l), 6) for l in WAVELENGTHS],
        "z": [round(cie_z(l), 6) for l in WAVELENGTHS],
        "note": "CIE 1931 2-deg observer, analytic approximation (Wyman et al. 2013)",
    }

    illuminants = {
        "wavelengths": WAVELENGTHS,
        "default": "Blackbody 6500K",
        "illuminants": {
            "Blackbody 6500K": {
                "spd": [round(v, 6) for v in blackbody_spd(6500)],
                "note": "Ideal blackbody radiator at 6500 K (Planck's law)",
            },
            "Blackbody 5500K": {
                "spd": [round(v, 6) for v in blackbody_spd(5500)],
                "note": "Ideal blackbody radiator at 5500 K (daylight-ish)",
            },
            "Blackbody 3200K": {
                "spd": [round(v, 6) for v in blackbody_spd(3200)],
                "note": "Tungsten / incandescent, ideal blackbody at 3200 K",
            },
            "Blackbody 9500K": {
                "spd": [round(v, 6) for v in blackbody_spd(9500)],
                "note": "Cool blue-white blackbody at 9500 K",
            },
            "Equal Energy E": {
                "spd": [1.0 for _ in WAVELENGTHS],
                "note": "Flat equal-energy illuminant",
            },
        },
    }

    filters = {
        "wavelengths": WAVELENGTHS,
        "filters": {name: {"transmittance": [round(v, 5) for v in vals]}
                    for name, vals in build_filters().items()},
    }

    with open(os.path.join(spectra_dir, "cmf.json"), "w") as fp:
        json.dump(cmf, fp, indent=1)
    with open(os.path.join(spectra_dir, "illuminants.json"), "w") as fp:
        json.dump(illuminants, fp, indent=1)
    with open(os.path.join(spectra_dir, "filters.json"), "w") as fp:
        json.dump(filters, fp, indent=1)

    bundle = {"cmf": cmf, "illuminants": illuminants, "filters": filters}
    with open(os.path.join(here, "spectra_bundle.js"), "w") as fp:
        fp.write("// Auto-generated by gen_spectra.py -- embedded fallback for file:// use.\n")
        fp.write("window.EMBEDDED_SPECTRA = ")
        json.dump(bundle, fp)
        fp.write(";\n")

    print("Wrote:")
    for name in ("cmf.json", "illuminants.json", "filters.json"):
        print("  spectra/" + name)
    print("  spectra_bundle.js")
    print(f"{len(filters['filters'])} filters, "
          f"{len(illuminants['illuminants'])} illuminants, "
          f"{len(WAVELENGTHS)} wavelength samples.")


if __name__ == "__main__":
    main()
