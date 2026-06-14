/* terraform_sim.js — Solar Expanse climate simulator (game-faithful port)
 *
 * Ported from lazyranma's SETerraformingSimulator
 * (https://lazyranma.github.io/SETerraformingSimulator/), which is itself a
 * faithful reimplementation of the game's decompiled Assembly-CSharp.dll
 * HabitabilityParametersNew code. Constants, curves and the per-tick update
 * order are reproduced exactly; only the DOM/UI layer was stripped.
 *
 * Self-contained ES5. No DOM. Exposes window.TerraSim in the browser and
 * module.exports under CommonJS. Pure functions only.
 *
 * Physics summary (all SI unless noted):
 *   - Equilibrium temp via Stefan-Boltzmann: T = (absorbed/(4σ))^¼, where
 *     absorbed = L(1+mirrors)(1-shades)/(4π d²) · (1-albedo); floored by
 *     internalFlux/(4σ). Greenhouse multiplies T_eq by (1+0.75·ε·P)^¼ with
 *     emissivity ε = 1-e^(-τ) and optical depth τ from gas column × optDepth.
 *   - Pressure from atmospheric mass: P = K · M_atm^(1/gasScaling),
 *     K = 1000·g / surface / 101325.
 *   - Phase split (gas/liquid/solid) per resource via Clausius-Clapeyron
 *     saturation pressure p_sat = EARTH_PRESSURE · e^(-hvap/R · (1/T - 1/Tboil)).
 *   - The model is TIME-ITERATED. Temperature, heat capacity, day/night swing
 *     and deposit phases co-evolve each tick until they converge. Use
 *     equilibrium()/simulate() to run to convergence, or step()/createState()
 *     to drive it one tick at a time.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.TerraSim = api;
})(this, function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────────────────
  // CONSTANTS (from decompiled Assembly-CSharp.dll)
  // ─────────────────────────────────────────────────────────────────────────
  var C = {
    G: 6.67e-11,            // Gravitational constant
    SIGMA: 5.67e-8,         // Stefan-Boltzmann (W/m²/K⁴)
    AU_TO_M: 1.4959786e11,  // MyMathf.Au
    SOLAR_FLUX: 3.828e26,   // solarFlux (W) — Sun luminosity
    STAR_LUM: 1.0,          // star luminosity (1.0 = our Sun)
    GAS_SCALING: 0.448,     // TerraformationConfig gasScaling
    R_GAS: 8.314,           // Universal gas constant (J/mol/K)
    EARTH_PRESSURE: 1.0,    // reference pressure for Clausius-Clapeyron (atm)
    WATER_SCALING: 2.52,    // ParameterSettingsWater.waterScaling
    OCEAN_DEPTH: 3911.0,    // ObjectInfo.oceanDepth (m)
    SURF_WATER_COV: 0.7,    // surfaceWaterCoverage
    EARTH_OC_WEIGHT: 1.4e18,// earthOceanWeight (tonnes reference)
    MIRROR_PARAM: 0.216,    // build_terraform_space_mirror specialAbilityParameter
    SHADE_PARAM: 0.006,     // |build_terraform_space_shade specialAbilityParameter|
    DIST_PARAM: 1.0,        // strengthParameterFromDistanceToTarget
    NORMAL_HEAT_DEPTH: 0.2, // normalHeatDepth
    ATM_PERCENTAGE: 0.01,   // atmospherePercentage
    WATER_HC_PARAM: 4186000,// waterHeatCapacityParameter
    MIN_SURF_COV: 1e-8,     // minSurfaceCoverage
    EARTH_TEMP_SWING: 50.0, // earthTemperatureSwing (K)
    GRAV_THRESHOLD: 0.08,   // gravityLowerThreshold (m/s²) — below = not terraformable
    SAT_MAX_CHANGE: 0.1,    // saturationMaxChange (per-tick fractional clamp)
    HC_ROCK_BASE: 200000.0, // heatCapacityRockBase
    MIN_KELWIN: -273.15,    // Celsius↔Kelvin offset (game's "minKelwin")
    PRESSURE_SCALING: 1.0   // pressureScalingParameter
  };

  var TICK = { PREWARM: 15, MIN_CONVERGE: 20, BATCH: 150, MAX: 1000 };

  // ─────────────────────────────────────────────────────────────────────────
  // HERMITE SPLINE EVALUATOR — matches Unity AnimationCurve.Evaluate()
  // ─────────────────────────────────────────────────────────────────────────
  function evalAnimCurve(curve, x) {
    var n = curve.length, i;
    if (n === 0) return 0;
    if (n === 1) return curve[0].value;
    if (x <= curve[0].time) return curve[0].value;
    if (x >= curve[n - 1].time) return curve[n - 1].value;
    i = 0;
    while (i < n - 2 && x > curve[i + 1].time) i++;
    var k0 = curve[i], k1 = curve[i + 1];
    var dt = k1.time - k0.time;
    if (dt <= 0) return k0.value;
    var t = (x - k0.time) / dt, t2 = t * t, t3 = t2 * t;
    var h00 = 2 * t3 - 3 * t2 + 1;
    var h10 = t3 - 2 * t2 + t;
    var h01 = -2 * t3 + 3 * t2;
    var h11 = t3 - t2;
    var m0 = isFinite(k0.outTangent) ? k0.outTangent : 0;
    var m1 = isFinite(k1.inTangent) ? k1.inTangent : 0;
    return h00 * k0.value + h10 * dt * m0 + h01 * k1.value + h11 * dt * m1;
  }

  var INF = Infinity;

  // ─────────────────────────────────────────────────────────────────────────
  // HABITABILITY CURVES — exact Unity AnimationCurve keyframes
  // (runtime-extracted via BepInEx). Habitability axes are weighted; the
  // game's final score is a weighted mean of axis scores plus planet-
  // characteristic modifiers.
  // ─────────────────────────────────────────────────────────────────────────
  var HAB = {
    parameters: {
      temperature: { weight: 6, keys: [
        { time: -273, value: 0, inTangent: 0.34965, outTangent: 0.34965 },
        { time: 13, value: 100, inTangent: 0, outTangent: 0 },
        { time: 100, value: 0, inTangent: -0.50974, outTangent: -0.50974 },
        { time: 700, value: -100, inTangent: -0.06330, outTangent: -0.06330 }
      ] },
      composition: { weight: 5, keys: [
        { time: 0, value: 0, inTangent: 703.0485, outTangent: 703.0485 },
        { time: 0.2, value: 100, inTangent: -92.1511, outTangent: -92.1511 },
        { time: 1.3, value: -100, inTangent: -447.689, outTangent: INF }
      ] },
      pressure: { weight: 1, keys: [
        { time: 0, value: 0, inTangent: 100, outTangent: 100 },
        { time: 1, value: 100, inTangent: -4.7833, outTangent: -4.7833 },
        { time: 50, value: -100, inTangent: -0.52065, outTangent: -0.52065 }
      ] },
      gravity: { weight: 2, keys: [
        { time: 0, value: 0, inTangent: 28.7461, outTangent: 28.7461 },
        { time: 9.8, value: 100, inTangent: -0.14643, outTangent: -0.14643 },
        { time: 16.277, value: 90.68, inTangent: -4.6699, outTangent: -4.6699 },
        { time: 75, value: -100, inTangent: 0.14697, outTangent: 0.14697 }
      ] },
      water: { weight: 1, keys: [
        { time: 0, value: 0, inTangent: 76.8674, outTangent: 76.8674 },
        { time: 1, value: 100, inTangent: 0.23779, outTangent: 0.23779 },
        { time: 2, value: -100, inTangent: -3.6500, outTangent: -3.6500 }
      ] },
      magnetosphere: { weight: 1, keys: [
        { time: 0, value: 100, inTangent: INF, outTangent: INF },
        { time: 1, value: 100, inTangent: -5.2196, outTangent: -5.2196 },
        { time: 100, value: -100, inTangent: -0.95948, outTangent: -0.95948 }
      ] }
    },
    planetCharacteristics: {
      extremeVolcanism: { keys: [
        { time: 0, value: 1, inTangent: 0, outTangent: 0 },
        { time: 0.1, value: 1, inTangent: 0, outTangent: -1.9226 },
        { time: 1, value: 0, inTangent: -0.59544, outTangent: 1 }
      ] },
      environmentalToxicity: { keys: [
        { time: 0, value: 1, inTangent: 0, outTangent: 0 },
        { time: 0.15, value: 1, inTangent: 0, outTangent: -1.0370 },
        { time: 1, value: 0.5, inTangent: -0.086258, outTangent: -0.086258 }
      ] }
    },
    supplyMod: { keys: [
      { time: -100, value: 4, inTangent: -0.002717, outTangent: -0.002717 },
      { time: 0, value: 2, inTangent: -0.02773, outTangent: -0.02773 },
      { time: 100, value: 0.01, inTangent: -0.000704, outTangent: -0.000704 }
    ] },
    resourceToxicity: {
      co2: { keys: [
        { time: 0.005, value: 0, inTangent: 1.1696, outTangent: 0.08157 },
        { time: 0.86, value: 1, inTangent: 0.03969, outTangent: 5.1768 }
      ] },
      oxygen: { keys: [
        { time: 0.23, value: 0, inTangent: 0.15455, outTangent: 0.15455 },
        { time: 1, value: 1, inTangent: 0.16090, outTangent: 0.16090 }
      ] },
      fuel: { keys: [
        { time: 0.01, value: 0, inTangent: 0.10517, outTangent: 0.10517 },
        { time: 1, value: 1, inTangent: 0.24525, outTangent: 0.24525 }
      ] },
      hydrogen: { keys: [
        { time: 0.01, value: -0.006256, inTangent: 0.08375, outTangent: 0.08375 },
        { time: 1, value: 1, inTangent: 0.13358, outTangent: 0.13358 }
      ] },
      uran: { keys: [
        { time: 0, value: 1, inTangent: 0, outTangent: 0 },
        { time: 0.05, value: 1, inTangent: 0, outTangent: -2.9750 },
        { time: 1, value: 0, inTangent: -0.10788, outTangent: 0 }
      ] }
    }
  };
  var RESOURCE_TO_TOXICITY = { co2: "co2", oxygen: "oxygen", fuel: "fuel", hydrogen: "hydrogen", uran: "uran" };

  // ─────────────────────────────────────────────────────────────────────────
  // MIRROR ORBIT DEFINITIONS (solar-orbit distance hardcoded to 0.01 AU)
  // ─────────────────────────────────────────────────────────────────────────
  var MIRROR_ORBITS = [
    { name: "Solar", au: 0.01 },
    { name: "Mercury", au: 0.387099 },
    { name: "Venus", au: 0.723336 },
    { name: "Earth", au: 1.000001 },
    { name: "Mars", au: 1.52371 }
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // RESOURCE THERMAL DATA (from sharedassets0.assets)
  // tBoil/tMelt in Kelvin, pTriple in atm, hvap in J/mol, optDepth dimensionless
  // ─────────────────────────────────────────────────────────────────────────
  var RESOURCES = [
    { id: "nitrogen",  name: "Nitrogen",       optDepth: 1e-6,   heatCap: 1040,  hvap: 5560,   tBoil: 77,   tMelt: 63,   pTriple: 0.123 },
    { id: "oxygen",    name: "Oxygen",         optDepth: 1e-6,   heatCap: 918,   hvap: 6820,   tBoil: 90,   tMelt: 54,   pTriple: 0.15 },
    { id: "co2",       name: "Carbon Dioxide", optDepth: 0.04,   heatCap: 844,   hvap: 25200,  tBoil: 217,  tMelt: 216,  pTriple: 5.11 },
    { id: "noblegas",  name: "Noble",          optDepth: 1.0,    heatCap: 312,   hvap: 6430,   tBoil: 87,   tMelt: 83,   pTriple: 0.681 },
    { id: "water",     name: "Water",          optDepth: 0.002,  heatCap: 1860,  hvap: 50000,  tBoil: 373,  tMelt: 220,  pTriple: 0.0061 },
    { id: "he3",       name: "Helium-3",       optDepth: 0.0001, heatCap: 1,     hvap: 26,     tBoil: 3.2,  tMelt: 0.3,  pTriple: 0.001 },
    { id: "hydrogen",  name: "Hydrogen",       optDepth: 0.0001, heatCap: 14320, hvap: 449,    tBoil: 20,   tMelt: 14,   pTriple: 0.0695 },
    { id: "fuel",      name: "Fuel",           optDepth: 0.0001, heatCap: 1000,  hvap: 8190,   tBoil: 88,   tMelt: 65,   pTriple: 0.15 },
    { id: "metal",     name: "Metal",          optDepth: 1.0,    heatCap: 460,   hvap: 340000, tBoil: 3135, tMelt: 1811, pTriple: 0 },
    { id: "raremetal", name: "Rare Metal",     optDepth: 1.0,    heatCap: 129,   hvap: 342000, tBoil: 3130, tMelt: 1337, pTriple: 1.0 },
    { id: "volatile",  name: "Carbon",         optDepth: 1.0,    heatCap: 710,   hvap: 710000, tBoil: 4188, tMelt: 3925, pTriple: 0.99 },
    { id: "silicon",   name: "Silicon",        optDepth: 1.0,    heatCap: 705,   hvap: 359000, tBoil: 3538, tMelt: 1687, pTriple: 0 },
    { id: "uran",      name: "Fissiles",       optDepth: 1.0,    heatCap: 116,   hvap: 417000, tBoil: 4404, tMelt: 1405, pTriple: 0 }
  ];
  var RES_BY_ID = {};
  for (var ri = 0; ri < RESOURCES.length; ri++) RES_BY_ID[RESOURCES[ri].id] = RESOURCES[ri];

  // ─────────────────────────────────────────────────────────────────────────
  // PLANET DATA (parsed from planet_parameters.csv)
  // NOTE: the CSV "radiusKm" column actually holds metres (Earth = 6378140).
  // gravity=0 in the CSV is a sentinel meaning "derive from G·M/r²".
  // ─────────────────────────────────────────────────────────────────────────
  var CSV_DATA =
"id,name,objectType,gravity,albedo,internalFlux,heatCapacityRock,water,radiation,magneticFieldVisualization,cryoVolcanism,hydroCarbonLakes,radiusKm,mass1E24,rotationPeriod,distanceAU,oceanDepth\n" +
"0,SUN,Other,274,0,0,0,0,100000,100000,1,1,45383.51953125,1989000,1,1,3911\n" +
"8,PLUTO,Planet,0,0.72,0.08,50000,0,1.5,2.5,1,1,1188000,0.0138999996706843,6.375,39.482120513916,3911\n" +
"10,MERCURY,Planet,0,0.09,0.08,200000,0,30,15,1,1,2439700,0.330099999904633,58,0.387099295854568,3911\n" +
"24,VENUS,Planet,0,0.76,0.08,200000,0,0,10,1,1,6051800,4.86700010299683,121.499977111816,0.723335683345795,3911\n" +
"56,JUPITER,Planet,0,0.34,0.5,200000,0,1500,1000,1,1,71492000,1898.09997558594,0.416666686534882,5.20288705825806,3911\n" +
"59,MARS,Planet,0,0.25,0.08,50000,0,10,10,1,1,3396190,0.641600012779236,1.02083349227905,1.52371001243591,3911\n" +
"66,EARTH,Planet,0,0.29,0.08,200000,0,1,40,1,1,6378140,5.97200012207031,0.999999940395355,1.00000095367432,3911\n" +
"68,NEPTUNE,Planet,0,0.29,0.08,50000,0,7200,60,1,1,24622000,102.400001525879,0.666666686534882,30.0699195861816,3911\n" +
"73,SATURN,Planet,0,0.34,0.5,200000,0,900,500,1,1,60288000,568.340026855469,0.437499970197678,9.53667640686035,3911\n" +
"74,URANUS,Planet,0,0.3,0.5,50000,0,7000,80,1,1,25362000,86.8099975585938,0.708333313465118,19.1891708374023,3911\n" +
"86,1 CERES,Asteroid,0,0.04,0.08,50000,0,5,2.5,1,1,455000,0.000937999982852489,0.375,2.76797246932983,3911\n" +
"87,LUNA,Moons,0,0.11,0.01,50000,0,12,2.5,1,1,1737400,0.0734200030565262,1,1.00000095367432,3911\n" +
"91,IO,Moons,0,0.63,0.4,200000,0,1000,2.5,1,1,1821500,0.0892999991774559,1,5.20288705825806,3911\n" +
"92,EUROPA,Moons,0,0.67,0.08,200000,0,150,2.5,1,1,1561000,0.0480000004172325,1,5.20288705825806,3911\n" +
"93,GANYMEDE,Moons,0,0.43,0.08,200000,0,30,25,1,1,2631000,0.148100003600121,1,5.20288705825806,3911\n" +
"94,CALLISTO,Moons,0,0.2,0.08,50000,0,15,2.5,1,1,2410500,0.107500001788139,1,5.20288705825806,3911\n" +
"97,RHEA,Moons,0,0.95,0.08,50000,0,10,2.5,1,1,763500,0.00230000005103648,1,9.53667640686035,3911\n" +
"98,TITAN,Moons,0,0.21,0.08,50000,0,1,2.5,1,1,2574500,0.134499996900558,1,9.53667640686035,3911\n" +
"99,DIONE,Moons,0,0.7,0.08,50000,0,12,2.5,1,1,564000,0.00109000003430992,1,9.53667640686035,3911\n" +
"100,TETHYS,Moons,0,0.8,0.08,50000,0,12,2.5,1,1,531000,0.000600000028498471,1,9.53667640686035,3911\n" +
"101,ENCELADUS,Moons,0,0.9,0.08,50000,0,12,2.5,1,1,252000,0.000108000000182074,1,9.53667640686035,3911\n" +
"106,TITANIA,Moons,0,0.35,0.08,50000,0,1.5,2.5,1,1,788000,0.00340000004507601,1,19.1891708374023,3911\n" +
"107,OBERON,Moons,0,0.31,0.08,50000,0,1.5,2.5,1,1,761000,0.00300000002607703,1,19.1891708374023,3911\n" +
"108,UMBRIEL,Moons,0,0.26,0.08,50000,0,1.5,2.5,1,1,584500,0.00120000005699694,1,19.1891708374023,3911\n" +
"109,ARIEL,Moons,0,0.53,0.08,50000,0,1.5,2.5,1,1,578500,0.00120000005699694,1,19.1891708374023,3911\n" +
"113,TRITON,Moons,0,0.9,0.08,50000,0,1.5,2.5,1,1,1353000,0.0214000009000301,1,30.0699195861816,3911\n" +
"116,CHARON,Moons,0,0.41,0.08,50000,0,1.5,2.5,1,1,606000,0.00150000001303852,1,39.482120513916,3911\n" +
"229,IAPETUS,Moons,0,0.2,0.08,50000,0,1.5,2.5,1,1,735000,0.00179999996908009,1,9.53667640686035,3911\n";

  function parseCSV(csv) {
    var lines = csv.replace(/\s+$/, "").split("\n");
    var headers = lines[0].split(",");
    var out = [], i, j;
    for (i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      var vals = lines[i].split(","), obj = {};
      for (j = 0; j < headers.length; j++) {
        var v = vals[j];
        obj[headers[j]] = (v === "" || v == null || isNaN(v)) ? v : Number(v);
      }
      out.push(obj);
    }
    return out;
  }

  var ALL_PLANETS = parseCSV(CSV_DATA);
  var PLANETS_BY_NAME = {};
  for (var pi = 0; pi < ALL_PLANETS.length; pi++) {
    var p = ALL_PLANETS[pi];
    // Derived gravity for bodies where gravity column is 0 (sentinel).
    if (p.gravity === 0) {
      var mass = p.mass1E24 * 1e24, radius = p.radiusKm; // radiusKm column is metres
      p.computedGravity = (radius > 0 && mass > 0) ? (C.G * mass) / (radius * radius) : 0;
    } else {
      p.computedGravity = p.gravity;
    }
    p.surface = 4 * Math.PI * p.radiusKm * p.radiusKm; // m²
    PLANETS_BY_NAME[p.name.toUpperCase()] = p;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BODY NORMALISATION
  // Accepts either a CSV planet object, a body name string, or a hub gamedata
  // body { name, mass_e24kg, radius_km, semi_major_au, ... } optionally with
  // physics overrides. Returns the internal planet shape used by simulate():
  //   { name, albedo, internalFlux, heatCapacityRock, radiation, cryoVolcanism,
  //     hydroCarbonLakes, radiusKm(metres), mass1E24, rotationPeriod,
  //     distanceAU, computedGravity, surface }
  // ─────────────────────────────────────────────────────────────────────────
  function normalizeBody(body) {
    if (body == null) throw new Error("normalizeBody: body is required");
    if (typeof body === "string") {
      var found = PLANETS_BY_NAME[body.toUpperCase()];
      if (!found) throw new Error("Unknown body name: " + body);
      return found;
    }
    // Already an internal CSV planet (has computedGravity/surface)?
    if (body.computedGravity !== undefined && body.surface !== undefined && body.radiusKm !== undefined) {
      return body;
    }

    // Try to seed defaults from a matching CSV body (albedo/internalFlux/etc.
    // only exist in the CSV — the hub gamedata lacks them).
    var src = body.name ? PLANETS_BY_NAME[String(body.name).toUpperCase()] : null;

    function pick() {
      for (var k = 0; k < arguments.length; k++) {
        if (arguments[k] !== undefined && arguments[k] !== null && !(typeof arguments[k] === "number" && isNaN(arguments[k]))) {
          return arguments[k];
        }
      }
      return undefined;
    }

    // Radius: hub provides radius_km (kilometres). The sim wants metres.
    var radiusM = pick(
      body.radiusKm,
      body.radius_km != null ? body.radius_km * 1000 : undefined,
      src ? src.radiusKm : undefined
    );
    var mass1E24 = pick(body.mass1E24, body.mass_e24kg, src ? src.mass1E24 : undefined);
    var distanceAU = pick(body.distanceAU, body.semi_major_au, src ? src.distanceAU : undefined);
    var albedo = pick(body.albedo, src ? src.albedo : undefined, 0.3);
    var internalFlux = pick(body.internalFlux, src ? src.internalFlux : undefined, 0.08);
    var heatCapacityRock = pick(body.heatCapacityRock, src ? src.heatCapacityRock : undefined, 200000);
    var radiation = pick(body.radiation, src ? src.radiation : undefined, 0);
    var rotationPeriod = pick(body.rotationPeriod, src ? src.rotationPeriod : undefined, 1);
    var cryoVolcanism = pick(body.cryoVolcanism, src ? src.cryoVolcanism : undefined, 1.0);
    var hydroCarbonLakes = pick(body.hydroCarbonLakes, src ? src.hydroCarbonLakes : undefined, 1.0);

    var gravity = body.gravity;
    var computedGravity;
    if (gravity !== undefined && gravity !== null && gravity !== 0 && !isNaN(gravity)) {
      computedGravity = gravity;
    } else if (radiusM && mass1E24) {
      computedGravity = (C.G * mass1E24 * 1e24) / (radiusM * radiusM);
    } else {
      computedGravity = 0;
    }

    return {
      name: body.name || "Custom",
      albedo: albedo,
      internalFlux: internalFlux,
      heatCapacityRock: heatCapacityRock,
      radiation: radiation,
      cryoVolcanism: cryoVolcanism,
      hydroCarbonLakes: hydroCarbonLakes,
      radiusKm: radiusM,          // metres, per CSV convention
      mass1E24: mass1E24,
      rotationPeriod: rotationPeriod,
      distanceAU: distanceAU,
      computedGravity: computedGravity,
      surface: 4 * Math.PI * radiusM * radiusM
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INTERVENTION → MIRROR/SHADE STRENGTH HELPERS
  // ─────────────────────────────────────────────────────────────────────────
  function mirrorCountsFromInterventions(interventions) {
    // interventions.mirrors may be a number (placed in the body's own orbit) or
    // an array/object aligned to MIRROR_ORBITS. Returns length-5 array.
    var counts = [0, 0, 0, 0, 0];
    if (!interventions) return counts;
    var m = interventions.mirrors;
    if (m == null) return counts;
    if (typeof m === "number") {
      // Default: same-orbit mirrors (most efficient) → index by closest orbit.
      counts[3] = m; // Earth orbit slot is the canonical "1 AU" reference, but
      // for a same-orbit interpretation we instead let simulate handle dDiff=1.
      // We expose mirrorOrbitIndex to override which slot to fill.
      var idx = interventions.mirrorOrbitIndex;
      if (idx != null && idx >= 0 && idx < 5) { counts = [0, 0, 0, 0, 0]; counts[idx] = m; }
      return counts;
    }
    if (Object.prototype.toString.call(m) === "[object Array]") {
      for (var i = 0; i < 5 && i < m.length; i++) counts[i] = m[i] || 0;
    } else if (typeof m === "object") {
      for (var k = 0; k < MIRROR_ORBITS.length; k++) {
        var nm = MIRROR_ORBITS[k].name;
        if (m[nm] != null) counts[k] = m[nm];
      }
    }
    return counts;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CORE: build an initial mutable state, then advance one tick at a time.
  // simulate() = createState + repeated step() until convergence.
  // ─────────────────────────────────────────────────────────────────────────
  function createState(planetLike, mirrorCounts, shadeCount, resourceKt, effectiveDistAU, options) {
    var planet = normalizeBody(planetLike);
    options = options || {};

    var g = planet.computedGravity;
    if (g < C.GRAV_THRESHOLD) {
      return {
        error: "Gravity " + g.toFixed(4) + " m/s² is below game threshold (" +
          C.GRAV_THRESHOLD + " m/s²). Body cannot be terraformed.",
        planet: planet, gravity: g
      };
    }

    var surface = planet.surface;
    var distAU = (effectiveDistAU !== undefined && effectiveDistAU !== null) ? effectiveDistAU : planet.distanceAU;
    var distM = distAU * C.AU_TO_M;

    // Mirror & shade strengths.
    // GetFinalStrengthForObject: strength = param / (d_mirror² × d_diff²) × count
    var mirrorsStrength = 0;
    for (var oi = 0; oi < MIRROR_ORBITS.length; oi++) {
      var count = (mirrorCounts && mirrorCounts[oi]) || 0;
      if (count <= 0) continue;
      var dM = MIRROR_ORBITS[oi].au, dT = distAU;
      var sameOrbit = Math.abs(dM - dT) < 1e-4;
      var dDiff = sameOrbit ? 1.0 : (dM - dT) / C.DIST_PARAM;
      mirrorsStrength += (C.MIRROR_PARAM / (dM * dM * dDiff * dDiff)) * count;
    }
    var shadesStrength = (shadeCount || 0) * C.SHADE_PARAM;

    var L = C.SOLAR_FLUX * C.STAR_LUM;
    var absorbed = ((L * (1 + mirrorsStrength) * (1 - shadesStrength)) / (4 * Math.PI * distM * distM)) * (1 - planet.albedo);
    var internalFlux = planet.internalFlux;

    var T_eq = Math.pow(Math.max(absorbed / (4 * C.SIGMA), internalFlux / (4 * C.SIGMA)), 0.25);

    // Pressure constant: P = K · M_atm^(1/gasScaling)
    var K_pressure = (1000.0 * g) / surface / 101325.0;

    // Deposit state from user gas/liquid/solid inputs (kt → tonnes).
    var resourceKtIn = resourceKt || {};
    var gasKt = options.gasKt || {};
    var liqKt = options.liqKt || {};
    var deposits = {};
    for (var di = 0; di < RESOURCES.length; di++) {
      var r0 = RESOURCES[di];
      var gMass = (gasKt[r0.id] || 0) * 1000;
      var lMass = (liqKt[r0.id] || 0) * 1000;
      var sMass = Math.max(0, (resourceKtIn[r0.id] || 0) * 1000);
      var tot = gMass + lMass + sMass;
      deposits[r0.id] = { gas: gMass, liquid: lMass, solid: sMass, total: tot };
    }

    var st = {
      planet: planet, g: g, surface: surface, distAU: distAU, distM: distM,
      mirrorsStrength: mirrorsStrength, shadesStrength: shadesStrength,
      absorbed: absorbed, internalFlux: internalFlux, T_eq: T_eq, K_pressure: K_pressure,
      deposits: deposits,
      temperatureWithAtmOld: null,
      totalHC: 0, prevHC: 0, satPressOld: {},
      pressure: 0, temperatureC: 0, temperatureK: 0, swings: 0, tau: 0, emissivity: 0,
      tick: 0, lastTick: 0, converged: false,
      prevGasFracs: {}, prevPvaps: {}, stableCount: 0,
      maxTicks: (options.maxTicks != null ? options.maxTicks : TICK.MAX),
      noConverge: !!options.noConverge,
      options: options, error: null
    };

    // Cold-start for liquid-rich initial state (matches a game save with
    // pre-existing oceans so tick 0 doesn't flash-vaporise them).
    var liquidWaterInit = deposits.water ? deposits.water.liquid : 0;
    if (liquidWaterInit > 0) {
      var whd = Math.min(C.NORMAL_HEAT_DEPTH,
        (Math.pow(liquidWaterInit, C.WATER_SCALING) * 1000.0 + surface * C.MIN_SURF_COV) / surface);
      var hcOcean0 = C.WATER_HC_PARAM * whd * C.SURF_WATER_COV;
      st.totalHC = planet.heatCapacityRock + hcOcean0;
      st.swings = C.EARTH_TEMP_SWING * Math.sqrt(planet.rotationPeriod) *
        Math.pow(distAU, -0.5) * Math.sqrt(C.HC_ROCK_BASE / st.totalHC);
      st.temperatureK = T_eq;
      st.temperatureC = T_eq + C.MIN_KELWIN;
      st.temperatureWithAtmOld = T_eq;
    }

    // Seed satPressOld for non-empty deposits (prevents first-tick collapse).
    var absorbedUnshaded = ((L * (1 + mirrorsStrength)) / (4 * Math.PI * distM * distM)) * (1 - planet.albedo);
    var T_eq_unshaded = Math.pow(Math.max(absorbedUnshaded / (4 * C.SIGMA), internalFlux / (4 * C.SIGMA)), 0.25);
    var T_hot_seed = (st.temperatureK || T_eq_unshaded) + (st.swings || 50);
    for (var si = 0; si < RESOURCES.length; si++) {
      var rs = RESOURCES[si], dd = deposits[rs.id];
      if (!dd || dd.total <= 0 || !rs.hvap || !rs.tBoil) continue;
      if (st.satPressOld[rs.id] !== undefined) continue;
      var ccSeed = (-rs.hvap / C.R_GAS) * (1.0 / T_hot_seed - 1.0 / rs.tBoil);
      var psatSeed = C.EARTH_PRESSURE * Math.exp(ccSeed);
      if (isFinite(psatSeed) && psatSeed > 0) st.satPressOld[rs.id] = psatSeed;
    }

    return st;
  }

  function isPreWarm(tick) { return tick < TICK.PREWARM; }

  // Advance the simulation by one tick (mutates and returns state).
  // Mirrors the game's per-frame update order: pressure → temperature →
  // heat capacity → swing → deposit phase split → convergence check.
  function step(st) {
    if (st.error) return st;
    if (st.converged) return st;
    var planet = st.planet, g = st.g, surface = st.surface, distAU = st.distAU;
    var tick = st.tick;
    st.lastTick = tick + 1;
    var i;

    // 1. UpdatePressure — gas-phase deposits only.
    var currentAtmMass = 0, gasAmts = {};
    for (i = 0; i < RESOURCES.length; i++) {
      var rid = RESOURCES[i].id;
      var ga = st.deposits[rid] ? st.deposits[rid].gas : 0;
      gasAmts[rid] = ga; currentAtmMass += ga;
    }
    st.pressure = currentAtmMass > 0 ? st.K_pressure * Math.pow(currentAtmMass, 1.0 / C.GAS_SCALING) : 0;

    // 2. UpdateTemperature — optical depth → emissivity → greenhouse + Newton.
    var tau = 0;
    if (currentAtmMass > 0 && st.pressure > 0) {
      var columnMass = (st.pressure * 101325.0) / g;
      for (i = 0; i < RESOURCES.length; i++) {
        var r2 = RESOURCES[i];
        if (gasAmts[r2.id] > 0 && r2.optDepth > 0) {
          tau += columnMass * (gasAmts[r2.id] / currentAtmMass) * r2.optDepth;
        }
      }
    }
    st.tau = tau;
    var emissivity = 1 - Math.exp(-tau);
    st.emissivity = emissivity;

    var newtonAnchor = isPreWarm(tick)
      ? (st.temperatureWithAtmOld !== null ? st.temperatureWithAtmOld : st.T_eq)
      : st.T_eq;
    var x = newtonAnchor > 1e-6 ? newtonAnchor : st.T_eq;
    var num8 = (st.absorbed / 4 - (emissivity * C.SIGMA * Math.pow(x, 4) + st.internalFlux)) / (4 * C.SIGMA * Math.pow(x, 3));
    var T_gh = st.T_eq * Math.pow(1 + 0.75 * emissivity * Math.pow(st.pressure, C.PRESSURE_SCALING), 0.25);
    var b = T_gh + num8;
    b = Math.max(0, b);
    var prevTempK = st.temperatureK;
    if (isPreWarm(tick)) st.temperatureWithAtmOld = b;
    st.temperatureK = b;
    st.temperatureC = b + C.MIN_KELWIN;

    // 3. UpdateTotalHeatCapacity.
    var liquidWater = st.deposits.water ? st.deposits.water.liquid : 0;
    var waterHeatDepth = Math.min(C.NORMAL_HEAT_DEPTH,
      (Math.pow(liquidWater, C.WATER_SCALING) * 1000.0 + surface * C.MIN_SURF_COV) / surface);
    var hcOcean = C.WATER_HC_PARAM * waterHeatDepth * C.SURF_WATER_COV;
    var hcAtm = 0;
    if (currentAtmMass > 0 && st.pressure > 0) {
      for (i = 0; i < RESOURCES.length; i++) {
        var r3 = RESOURCES[i];
        if (gasAmts[r3.id] > 0) {
          hcAtm += r3.heatCap * (gasAmts[r3.id] / currentAtmMass) * st.pressure * 101325.0;
        }
      }
      hcAtm = (hcAtm / g) * C.ATM_PERCENTAGE;
    }
    var newTotalHC = planet.heatCapacityRock + hcOcean + hcAtm;
    st.prevHC = newTotalHC; // forced equal so √(prevHC/totalHC)=1 (steady-state)
    st.totalHC = newTotalHC;

    // 4. UpdateTemperatureSwings.
    if (st.totalHC > 0) {
      st.swings = C.EARTH_TEMP_SWING * Math.sqrt(planet.rotationPeriod) *
        Math.pow(distAU, -0.5) * Math.sqrt(C.HC_ROCK_BASE / st.totalHC);
    } else {
      st.swings = C.EARTH_TEMP_SWING * Math.sqrt(planet.rotationPeriod) * Math.pow(distAU, -0.5);
    }

    // 5. UpdateDepositStates — Clausius-Clapeyron phase split.
    var T_hot = st.temperatureK + st.swings;
    var T_cold = st.temperatureK - st.swings;
    var swingEff = Math.max(st.swings, 1e-6);
    var newDeposits = {};
    for (i = 0; i < RESOURCES.length; i++) {
      var r = RESOURCES[i];
      var total = st.deposits[r.id] ? st.deposits[r.id].total : 0;
      if (total <= 0) { newDeposits[r.id] = { gas: 0, liquid: 0, solid: 0, total: 0, gasFrac: 0, liquidFrac: 0, solidFrac: 0, P_sat: 0, T_boil_act: r.tBoil }; continue; }

      var ccArg = (-r.hvap / C.R_GAS) * (1.0 / T_hot - 1.0 / r.tBoil);
      var P_sat_direct = C.EARTH_PRESSURE * Math.exp(ccArg);
      var P_sat;
      if (st.satPressOld[r.id] !== undefined) {
        var ratio = (isFinite(P_sat_direct) && P_sat_direct > 0)
          ? P_sat_direct / st.satPressOld[r.id]
          : (P_sat_direct <= 0 ? 1 - C.SAT_MAX_CHANGE : 1 + C.SAT_MAX_CHANGE);
        P_sat = st.satPressOld[r.id] * Math.min(1 + C.SAT_MAX_CHANGE, Math.max(ratio, 1 - C.SAT_MAX_CHANGE));
      } else {
        P_sat = (isFinite(P_sat_direct) && P_sat_direct >= 0) ? P_sat_direct : 0;
      }
      if (!isFinite(P_sat) || isNaN(P_sat) || P_sat < 0) P_sat = 0;
      st.satPressOld[r.id] = P_sat > 0 ? P_sat : undefined;

      // Boiling point at current pressure (inverse Clausius-Clapeyron).
      var T_boil_act;
      if (st.pressure <= 0) {
        T_boil_act = r.tBoil;
      } else {
        var inv = 1.0 / r.tBoil - (C.R_GAS / r.hvap) * Math.log(st.pressure / C.EARTH_PRESSURE);
        T_boil_act = inv > 0 ? Math.max(0, 1.0 / inv) : Infinity;
      }

      var gasFrac = Math.min(1, Math.max(0, P_sat));
      var liquidFrac = 0;
      var canBeLiquid = st.pressure >= r.pTriple && T_hot >= r.tMelt && T_cold < T_boil_act && st.pressure >= P_sat;
      if (canBeLiquid) {
        var winMin = Math.max(-1, Math.min(1, (r.tMelt - st.temperatureK) / swingEff));
        var winMax = Math.max(-1, Math.min(1, (T_boil_act - st.temperatureK) / swingEff));
        var liquidAngle = Math.asin(winMax) - Math.asin(winMin);
        liquidFrac = (1 / Math.PI) * liquidAngle + (1 - (gasFrac + (1 / Math.PI) * liquidAngle)) * 0.9;
        liquidFrac = Math.max(0, liquidFrac);
      }
      var solidFrac = 1 - gasFrac - liquidFrac; // game does not clamp

      newDeposits[r.id] = {
        gas: total * gasFrac, liquid: total * liquidFrac, solid: total * solidFrac,
        total: total, gasFrac: gasFrac, liquidFrac: liquidFrac, solidFrac: solidFrac,
        P_sat: P_sat, T_boil_act: T_boil_act
      };
    }
    st.deposits = newDeposits;

    // Convergence: temperature flat AND deposit phases/P_sat stable.
    var maxFracChange = 0, maxPvapChange = 0;
    for (i = 0; i < RESOURCES.length; i++) {
      var rc = RESOURCES[i], dc = st.deposits[rc.id];
      var currFrac = dc ? (dc.gasFrac || 0) : 0;
      var prevFrac = (st.prevGasFracs[rc.id] != null) ? st.prevGasFracs[rc.id] : currFrac;
      maxFracChange = Math.max(maxFracChange, Math.abs(currFrac - prevFrac));
      st.prevGasFracs[rc.id] = currFrac;
      var currPvap = dc ? (dc.P_sat || 0) : 0;
      var prevPvap = (st.prevPvaps[rc.id] != null) ? st.prevPvaps[rc.id] : currPvap;
      if (prevPvap > 0) maxPvapChange = Math.max(maxPvapChange, Math.abs(currPvap - prevPvap) / prevPvap);
      st.prevPvaps[rc.id] = currPvap;
    }
    var tempStable = Math.abs(st.temperatureK - prevTempK) < 0.005;
    var fracStable = maxFracChange < 1e-6 && maxPvapChange < 0.001;
    if (!isPreWarm(tick) && tick >= TICK.MIN_CONVERGE && tempStable && fracStable) st.stableCount++;
    else st.stableCount = 0;
    if (st.stableCount >= 3 && !st.noConverge) st.converged = true;

    st.tick = tick + 1;
    return st;
  }

  // Run to convergence (or maxTicks) and produce a result summary.
  function simulate(planetLike, mirrorCounts, shadeCount, resourceKt, effectiveDistAU, options) {
    var st = createState(planetLike, mirrorCounts, shadeCount, resourceKt, effectiveDistAU, options);
    if (st.error) return { error: st.error, gravity: st.gravity };
    while (st.tick < st.maxTicks && !st.converged) step(st);
    return finalize(st, options || {});
  }

  function finalize(st, options) {
    var planet = st.planet, surface = st.surface, g = st.g, i;

    var liquidWaterFinal = st.deposits.water ? st.deposits.water.liquid : 0;
    var idealWaterAmount = surface * C.OCEAN_DEPTH * C.SURF_WATER_COV; // tonnes
    var idealWaterLinearTonnes = Math.pow(idealWaterAmount, 1 / C.WATER_SCALING);
    var waterParam = liquidWaterFinal > 0 ? Math.pow(liquidWaterFinal, C.WATER_SCALING) / idealWaterAmount : 0;

    var oxygenGasMass = st.deposits.oxygen ? st.deposits.oxygen.gas : 0;
    var totalAtmMass = 0;
    for (i = 0; i < RESOURCES.length; i++) totalAtmMass += st.deposits[RESOURCES[i].id] ? st.deposits[RESOURCES[i].id].gas : 0;
    var oxygenMassFrac = totalAtmMass > 0 ? oxygenGasMass / totalAtmMass : 0;

    var toxicity = computeEnvironmentalToxicity(st.deposits);
    // Magnetosphere interventions reduce effective radiation. Game UI subtracts
    // 0.6 per planetary generator and 0.7 per orbital generator.
    var iv = options.interventions || {};
    var magPlanet = iv.magPlanet || iv.magnetospherePlanet || 0;
    var magOrbit = iv.magOrbit || iv.magnetosphereOrbit || 0;
    var effectiveRadiation = Math.max(0, (planet.radiation || 0) - magPlanet * 0.6 - magOrbit * 0.7);

    var habResult = computeHabitabilityResult(
      { temperature: st.temperatureC, oxygenMassFrac: oxygenMassFrac, pressure: st.pressure, waterParam: waterParam, gravity: g },
      planet, toxicity, effectiveRadiation
    );
    var supplyMod = evalAnimCurve(HAB.supplyMod.keys, habResult);

    // Per-resource phase summary (only resources actually present).
    var phaseByResource = {};
    for (i = 0; i < RESOURCES.length; i++) {
      var r = RESOURCES[i], d = st.deposits[r.id];
      if (!d || d.total <= 0) continue;
      var gF = d.gasFrac || 0, lF = d.liquidFrac || 0, sF = d.solidFrac || 0;
      var dominant = "solid";
      if (gF >= lF && gF >= sF) dominant = "gas";
      else if (lF >= sF) dominant = "liquid";
      phaseByResource[r.id] = {
        name: r.name, gasFrac: gF, liquidFrac: lF, solidFrac: sF,
        dominant: dominant,
        gasKt: d.gas / 1000, liquidKt: d.liquid / 1000, solidKt: d.solid / 1000,
        saturationPressureAtm: d.P_sat, boilingPointK: d.T_boil_act
      };
    }

    return {
      // Primary requested outputs
      temperatureK: st.temperatureK,
      temperatureC: st.temperatureC,
      pressureAtm: st.pressure,
      habitability: habResult,            // game score, range [-100, 100]
      phaseByResource: phaseByResource,
      // Supporting detail
      swings: st.swings,
      tMinC: Math.max(C.MIN_KELWIN, st.temperatureC - st.swings),
      tMaxC: st.temperatureC + st.swings,
      tau: st.tau,
      emissivity: st.emissivity,
      mirrorsStrength: st.mirrorsStrength,
      shadesStrength: st.shadesStrength,
      absorbedFlux: st.absorbed,
      equilibriumTempC: st.T_eq + C.MIN_KELWIN,
      equilibriumTempK: st.T_eq,
      oxygenMassFrac: oxygenMassFrac,
      liquidWaterKt: liquidWaterFinal / 1000,
      idealWaterKt: idealWaterLinearTonnes / 1000,
      waterParam: waterParam,
      gravity: g,
      surface: surface,
      ticks: st.lastTick,
      converged: st.converged,
      supplyMod: supplyMod,
      toxicity: toxicity,
      extremeVolcanism: computeExtremeVolcanism(planet.internalFlux || 0.08),
      effectiveRadiation: effectiveRadiation,
      deposits: st.deposits,
      planet: planet
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HABITABILITY
  // ─────────────────────────────────────────────────────────────────────────
  function computeExtremeVolcanism(internalFlux) {
    return evalAnimCurve(HAB.planetCharacteristics.extremeVolcanism.keys, internalFlux);
  }

  function computeEnvironmentalToxicity(deposits) {
    var totalNonUnderground = 0, resAmounts = {}, i;
    for (i = 0; i < RESOURCES.length; i++) {
      var r = RESOURCES[i], d = deposits[r.id];
      if (!d || d.total <= 0) continue;
      var nonUg = (d.liquid || 0) + (d.solid || 0) + (d.gas || 0);
      if (nonUg > 0) { resAmounts[r.id] = nonUg; totalNonUnderground += nonUg; }
    }
    if (totalNonUnderground <= 0) return 1.0;
    var toxSum = 0, toxCount = 0;
    for (var resId in resAmounts) {
      if (!resAmounts.hasOwnProperty(resId)) continue;
      var toxKey = RESOURCE_TO_TOXICITY[resId];
      var fraction = resAmounts[resId] / totalNonUnderground;
      var toxScore = toxKey ? evalAnimCurve(HAB.resourceToxicity[toxKey].keys, fraction) : 0;
      toxSum += toxScore; toxCount++;
    }
    if (toxCount === 0) return 1.0;
    return evalAnimCurve(HAB.planetCharacteristics.environmentalToxicity.keys, toxSum / toxCount);
  }

  function computeHabitabilityResult(simResult, planet, toxicity, effectiveRadiation) {
    var paramDefs = [
      { curve: HAB.parameters.temperature, value: simResult.temperature },
      { curve: HAB.parameters.composition, value: simResult.oxygenMassFrac },
      { curve: HAB.parameters.pressure, value: simResult.pressure },
      { curve: HAB.parameters.gravity, value: simResult.gravity },
      { curve: HAB.parameters.water, value: simResult.waterParam },
      { curve: HAB.parameters.magnetosphere, value: effectiveRadiation }
    ];
    var weightedSum = 0, totalWeight = 0, i;
    for (i = 0; i < paramDefs.length; i++) {
      var score = evalAnimCurve(paramDefs[i].curve.keys, paramDefs[i].value);
      weightedSum += score * paramDefs[i].curve.weight;
      totalWeight += paramDefs[i].curve.weight;
    }
    var baseScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    var extVolc = computeExtremeVolcanism(planet.internalFlux || 0.08);
    var pcValues = [extVolc, toxicity, planet.cryoVolcanism || 1.0, planet.hydroCarbonLakes || 1.0];
    var pcSum = 0, pcCount = 0;
    for (i = 0; i < pcValues.length; i++) {
      if (Math.abs(pcValues[i] - 1.0) > 1e-6) { pcSum += pcValues[i]; pcCount++; }
    }
    if (pcCount > 0) baseScore += (pcSum / pcCount - 1.0) * 200.0;
    return Math.max(-100, Math.min(100, baseScore));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HIGH-LEVEL CONVENIENCE API
  //
  //   equilibrium(body, atmosphere, interventions) -> result
  //
  //   body         : CSV name string | hub gamedata body | internal planet.
  //   atmosphere   : { <resourceId>: kt } shorthand for gas mass, OR
  //                  { gasKt:{id:kt}, liqKt:{id:kt}, solidKt:{id:kt} } for full
  //                  control. Shorthand keys are treated as GAS mass (kt) — the
  //                  natural input when designing an atmosphere.
  //   interventions: { mirrors, shades, mirrorOrbitIndex, distanceAU,
  //                    magPlanet, magOrbit }
  // ─────────────────────────────────────────────────────────────────────────
  function splitAtmosphere(atmosphere) {
    var gasKt = {}, liqKt = {}, solidKt = {}, k;
    atmosphere = atmosphere || {};
    var hasExplicit = atmosphere.gasKt || atmosphere.liqKt || atmosphere.solidKt || atmosphere.liquidKt;
    if (hasExplicit) {
      var gk = atmosphere.gasKt || {}, lk = atmosphere.liqKt || atmosphere.liquidKt || {}, sk = atmosphere.solidKt || {};
      for (k in gk) if (gk.hasOwnProperty(k) && RES_BY_ID[k]) gasKt[k] = gk[k];
      for (k in lk) if (lk.hasOwnProperty(k) && RES_BY_ID[k]) liqKt[k] = lk[k];
      for (k in sk) if (sk.hasOwnProperty(k) && RES_BY_ID[k]) solidKt[k] = sk[k];
    } else {
      // Shorthand: every key is a resource id whose value is gas-phase kt.
      for (k in atmosphere) if (atmosphere.hasOwnProperty(k) && RES_BY_ID[k]) gasKt[k] = atmosphere[k];
    }
    return { gasKt: gasKt, liqKt: liqKt, solidKt: solidKt };
  }

  function equilibrium(body, atmosphere, interventions) {
    interventions = interventions || {};
    var split = splitAtmosphere(atmosphere);
    var mirrorCounts = mirrorCountsFromInterventions(interventions);
    var shadeCount = interventions.shades || interventions.shadeCount || 0;
    var effDist = interventions.distanceAU;
    var options = {
      gasKt: split.gasKt, liqKt: split.liqKt,
      maxTicks: interventions.maxTicks, noConverge: interventions.noConverge,
      interventions: interventions
    };
    // solidKt → resourceKt (5th arg is solid-phase seed mass).
    return simulate(body, mirrorCounts, shadeCount, split.solidKt, effDist, options);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────
  return {
    equilibrium: equilibrium,
    simulate: simulate,
    createState: createState,
    step: step,
    finalize: finalize,
    normalizeBody: normalizeBody,
    evalAnimCurve: evalAnimCurve,
    // data tables (read-only references)
    C: C,
    TICK: TICK,
    HAB: HAB,
    RESOURCES: RESOURCES,
    RES_BY_ID: RES_BY_ID,
    MIRROR_ORBITS: MIRROR_ORBITS,
    ALL_PLANETS: ALL_PLANETS,
    PLANETS_BY_NAME: PLANETS_BY_NAME
  };
});
