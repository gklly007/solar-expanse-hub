/* launch_windows_math.js — DATED launch-window solver for the Solar Expanse Hub.
 *
 * Self-contained, ES5-compatible, pure functions. No DOM, no external libs.
 * Style matches js/trip_math.js (var, function declarations, IIFE export).
 *
 * What this adds over trip_math.js
 * --------------------------------
 *   trip_math.js answers "how long is the cruise / how big the burn / how often
 *   does a window open" — but NOT *which calendar date* the next window is. This
 *   module answers that, by giving each body a position: a mean longitude (deg)
 *   at a fixed EPOCH plus a mean motion derived from its semi-major axis. It is a
 *   faithful port of the stockmaj Solar Expanse wiki launch-window calculator
 *   (docs/assets/js/launch-windows.js): nextWindow / nextNWindows.
 *
 * Model (identical to the wiki, and consistent with trip_math.js's assumptions)
 * -----------------------------------------------------------------------------
 *   - Heliocentric, two-body, coplanar, CIRCULAR orbits.
 *   - Each body has { a : semi-major axis in AU, longitude : mean longitude in
 *     DEGREES at EPOCH 1959-01-01 }. Mean motion n = 2*pi / a^1.5  (radians per
 *     YEAR, with a in AU — Kepler's third law about the Sun, T = a^1.5 years).
 *   - Angle of a body at a date:  theta(t) = lon0 + n * (daysSinceEpoch / 365.25),
 *     wrapped to [0, 2*pi).
 *   - Hohmann transfer time = 0.5 * ((a_from + a_to)/2)^1.5  YEARS  (half the
 *     period of the transfer ellipse). transfer_days = that * 365.25.
 *   - A window opens when the lead of the destination over the origin equals the
 *     "required" phase  pi - n_to * t_transfer  (so the target arrives at the
 *     transfer far-side exactly when the spacecraft does). The relative angle
 *     drifts at rate (n_from - n_to) per year; we solve for the next t >= now and
 *     wrap by the synodic period 2*pi / |n_from - n_to|.
 *
 * IMPORTANT — units & epoch
 *   - EPOCH is 1959-01-01 UTC (the game's contract baseline). The longitudes in
 *     body_longitudes.json are anchored to THIS epoch — do not mix with J2000
 *     data unless you also pass a matching epochMs.
 *   - Dates are handled as epoch-milliseconds (UTC) at this layer so the module
 *     never depends on local timezone. The wiki used Date objects; the math is
 *     the same.
 *
 * Caveats (same as trip_math.js): circular & coplanar only. Eccentric/inclined
 *   targets (comets, Pluto, Mercury) are first-order. A moon shares its parent
 *   planet's heliocentric orbit AND longitude for the cruise — pass the parent's
 *   a and longitude (body_longitudes.json already records the parent value under
 *   each moon's name).
 *
 * Sanity check (Earth a=1.0, lon=168 -> Mars a=1.5237, lon=0, from 2020-01-01):
 *   windows recur ~779-780 days (~26 months) apart, transfer ~259 days. See
 *   windows_spec.md and the wiki page for the canonical numbers.
 */
