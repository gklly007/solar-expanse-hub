/* gravity_assist.js — single-flyby gravity-assist trajectory search for the
 * Solar Expanse Hub.  Patched-conic, circular-coplanar, universal-variable
 * Lambert solver.  Self-contained, ES5, pure functions, no DOM.
 *
 * Adapted from stockmaj/solar-expanse-wiki docs/assets/js/gravity-assist.js
 * (the wiki's working calculator).  The orbital math (positionAt, the
 * universal-variable Lambert solver with Stumpff C(z)/S(z), bestTrajectory,
 * bestDirect) is ported faithfully, including its numerical guards.  The DOM
 * binding has been removed and replaced with a clean pure-function API shaped
 * for our hub:  bestFlyby() / rankFlybys().
 *
 * MODEL & UNITS ------------------------------------------------------------
 *   - Heliocentric, two-body, coplanar, circular orbits about the Sun.
 *   - Internally distance is AU and time is YEARS, so the Sun's gravitational
 *     parameter is mu = 4*pi^2 (because Kepler's third law gives T^2 = a^3 in
 *     AU/yr).  Velocities therefore come out in AU/yr; we convert to km/s for
 *     reporting with AU_km / YEAR_seconds (see AU_PER_YR_TO_KM_S below).
 *   - A body is { name, a (AU), longitude (deg at epoch 1959-01-01) }.  Pass the
 *     SAME elements the wiki launch-windows calculator uses (see
 *     ga_longitudes.json) so positions agree between the two tools.
 *   - The Sun is modelled with a = 0; bestTrajectory() special-cases it as a
 *     ~0.2 AU perihelion "Oberth" dip rather than an orbit at zero radius.
 *
 * FLYBY COST MODEL ---------------------------------------------------------
 *   Free-rotation patched-conic: the gravity assist is assumed able to bend the
 *   hyperbolic-excess velocity (v_inf) by whatever angle is needed at no cost,
 *   so the traveller pays only  |v_at_launch - v_origin| + |v_at_arrival -
 *   v_target|  (launch v_inf + arrival v_inf).  This is a BEST-CASE ranking
 *   proxy, not a flyable mission delta-v: it ignores the v_inf-magnitude match
 *   the flyby body can actually deliver, plus capture/escape, launch-from-
 *   surface and the Oberth effect.  Use it to RANK which body helps most and to
 *   compare against the direct (no-flyby) Lambert cost in the same window.
 *
 * MOONS / EXOPLANETS -------------------------------------------------------
 *   Moons have no heliocentric longitude of their own; resolve a moon to its
 *   parent planet's element before calling here (the parent shares the cruise
 *   orbit — same rule as trip_math.js).  Exoplanets orbit another star and are
 *   not defined for a Sol-centred transfer.  bestFlyby() simply needs the
 *   resolved {a, longitude} objects; the caller owns that mapping.
 */
