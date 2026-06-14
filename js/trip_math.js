/* trip_math.js — orbital-mechanics core for the Solar Expanse Hub trip/transfer planner.
 *
 * Self-contained, ES5-compatible, pure functions. No external libs, no DOM, no globals
 * beyond the IIFE export below. Style matches js/app.js (var, function declarations).
 *
 * Scope & model
 * -------------
 *   - Heliocentric, two-body, coplanar, circular-orbit Hohmann transfer between two
 *     Solar-System bodies, using the Sun's gravitational parameter (mu_sun).
 *   - Inputs are HELIOCENTRIC semi-major axes in AU (the `semi_major_au` field on
 *     planets / asteroids / comets in gamedata.json).
 *   - Delta-v is the HELIOCENTRIC budget: the burns to leave the origin's circular
 *     heliocentric orbit and to circularise into the destination's. It deliberately
 *     does NOT include local launch-from-surface, planetary capture/escape, or the
 *     Oberth effect of a real departure from low orbit. Treat it as the interplanetary
 *     cruise budget, not a launch-pad-to-touchdown total.
 *   - Eccentricity & inclination are ignored (circular, coplanar). Real windows and
 *     real delta-v vary; for eccentric/inclined targets (comets, Pluto, Mercury) the
 *     numbers are first-order only. See trip_spec.md for how the UI should caveat this.
 *
 * MOONS: a moon shares its parent planet's heliocentric orbit for the interplanetary
 *   leg, so pass the PARENT planet's semi_major_au. The local capture/escape into the
 *   moon's own orbit (distance_km from the parent) is a SEPARATE budget and is not
 *   modelled here — see localCaptureNote() and trip_spec.md. Don't overstate precision.
 *
 * EXOPLANETS orbit a different star, so a Hohmann transfer from Sol is not defined.
 *   isTransferComputable() returns false for them; the UI must exclude / flag them.
 *
 * Sanity check (Earth a=1.0 AU -> Mars a=1.5237 AU), computed by transfer():
 *   synodic_days   ~ 779.9   (expected ~780, ~26 months)
 *   transfer_days  ~ 258.9   (expected ~259)
 *   dv_depart_kms  ~ 2.945   (expected ~2.9)
 *   dv_arrive_kms  ~ 2.649   (expected ~2.6)
 *   dv_total_kms   ~ 5.594   (expected ~5.6)
 *   phase_angle_deg ~ 44.35  (target leads at departure; expected ~44)
 */