(function (root) {
  "use strict";

  // ---- constants -----------------------------------------------------------
  var EPOCH_MS = Date.UTC(1959, 0, 1); // 1959-01-01T00:00:00Z — game baseline
  var DAY_MS = 86400000;
  var YEAR_DAYS = 365.25;
  var TWO_PI = Math.PI * 2;
  var DEG = Math.PI / 180;

  // ---- low-level helpers ---------------------------------------------------

  // Mean longitude (radians, wrapped to [0,2pi)) of a body at a given number of
  // days since EPOCH. longitudeDeg = mean longitude at EPOCH; n = mean motion in
  // rad/year (= 2*pi / a^1.5).
  function angleAt(longitudeDeg, n, daysSinceEpoch) {
    var theta = longitudeDeg * DEG + n * (daysSinceEpoch / YEAR_DAYS);
    return ((theta % TWO_PI) + TWO_PI) % TWO_PI;
  }

  // Mean motion (radians per YEAR) for a heliocentric circular orbit of
  // semi-major axis aAU. T = a^1.5 years  =>  n = 2*pi / a^1.5.
  function meanMotion(aAU) {
    return TWO_PI / Math.pow(aAU, 1.5);
  }

  // Hohmann transfer time in YEARS between two heliocentric circular orbits.
  // Half the period of the transfer ellipse (semi-major axis = mean of the two
  // radii): 0.5 * ((a1+a2)/2)^1.5 years. Direction-independent.
  function hohmannTransferYears(aFromAU, aToAU) {
    return 0.5 * Math.pow((aFromAU + aToAU) / 2, 1.5);
  }

  // Convenience: transfer time in days.
  function transferDays(aFromAU, aToAU) {
    return hohmannTransferYears(aFromAU, aToAU) * YEAR_DAYS;
  }

  // ---- core solver (object form — faithful wiki port) ----------------------
  // from / to are { a: <AU>, longitude: <deg at epoch> } objects.
  // fromDateMs is the search start in epoch-ms (UTC). epochMs is optional
  // (defaults to EPOCH_MS). Returns the next launch instant as epoch-ms, or null
  // if no recurring window exists (identical / co-orbital orbits).
  function nextWindowMs(from, to, fromDateMs, epochMs) {
    if (!from || !to) return null;
    if (!isFinitePositive(from.a) || !isFinitePositive(to.a)) return null;
    if (Math.abs(from.a - to.a) < 1e-9) return null; // same orbit: no transfer
    var epoch = typeof epochMs === "number" ? epochMs : EPOCH_MS;
    var daysSinceEpoch = (fromDateMs - epoch) / DAY_MS;

    var nFrom = meanMotion(from.a);
    var nTo = meanMotion(to.a);
    var thetaFrom = angleAt(from.longitude, nFrom, daysSinceEpoch);
    var thetaTo = angleAt(to.longitude, nTo, daysSinceEpoch);

    // Current lead of destination over origin, in [0,2pi).
    var rel = (((thetaTo - thetaFrom) % TWO_PI) + TWO_PI) % TWO_PI;

    // Required lead at launch so the target reaches the transfer far-side just
    // as the spacecraft arrives: pi - n_to * t_transfer.
    var tTransferYears = hohmannTransferYears(from.a, to.a);
    var required = Math.PI - nTo * tTransferYears;
    required = ((required % TWO_PI) + TWO_PI) % TWO_PI;

    // rel drifts at (n_from - n_to) rad/year. Solve for the next t >= 0 (years).
    var omega = nFrom - nTo;
    if (Math.abs(omega) < 1e-12) return null; // co-orbital
    var synodicYears = TWO_PI / Math.abs(omega);
    var delta = (rel - required) / omega; // years from fromDate to the window
    while (delta < 0) delta += synodicYears;
    while (delta >= synodicYears) delta -= synodicYears;

    return fromDateMs + delta * YEAR_DAYS * DAY_MS;
  }

  // N successive windows (object form). Returns an array of epoch-ms launch
  // instants. Each search resumes one day after the previous window so the same
  // window is never returned twice. count defaults to 5.
  function nextNWindowsMs(from, to, fromDateMs, count, epochMs) {
    var out = [];
    var n = typeof count === "number" && count > 0 ? Math.floor(count) : 5;
    var cursor = fromDateMs;
    for (var i = 0; i < n; i++) {
      var w = nextWindowMs(from, to, cursor, epochMs);
      if (w === null) break;
      out.push(w);
      cursor = w + DAY_MS;
    }
    return out;
  }

  // ---- primary hub-facing API ---------------------------------------------
  // nextWindows(fromAxisAU, fromLonDeg, toAxisAU, toLonDeg, startDateMs, count, epochMs)
  //   -> [ { launchMs, arriveMs, transferDays }, ... ]
  // Scalar-argument convenience built on the object solver. arriveMs = launchMs
  // + the (direction-independent) Hohmann transfer time. Returns [] when there is
  // no recurring window (identical / co-orbital orbits, or bad inputs).
  function nextWindows(fromAxisAU, fromLonDeg, toAxisAU, toLonDeg, startDateMs, count, epochMs) {
    var from = { a: fromAxisAU, longitude: fromLonDeg };
    var to = { a: toAxisAU, longitude: toLonDeg };
    var start = typeof startDateMs === "number" ? startDateMs : Date.now();
    var launches = nextNWindowsMs(from, to, start, count, epochMs);
    if (launches.length === 0) return [];
    var tofDays = transferDays(fromAxisAU, toAxisAU);
    var tofMs = tofDays * DAY_MS;
    var out = [];
    for (var i = 0; i < launches.length; i++) {
      out.push({
        launchMs: launches[i],
        arriveMs: launches[i] + tofMs,
        transferDays: tofDays
      });
    }
    return out;
  }

  // Synodic period (days) between windows for two axes — handy for the UI to
  // show "≈ N days apart" without re-deriving it. Infinity for co-orbital.
  function synodicDays(fromAxisAU, toAxisAU) {
    var omega = meanMotion(fromAxisAU) - meanMotion(toAxisAU); // rad/year
    if (Math.abs(omega) < 1e-12) return Infinity;
    return (TWO_PI / Math.abs(omega)) * YEAR_DAYS;
  }

  // ---- date formatting helper (optional; pure) -----------------------------
  // ISO yyyy-mm-dd (UTC) for an epoch-ms value, matching the wiki's display.
  function fmtDateUTC(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "—";
    return new Date(ms).toISOString().slice(0, 10);
  }

  function isFinitePositive(x) {
    return typeof x === "number" && isFinite(x) && x > 0;
  }

  // ---- export --------------------------------------------------------------
  var API = {
    // constants
    EPOCH_MS: EPOCH_MS,
    YEAR_DAYS: YEAR_DAYS,
    DAY_MS: DAY_MS,
    // primary hub-facing API
    nextWindows: nextWindows,           // scalar args -> [{launchMs,arriveMs,transferDays}]
    synodicDays: synodicDays,
    transferDays: transferDays,
    // faithful wiki ports (object args, epoch-ms)
    nextWindowMs: nextWindowMs,
    nextNWindowsMs: nextNWindowsMs,
    // pieces
    angleAt: angleAt,
    meanMotion: meanMotion,
    hohmannTransferYears: hohmannTransferYears,
    fmtDateUTC: fmtDateUTC
  };

  // CommonJS (node test) + browser global, without assuming either exists.
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.LaunchWindows = API;
})(typeof self !== "undefined" ? self : this);