(function (root) {
  "use strict";

  // ---- constants -----------------------------------------------------------
  var MU = 4 * Math.PI * Math.PI;        // AU^3 / yr^2  (Sun, Kepler in AU/yr)
  var DAY_MS = 86400000;
  var YEAR_DAYS = 365.25;                // Julian year
  var YEAR_MS = YEAR_DAYS * DAY_MS;
  var TWO_PI = Math.PI * 2;
  var DEG = Math.PI / 180;

  // Convert AU/yr -> km/s.  Derived from the hub's own constants (matches
  // trip_math.js AU_km = 1.495978707e8 and a 365.25 * 86400 s year) so both
  // planners agree exactly:
  //   1 AU/yr = 1.495978707e8 km / (365.25 * 86400 s) = 4.740470... km/s,
  // which equals the value the upstream wiki hard-codes (4.74047) to 6 digits.
  var AU_km = 1.495978707e8;
  var YEAR_SECONDS = YEAR_DAYS * 86400;
  var AU_PER_YR_TO_KM_S = AU_km / YEAR_SECONDS;   // = 4.740470 km/s

  // Default epoch for body longitudes: the game's contract baseline 1959-01-01.
  var EPOCH_MS = Date.UTC(1959, 0, 1);

  // ---- tiny 2D vector helpers ----------------------------------------------
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function vmag(a)    { return Math.sqrt(a[0] * a[0] + a[1] * a[1]); }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function vscale(a, s) { return [a[0] * s, a[1] * s]; }

  // ---- position at date (circular coplanar; same convention as launch-windows)
  // body = { a, longitude } where longitude is degrees at epochMs.
  // Returns { r:[x,y] AU, v:[vx,vy] AU/yr, theta } for a circular orbit.
  // A body with a <= 0 (the Sun) sits at the origin with zero velocity; the
  // bestTrajectory path special-cases that so the Lambert legs use a near-Sun
  // perihelion point instead of the singular origin.
  function positionAt(body, dateMs, epochMs) {
    if (!body.a || body.a <= 0) {
      return { r: [0, 0], v: [0, 0], theta: 0 };
    }
    var daysSinceEpoch = (dateMs - epochMs) / DAY_MS;
    var n = TWO_PI / Math.pow(body.a, 1.5);          // mean motion (rad/yr)
    var theta = body.longitude * DEG + n * (daysSinceEpoch / YEAR_DAYS);
    theta = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
    var r = [body.a * Math.cos(theta), body.a * Math.sin(theta)];
    var vmag_circ = Math.sqrt(MU / body.a);          // sqrt(mu/a), tangential
    var v = [-vmag_circ * Math.sin(theta), vmag_circ * Math.cos(theta)];
    return { r: r, v: v, theta: theta };
  }

  // ---- Stumpff functions (universal-variable Lambert) ----------------------
  function stumpffC(z) {
    if (z > 1e-6)  return (1 - Math.cos(Math.sqrt(z))) / z;
    if (z < -1e-6) return (1 - Math.cosh(Math.sqrt(-z))) / z;
    return 0.5 - z / 24 + z * z / 720;               // series for z near 0
  }
  function stumpffS(z) {
    if (z > 1e-6) {
      var sz = Math.sqrt(z);
      return (sz - Math.sin(sz)) / (sz * sz * sz);
    }
    if (z < -1e-6) {
      var smz = Math.sqrt(-z);
      return (Math.sinh(smz) - smz) / (smz * smz * smz);
    }
    return 1 / 6 - z / 120 + z * z / 5040;
  }

  // ---- Lambert solver (universal-variable, Bate/Mueller/White) -------------
  // Given r1, r2 (AU), tof (years), prograde (bool) -> { v1, v2 } velocity
  // vectors (AU/yr) of the transfer arc, or null when the geometry/iteration
  // degenerates.  Newton iteration on z with a bisection bracket fallback.
  function lambert(r1, r2, tof, prograde) {
    var r1m = vmag(r1), r2m = vmag(r2);
    var cosDnu = vdot(r1, r2) / (r1m * r2m);
    var crossZ = r1[0] * r2[1] - r1[1] * r2[0];      // 2D cross (direction)
    var dnu;                                          // transfer angle
    if (prograde) {
      dnu = (crossZ >= 0) ? Math.acos(Math.max(-1, Math.min(1, cosDnu)))
                          : TWO_PI - Math.acos(Math.max(-1, Math.min(1, cosDnu)));
    } else {
      dnu = (crossZ < 0)  ? Math.acos(Math.max(-1, Math.min(1, cosDnu)))
                          : TWO_PI - Math.acos(Math.max(-1, Math.min(1, cosDnu)));
    }
    var sinDnu = Math.sin(dnu);
    if (Math.abs(sinDnu) < 1e-10) return null;        // collinear -> plane undefined
    var A = Math.sin(dnu) * Math.sqrt(r1m * r2m / (1 - cosDnu));

    var z = 0;                                        // start near parabolic
    var zLow = -4 * Math.PI * Math.PI;
    var zHigh = 4 * Math.PI * Math.PI;
    var t = 0, y = 0;
    for (var i = 0; i < 30; i++) {
      var C = stumpffC(z);
      var S = stumpffS(z);
      y = r1m + r2m + A * (z * S - 1) / Math.sqrt(C);
      if (A > 0 && y < 0) {
        // Push z up until y > 0 (short-way edge cases).  BOUNDED: the upstream
        // wiki loop was `while (y < 0) { z += 0.1; ... }` with no cap, which can
        // spin for many seconds (or effectively hang) on long outer-planet
        // arcs where C(z) oscillates through ~0 for large z.  Cap the climb at
        // the z bracket and bail to null if y can't be made positive.
        var guard = 0;
        while (y < 0 && z < zHigh && guard < 1000) {
          z += 0.1; guard++;
          C = stumpffC(z); S = stumpffS(z);
          y = r1m + r2m + A * (z * S - 1) / Math.sqrt(C);
        }
        if (!(y > 0) || !isFinite(y) || !isFinite(C) || C <= 0) return null;
      }
      // Guard against a non-finite / non-positive C from a runaway z.
      if (!isFinite(C) || C <= 0 || !isFinite(y) || y < 0) return null;
      var x = Math.sqrt(y / C);
      t = (x * x * x * S + A * Math.sqrt(y)) / Math.sqrt(MU);
      if (Math.abs(t - tof) < 1e-8) break;
      if (t < tof) zLow = z; else zHigh = z;          // bisection bracket
      var dtdz;
      if (Math.abs(z) > 1e-6) {
        dtdz = (x * x * x * (S - 1.5 * S / z + 0.5 * C / z) - 0.375 * A * x / Math.sqrt(C) + 0.125 * A * (3 * S * Math.sqrt(y) + A * Math.sqrt(C / y))) / Math.sqrt(MU);
      } else {
        var y0 = r1m + r2m - A * Math.sqrt(2);        // series at z = 0
        dtdz = (Math.sqrt(2) / 40) * Math.pow(y0, 1.5) + (A / 8) * (Math.sqrt(y0) + A * Math.sqrt(1 / (2 * y0)));
        dtdz = dtdz / Math.sqrt(MU);
      }
      var zNext = z - (t - tof) / dtdz;               // Newton step
      if (zNext < zLow || zNext > zHigh || !isFinite(zNext)) {
        zNext = 0.5 * (zLow + zHigh);                 // clamp to bracket
      }
      z = zNext;
    }
    if (!isFinite(z) || !isFinite(y) || y <= 0) return null;

    var f = 1 - y / r1m;
    var g = A * Math.sqrt(y / MU);
    var gdot = 1 - y / r2m;
    if (Math.abs(g) < 1e-12) return null;
    var v1 = vscale(vsub(r2, vscale(r1, f)), 1 / g);
    var v2 = vscale(vsub(vscale(r2, gdot), r1), 1 / g);
    return { v1: v1, v2: v2 };
  }

  // ---- single-flyby trajectory optimizer -----------------------------------
  // Coarse grid over launch date (every 15 days) x leg-1 time x leg-2 time,
  // bracketing each leg's Hohmann time by [0.4x, 1.8x] and capping the grid to
  // ~200 steps/dim so outer-planet routes stay bounded.  Free-rotation flyby:
  // cost = launch v_inf + arrival v_inf.  Returns the best grid point or null.
  //
  // Performance knobs (all optional; DEFAULTS reproduce the upstream wiki grid):
  //   args.maxStepsPerDim (default 200): grid cells per leg dimension. The grid
  //     is ALWAYS ~maxStepsPerDim^2 cells regardless of leg length (the step
  //     scales with the bracket), so this — not leg duration — is the real cost
  //     driver. An uncapped 9-planet scan with 200 is ~30 s; dropping to ~70
  //     makes it sub-second with the SAME top-ranked flybys (the optimum is
  //     broad). The UI should pass a smaller value for interactivity.
  //   args.launchStepDays (default 15): launch-date grid step (days).
  //   args.maxLegDays (default unbounded = wiki): clamp each leg's MAX search
  //     duration. CAUTION: a single leg can legitimately exceed the launch-date
  //     window (Jupiter->Pluto's min leg is ~7700 days), so DON'T set this to
  //     the window length — that drops valid long-leg assists. Only use it as a
  //     generous absolute ceiling (e.g. ~30 yr) to trim decade+ outer->outer
  //     arcs if desired; coarsening maxStepsPerDim is the better speed lever.
  function bestTrajectory(args) {
    var earth = args.earth;            // origin body { a, longitude }
    var flyby = args.flybyBody;        // candidate flyby body
    var target = args.target;          // destination body
    var fromMs = args.fromDateMs;
    var toMs = args.toDateMs;
    var epoch = (typeof args.epochMs === "number") ? args.epochMs : EPOCH_MS;
    var maxLegDays = (typeof args.maxLegDays === "number" && args.maxLegDays > 0)
      ? args.maxLegDays : Infinity;
    var isSunFlyby = !flyby.a || flyby.a <= 0;

    var LAUNCH_STEP_DAYS = (typeof args.launchStepDays === "number" && args.launchStepDays > 0)
      ? args.launchStepDays : 15;
    var MAX_STEPS_PER_DIM = (typeof args.maxStepsPerDim === "number" && args.maxStepsPerDim > 0)
      ? args.maxStepsPerDim : 200;
    var SUN_PERIHELION_AU = 0.2;       // Oberth dip for a Sun "flyby"

    var flybyA = isSunFlyby ? SUN_PERIHELION_AU : flyby.a;
    var hohmann1 = 0.5 * Math.pow((earth.a + flybyA) / 2, 1.5) * YEAR_DAYS;
    var leg1Min = Math.max(40, hohmann1 * 0.4);
    var leg1Max = Math.min(hohmann1 * 1.8, maxLegDays);
    if (leg1Max <= leg1Min) return null;          // window too short for this leg
    var leg1Step = Math.max(15, Math.ceil((leg1Max - leg1Min) / MAX_STEPS_PER_DIM));
    var hohmann2 = 0.5 * Math.pow((flybyA + target.a) / 2, 1.5) * YEAR_DAYS;
    var leg2Min = Math.max(60, hohmann2 * 0.4);
    var leg2Max = Math.min(hohmann2 * 1.8, maxLegDays);
    if (leg2Max <= leg2Min) return null;
    var leg2Step = Math.max(15, Math.ceil((leg2Max - leg2Min) / MAX_STEPS_PER_DIM));

    var best = null;
    for (var lMs = fromMs; lMs <= toMs; lMs += LAUNCH_STEP_DAYS * DAY_MS) {
      var earthPos = positionAt(earth, lMs, epoch);
      for (var leg1 = leg1Min; leg1 <= leg1Max; leg1 += leg1Step) {
        var fMs = lMs + leg1 * DAY_MS;
        var flybyPos;
        if (isSunFlyby) {
          // Perihelion point on the bisector between origin (at flyby time) and
          // a preview of the target near the middle of leg 2, at 0.2 AU.
          var midMs = fMs + (leg2Min + leg2Max) / 2 * DAY_MS;
          var tposPreview = positionAt(target, midMs, epoch);
          var ex = earthPos.r[0], ey = earthPos.r[1];
          var em = Math.sqrt(ex * ex + ey * ey) || 1;
          var tx = tposPreview.r[0], ty = tposPreview.r[1];
          var tm = Math.sqrt(tx * tx + ty * ty) || 1;
          var dx = ex / em + tx / tm;
          var dy = ey / em + ty / tm;
          var dm = Math.sqrt(dx * dx + dy * dy);
          if (dm < 1e-6) { dx = ex / em; dy = ey / em; dm = 1; }
          flybyPos = {
            r: [SUN_PERIHELION_AU * dx / dm, SUN_PERIHELION_AU * dy / dm],
            v: [0, 0],
            theta: 0
          };
        } else {
          flybyPos = positionAt(flyby, fMs, epoch);
        }
        var lam1 = lambert(earthPos.r, flybyPos.r, leg1 / YEAR_DAYS, true);
        if (!lam1) continue;
        var vInfLaunch = vmag(vsub(lam1.v1, earthPos.v));
        for (var leg2 = leg2Min; leg2 <= leg2Max; leg2 += leg2Step) {
          var aMs = fMs + leg2 * DAY_MS;
          var targetPos = positionAt(target, aMs, epoch);
          var lam2 = lambert(flybyPos.r, targetPos.r, leg2 / YEAR_DAYS, true);
          if (!lam2) continue;
          var vInfArrive = vmag(vsub(lam2.v2, targetPos.v));
          var cost = vInfLaunch + vInfArrive;          // free-rotation flyby
          if (!isFinite(cost)) continue;
          if (!best || cost < best.cost) {
            best = {
              cost: cost,
              launchMs: lMs,
              flybyMs: fMs,
              arriveMs: aMs,
              vInfLaunch: vInfLaunch,
              vInfArrive: vInfArrive,
              vInfLaunchKms: vInfLaunch * AU_PER_YR_TO_KM_S,
              vInfArriveKms: vInfArrive * AU_PER_YR_TO_KM_S,
              totalDvKms: cost * AU_PER_YR_TO_KM_S
            };
          }
        }
      }
    }
    return best;
  }

  // ---- direct (no-flyby) cost, for the comparison baseline -----------------
  function bestDirect(args) {
    var earth = args.earth, target = args.target;
    var fromMs = args.fromDateMs, toMs = args.toDateMs;
    var epoch = (typeof args.epochMs === "number") ? args.epochMs : EPOCH_MS;
    var LAUNCH_STEP_DAYS = 15, TOF_STEP_DAYS = 15;
    var hohmann = 0.5 * Math.pow((earth.a + target.a) / 2, 1.5) * YEAR_DAYS;
    var tofMin = Math.max(60, hohmann * 0.5), tofMax = hohmann * 1.6;
    var best = null;
    for (var lMs = fromMs; lMs <= toMs; lMs += LAUNCH_STEP_DAYS * DAY_MS) {
      var ep = positionAt(earth, lMs, epoch);
      for (var tof = tofMin; tof <= tofMax; tof += TOF_STEP_DAYS) {
        var aMs = lMs + tof * DAY_MS;
        var tp = positionAt(target, aMs, epoch);
        var lam = lambert(ep.r, tp.r, tof / YEAR_DAYS, true);
        if (!lam) continue;
        var vInfLaunch = vmag(vsub(lam.v1, ep.v));
        var vInfArrive = vmag(vsub(lam.v2, tp.v));
        var c = vInfLaunch + vInfArrive;
        if (!isFinite(c)) continue;
        if (!best || c < best.cost) {
          best = {
            cost: c, launchMs: lMs, arriveMs: aMs,
            vInfLaunch: vInfLaunch, vInfArrive: vInfArrive,
            vInfLaunchKms: vInfLaunch * AU_PER_YR_TO_KM_S,
            vInfArriveKms: vInfArrive * AU_PER_YR_TO_KM_S,
            totalDvKms: c * AU_PER_YR_TO_KM_S
          };
        }
      }
    }
    return best;
  }

  // ---- candidate-body note -------------------------------------------------
  function flybyNote(body) {
    if (!body) return "";
    if (!body.a || body.a <= 0) return "Solar Oberth maneuver — deep dip past the Sun";
    if (body.a < 1) return "Inner-system flyby";
    if (body.a < 5) return "Mid-system flyby";
    if (body.a < 30) return "Outer-planet flyby";
    return "Deep outer-system flyby";
  }

  // ---- helpers for the public API ------------------------------------------
  function isFinitePositive(x) { return typeof x === "number" && isFinite(x) && x > 0; }

  // Resolve a body argument: either an object { a, longitude[, name] } or a name
  // string looked up in `bodies` (case-insensitive).  Returns the body or null.
  function resolveBody(arg, bodies) {
    if (arg && typeof arg === "object") return arg;
    if (typeof arg !== "string" || !bodies) return null;
    var needle = arg.trim().toLowerCase();
    for (var i = 0; i < bodies.length; i++) {
      if (bodies[i] && bodies[i].name && bodies[i].name.toLowerCase() === needle) return bodies[i];
    }
    return null;
  }

  function windowFromDep(depDateMs, opts) {
    var o = opts || {};
    var fromMs = (typeof depDateMs === "number" && isFinite(depDateMs))
      ? depDateMs : Date.UTC(2020, 0, 1);
    var years = isFinitePositive(o.windowYears) ? o.windowYears : 10;
    return { fromMs: fromMs, toMs: fromMs + years * YEAR_MS,
             epoch: (typeof o.epochMs === "number") ? o.epochMs : EPOCH_MS };
  }

  // ---- PUBLIC: bestFlyby ---------------------------------------------------
  // bestFlyby(originName, targetName, bodies, depDateMs, opts) ->
  //   {
  //     flybyBody,                 // name of the best flyby body (or null)
  //     launch_vinf_kms,           // launch v_inf of the best flyby route
  //     arrive_vinf_kms,           // arrival v_inf of the best flyby route
  //     total_cost_kms,            // launch + arrival v_inf (flyby route)
  //     transfer1_days,            // origin -> flyby leg duration (days)
  //     transfer2_days,            // flyby -> target leg duration (days)
  //     vs_direct_kms,             // direct (no-flyby) total v_inf in same window
  //     saved_kms,                 // vs_direct_kms - total_cost_kms (>0 = helps)
  //     launchMs, flybyMs, arriveMs,
  //     direct,                    // { total_cost_kms, launchMs, arriveMs, ... }
  //     candidates                 // full ranked list (see rankFlybys)
  //   }
  //   or { error } when inputs are unusable.
  //
  // originName / targetName may be body NAMES (looked up in `bodies`) or body
  // objects { a, longitude }.  `bodies` is the candidate pool (e.g. the array
  // from ga_longitudes.json).  depDateMs is the earliest launch instant (ms).
  function bestFlyby(originName, targetName, bodies, depDateMs, opts) {
    var origin = resolveBody(originName, bodies);
    var target = resolveBody(targetName, bodies);
    if (!origin) return { error: "Unknown origin body." };
    if (!target) return { error: "Unknown target body." };
    if (origin === target || origin.name === target.name) {
      return { error: "Origin and target must be different bodies." };
    }
    if (!isFinitePositive(origin.a)) return { error: "Origin has no heliocentric orbit (a)." };
    if (!isFinitePositive(target.a)) return { error: "Target has no heliocentric orbit (a)." };

    var ranked = rankFlybys(originName, targetName, bodies, depDateMs, opts);
    if (ranked.error) return ranked;

    var top = ranked.candidates.length ? ranked.candidates[0] : null;
    var direct = ranked.direct;
    if (!top) {
      // No flyby beat (or even matched) direct in this window.
      return {
        flybyBody: null,
        launch_vinf_kms: null,
        arrive_vinf_kms: null,
        total_cost_kms: null,
        transfer1_days: null,
        transfer2_days: null,
        vs_direct_kms: direct ? direct.total_cost_kms : null,
        saved_kms: 0,
        direct: direct,
        candidates: ranked.candidates,
        note: "No gravity-assist option beats the direct route in this window."
      };
    }
    return {
      flybyBody: top.flybyBody,
      launch_vinf_kms: top.launch_vinf_kms,
      arrive_vinf_kms: top.arrive_vinf_kms,
      total_cost_kms: top.total_cost_kms,
      transfer1_days: top.transfer1_days,
      transfer2_days: top.transfer2_days,
      vs_direct_kms: direct ? direct.total_cost_kms : null,
      saved_kms: top.saved_kms,
      launchMs: top.launchMs,
      flybyMs: top.flybyMs,
      arriveMs: top.arriveMs,
      note: top.note,
      direct: direct,
      candidates: ranked.candidates
    };
  }

  // ---- PUBLIC: rankFlybys --------------------------------------------------
  // Scan every body in `bodies` as a flyby candidate; return the full list
  // (every candidate that produced a finite trajectory) sorted by Δv saved vs
  // the direct route, descending.  Shape:
  //   { direct: {…} | null, candidates: [ {
  //       flybyBody, a, launch_vinf_kms, arrive_vinf_kms, total_cost_kms,
  //       transfer1_days, transfer2_days, saved_kms, beatsDirect,
  //       launchMs, flybyMs, arriveMs, note
  //     }, … ] }
  // opts: { windowYears (default 10), epochMs, topN (limit list; default all),
  //         helpfulOnly (default false — set true to keep only saved_kms>0),
  //         maxStepsPerDim (default 200; lower for speed — e.g. 70 is ~sub-second
  //           per scan with the same top flybys), launchStepDays (default 15),
  //         maxLegDays (default unbounded = wiki; see bestTrajectory caution —
  //           do NOT tie it to the window). }
  // For an interactive UI: planets+Sun pool + maxStepsPerDim ~70. For the full
  // 62-body pool, also run inside a setTimeout chunk loop (yield per candidate).
  function rankFlybys(originName, targetName, bodies, depDateMs, opts) {
    var o = opts || {};
    var origin = resolveBody(originName, bodies);
    var target = resolveBody(targetName, bodies);
    if (!origin || !target) return { error: "Unknown origin or target body." };
    if (origin === target || origin.name === target.name) {
      return { error: "Origin and target must be different bodies." };
    }
    if (!isFinitePositive(origin.a) || !isFinitePositive(target.a)) {
      return { error: "Origin and target both need a heliocentric semi-major axis (a)." };
    }
    var pool = bodies || [];
    var w = windowFromDep(depDateMs, o);

    var direct = bestDirect({
      earth: origin, target: target,
      fromDateMs: w.fromMs, toDateMs: w.toMs, epochMs: w.epoch
    });
    var directKms = direct ? direct.totalDvKms : null;

    var rows = [];
    for (var i = 0; i < pool.length; i++) {
      var b = pool[i];
      if (!b) continue;
      if (b === origin || b === target) continue;
      if (b.name && (b.name === origin.name || b.name === target.name)) continue;
      // A flyby body must be positionable: either a>0, or the Sun (a<=0) which
      // the optimizer models specially.  Bodies with no `a` field are skipped.
      if (typeof b.a !== "number") continue;
      var ga = bestTrajectory({
        earth: origin, flybyBody: b, target: target,
        fromDateMs: w.fromMs, toDateMs: w.toMs, epochMs: w.epoch,
        maxLegDays: o.maxLegDays,
        maxStepsPerDim: o.maxStepsPerDim,
        launchStepDays: o.launchStepDays
      });
      if (!ga || !isFinite(ga.totalDvKms)) continue;
      var saved = (directKms != null) ? directKms - ga.totalDvKms : 0;
      rows.push({
        flybyBody: b.name || null,
        a: b.a,
        launch_vinf_kms: ga.vInfLaunchKms,
        arrive_vinf_kms: ga.vInfArriveKms,
        total_cost_kms: ga.totalDvKms,
        transfer1_days: (ga.flybyMs - ga.launchMs) / DAY_MS,
        transfer2_days: (ga.arriveMs - ga.flybyMs) / DAY_MS,
        saved_kms: saved,
        beatsDirect: saved > 0,
        launchMs: ga.launchMs,
        flybyMs: ga.flybyMs,
        arriveMs: ga.arriveMs,
        note: flybyNote(b)
      });
    }
    rows.sort(function (a, b) { return b.saved_kms - a.saved_kms; });
    if (o.helpfulOnly) rows = rows.filter(function (r) { return r.saved_kms > 0; });
    if (isFinitePositive(o.topN)) rows = rows.slice(0, o.topN);

    return {
      direct: direct ? {
        total_cost_kms: direct.totalDvKms,
        launch_vinf_kms: direct.vInfLaunchKms,
        arrive_vinf_kms: direct.vInfArriveKms,
        transfer_days: (direct.arriveMs - direct.launchMs) / DAY_MS,
        launchMs: direct.launchMs,
        arriveMs: direct.arriveMs
      } : null,
      candidates: rows
    };
  }

  // ---- export --------------------------------------------------------------
  var API = {
    // constants
    MU: MU,
    AU_km: AU_km,
    YEAR_DAYS: YEAR_DAYS,
    AU_PER_YR_TO_KM_S: AU_PER_YR_TO_KM_S,
    EPOCH_MS: EPOCH_MS,
    // public high-level
    bestFlyby: bestFlyby,
    rankFlybys: rankFlybys,
    // lower-level pure functions (reuse / tests)
    positionAt: positionAt,
    lambert: lambert,
    stumpffC: stumpffC,
    stumpffS: stumpffS,
    bestTrajectory: bestTrajectory,
    bestDirect: bestDirect,
    flybyNote: flybyNote,
    resolveBody: resolveBody
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.GravityAssist = API;
})(typeof self !== "undefined" ? self : this);