(function (root) {
  "use strict";

  // ---- constants -----------------------------------------------------------
  var AU_km = 1.495978707e8;   // 1 astronomical unit, kilometres (IAU 2012)
  var DAYS_PER_YEAR = 365.25;  // Julian year
  var SECONDS_PER_DAY = 86400;
  var DEG = 180 / Math.PI;

  // Sun's gravitational parameter mu = G*M_sun, in km^3 / s^2.
  // Derived from Kepler's third law so the module stays self-contained:
  //   for a body on a circular orbit of radius a (km) with period T (s),
  //   mu = 4*pi^2 * a^3 / T^2.  Using a = 1 AU and T = 1 Julian year gives the
  //   standard heliocentric value ~1.32712e11 km^3/s^2 (matches NASA).
  var YEAR_s = DAYS_PER_YEAR * SECONDS_PER_DAY;
  var SUN_GM = 4 * Math.PI * Math.PI * Math.pow(AU_km, 3) / (YEAR_s * YEAR_s);

  // ---- low-level helpers ---------------------------------------------------

  // Orbital period (seconds) of a circular orbit of radius r_km about the Sun.
  // T = 2*pi*sqrt(r^3 / mu).
  function orbitalPeriodSeconds(r_km) {
    return 2 * Math.PI * Math.sqrt(Math.pow(r_km, 3) / SUN_GM);
  }

  // Orbital period in days, given a heliocentric semi-major axis in AU.
  // (Equivalent to T_years = a_AU^1.5 for the Sun.)
  function orbitalPeriodDays(aAU) {
    return orbitalPeriodSeconds(aAU * AU_km) / SECONDS_PER_DAY;
  }

  // Circular orbital speed (km/s) at heliocentric radius r_km: v = sqrt(mu / r).
  function circularSpeed(r_km) {
    return Math.sqrt(SUN_GM / r_km);
  }

  // Vis-viva speed (km/s) at radius r_km on an orbit of semi-major axis a_km:
  //   v = sqrt( mu * (2/r - 1/a) ).
  function visVivaSpeed(r_km, a_km) {
    return Math.sqrt(SUN_GM * (2 / r_km - 1 / a_km));
  }

  // ---- synodic period ------------------------------------------------------
  // Time between successive identical Sun-origin-destination alignments, i.e.
  // between launch windows. 1/S = | 1/T1 - 1/T2 |. Returns days; Infinity if the
  // two orbits have the same period (co-orbital — no recurring window).
  function synodicPeriodDays(aAU1, aAU2) {
    var T1 = orbitalPeriodDays(aAU1);
    var T2 = orbitalPeriodDays(aAU2);
    var diff = Math.abs(1 / T1 - 1 / T2);
    if (diff === 0) return Infinity;
    return 1 / diff;
  }

  // ---- Hohmann transfer time ----------------------------------------------
  // Half the period of the transfer ellipse whose semi-major axis is the mean of
  // the two orbital radii. Returns days. Direction-independent.
  function transferTimeDays(aAU1, aAU2) {
    var r1 = aAU1 * AU_km;
    var r2 = aAU2 * AU_km;
    var aT = (r1 + r2) / 2;
    var tof_s = Math.PI * Math.sqrt(Math.pow(aT, 3) / SUN_GM);
    return tof_s / SECONDS_PER_DAY;
  }

  // ---- phase angle at departure -------------------------------------------
  // The angular lead of the DESTINATION ahead of the ORIGIN (degrees) at the
  // departure instant, so the destination arrives at the rendezvous point at the
  // same time as the spacecraft. Positive = destination is ahead of origin in the
  // direction of motion. Sign is meaningful: for an outbound transfer (origin
  // inner) it is positive (~+44 deg Earth->Mars); for an inbound transfer (origin
  // outer) it is negative (target trails).
  //   phase = pi - omega_target * t_transfer   (in radians), where
  //   omega_target = 2*pi / T_target is the destination's mean motion.
  // Normalised to (-180, 180].
  function phaseAngleDeg(aAU1, aAU2) {
    var tof_days = transferTimeDays(aAU1, aAU2);
    var Ttarget_days = orbitalPeriodDays(aAU2);
    var omegaTarget = 2 * Math.PI / Ttarget_days;     // rad/day
    var phaseRad = Math.PI - omegaTarget * tof_days;  // rad
    return normalizeDeg(phaseRad * DEG);
  }

  // Normalise an angle in degrees to the half-open interval (-180, 180].
  function normalizeDeg(deg) {
    var d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  // ---- delta-v budget (heliocentric) --------------------------------------
  // Departure burn: from the origin's circular speed onto the transfer ellipse.
  // Arrival burn: from the transfer ellipse onto the destination's circular speed.
  // Works in both directions (inner->outer and outer->inner); both burns are
  // returned as positive magnitudes.
  function deltaVBudget(aAU1, aAU2) {
    var r1 = aAU1 * AU_km;
    var r2 = aAU2 * AU_km;
    var aT = (r1 + r2) / 2;
    var vC1 = circularSpeed(r1);            // origin circular speed
    var vC2 = circularSpeed(r2);            // destination circular speed
    var vT1 = visVivaSpeed(r1, aT);         // transfer-ellipse speed at origin radius
    var vT2 = visVivaSpeed(r2, aT);         // transfer-ellipse speed at destination radius
    var dvDepart = Math.abs(vT1 - vC1);
    var dvArrive = Math.abs(vC2 - vT2);
    return {
      dv_depart_kms: dvDepart,
      dv_arrive_kms: dvArrive,
      dv_total_kms: dvDepart + dvArrive
    };
  }

  // ---- main entry point ----------------------------------------------------
  // transfer(aAU1, aAU2) -> {
  //   synodic_days, transfer_days,
  //   dv_depart_kms, dv_arrive_kms, dv_total_kms,
  //   phase_angle_deg
  // }
  // aAU1 = origin heliocentric semi-major axis (AU)
  // aAU2 = destination heliocentric semi-major axis (AU)
  // For a moon, pass its parent planet's semi_major_au (see module header).
  // Returns null if either axis is missing or non-positive (e.g. an exoplanet or
  // a body with no heliocentric orbit) — callers should gate on isTransferComputable.
  function transfer(aAU1, aAU2) {
    if (!isFinitePositive(aAU1) || !isFinitePositive(aAU2)) return null;
    var dv = deltaVBudget(aAU1, aAU2);
    return {
      synodic_days: synodicPeriodDays(aAU1, aAU2),
      transfer_days: transferTimeDays(aAU1, aAU2),
      dv_depart_kms: dv.dv_depart_kms,
      dv_arrive_kms: dv.dv_arrive_kms,
      dv_total_kms: dv.dv_total_kms,
      phase_angle_deg: phaseAngleDeg(aAU1, aAU2)
    };
  }

  function isFinitePositive(x) {
    return typeof x === "number" && isFinite(x) && x > 0;
  }

  // ---- body adapters (map gamedata.json rows -> a heliocentric AU axis) ----
  // These let the planner accept any body the hub already knows about without
  // each caller re-implementing the moon/exoplanet rules.

  // Is this body transfer-computable from Sol? Exoplanets (different star) are not;
  // anything lacking a usable heliocentric semi-major axis is not.
  function isTransferComputable(body, kind, planetsByName) {
    if (kind === "exoplanet") return false;
    return isFinitePositive(heliocentricAxisAU(body, kind, planetsByName));
  }

  // Resolve the heliocentric semi-major axis (AU) used for the interplanetary leg.
  //   planets / asteroids / comets : their own semi_major_au.
  //   moons                        : their PARENT planet's semi_major_au (looked up
  //                                  in planetsByName, a { name -> planetRow } map).
  //   exoplanets                   : null (different star — not from Sol).
  // Returns a number, or null when it cannot be determined.
  function heliocentricAxisAU(body, kind, planetsByName) {
    if (!body) return null;
    if (kind === "exoplanet") return null;
    if (kind === "moon") {
      var parent = planetsByName && body.parent ? planetsByName[body.parent] : null;
      return parent && isFinitePositive(parent.semi_major_au) ? parent.semi_major_au : null;
    }
    // planet | asteroid | comet | anything else with its own heliocentric axis
    return isFinitePositive(body.semi_major_au) ? body.semi_major_au : null;
  }

  // High-level convenience: compute a transfer between two gamedata bodies.
  //   originSpec / destSpec : { body: <row>, kind: "planet"|"moon"|"asteroid"|"comet"|"exoplanet" }
  //   planetsByName         : { name -> planetRow } map (for moon parent lookup)
  // Returns the transfer() object augmented with:
  //   origin_axis_au, dest_axis_au, origin_is_moon, dest_is_moon,
  //   notes : array of strings the UI should surface (capture/escape, eccentricity…)
  // Returns { error: "..." } when not computable (e.g. an exoplanet endpoint).
  function transferBetween(originSpec, destSpec, planetsByName) {
    if (!originSpec || !destSpec) return { error: "Pick an origin and a destination." };
    if (originSpec.kind === "exoplanet" || destSpec.kind === "exoplanet") {
      return { error: "Exoplanets orbit another star — no Hohmann transfer from Sol is defined." };
    }
    var a1 = heliocentricAxisAU(originSpec.body, originSpec.kind, planetsByName);
    var a2 = heliocentricAxisAU(destSpec.body, destSpec.kind, planetsByName);
    if (!isFinitePositive(a1) || !isFinitePositive(a2)) {
      return { error: "Missing heliocentric orbit data for one of the bodies." };
    }
    if (Math.abs(a1 - a2) < 1e-9) {
      return { error: "Origin and destination share the same heliocentric orbit (e.g. a planet and its own moon) — the interplanetary leg is ~0; only local transfer applies." };
    }
    var out = transfer(a1, a2);
    out.origin_axis_au = a1;
    out.dest_axis_au = a2;
    out.origin_is_moon = originSpec.kind === "moon";
    out.dest_is_moon = destSpec.kind === "moon";
    out.notes = buildNotes(originSpec, destSpec);
    return out;
  }

  function buildNotes(originSpec, destSpec) {
    var notes = [];
    if (originSpec.kind === "moon") notes.push(localCaptureNote(originSpec.body, "departure"));
    if (destSpec.kind === "moon") notes.push(localCaptureNote(destSpec.body, "arrival"));
    notes.push("Heliocentric Hohmann estimate: circular, coplanar two-body. Excludes launch-from-surface, planetary capture/escape and the Oberth effect; real budgets are higher.");
    notes.push("Eccentricity and inclination are ignored — treat eccentric or inclined targets (comets, Pluto, Mercury) as first-order only.");
    return notes;
  }

  // A short, honest note that a moon endpoint carries an extra, un-modelled local
  // capture/escape budget relative to its parent planet.
  function localCaptureNote(moonBody, when) {
    var who = moonBody && moonBody.name ? moonBody.name : "the moon";
    var parent = moonBody && moonBody.parent ? moonBody.parent : "its parent";
    return who + " shares " + parent + "'s heliocentric orbit for the cruise; the local "
      + (when === "departure" ? "escape from " : "capture into ") + who
      + " (separate from this interplanetary budget) is not included.";
  }

  // ---- formatting helpers (optional; pure) --------------------------------
  // Convenience for the UI; not required by the core math.
  function daysToMonths(days) { return days / (DAYS_PER_YEAR / 12); }
  function nextWindowPhaseText(aAU1, aAU2) {
    var phase = phaseAngleDeg(aAU1, aAU2);
    var dir = phase >= 0 ? "ahead of" : "behind";
    return "Depart when the destination is " + Math.abs(phase).toFixed(1) + "° " + dir + " the origin.";
  }

  // ---- export --------------------------------------------------------------
  var API = {
    // constants
    AU_km: AU_km,
    SUN_GM: SUN_GM,
    DAYS_PER_YEAR: DAYS_PER_YEAR,
    SECONDS_PER_DAY: SECONDS_PER_DAY,
    // core
    transfer: transfer,
    transferBetween: transferBetween,
    // pieces (exposed for the UI / tests)
    synodicPeriodDays: synodicPeriodDays,
    transferTimeDays: transferTimeDays,
    phaseAngleDeg: phaseAngleDeg,
    deltaVBudget: deltaVBudget,
    orbitalPeriodDays: orbitalPeriodDays,
    circularSpeed: circularSpeed,
    visVivaSpeed: visVivaSpeed,
    // body adapters
    heliocentricAxisAU: heliocentricAxisAU,
    isTransferComputable: isTransferComputable,
    localCaptureNote: localCaptureNote,
    // ui helpers
    daysToMonths: daysToMonths,
    nextWindowPhaseText: nextWindowPhaseText,
    normalizeDeg: normalizeDeg
  };

  // CommonJS (node test) + browser global, without assuming either exists.
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.TripMath = API;
})(typeof self !== "undefined" ? self : this);
