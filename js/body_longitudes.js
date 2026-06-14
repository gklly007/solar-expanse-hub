/* body_longitudes.js — mean longitude (deg) at epoch 1959-01-01 per body.
   Sourced from the stockmaj wiki's LAUNCH_WINDOW_ALL_BODIES (+ LAUNCH_WINDOW_EARTH);
   moons inherit their parent planet's longitude (they share the heliocentric orbit
   for the interplanetary leg). Pair with a body's semi_major_au and feed both to
   LaunchWindows.nextWindows() / GravityAssist. See tools/_scratch/body_longitudes.json
   for provenance + coverage. */
(function (root) {
  root.BODY_LONGITUDES = {
    "Mercury": 252.25032, "Venus": 181.9791, "Earth": 168, "Mars": 0,
    "Jupiter": 34.396442, "Saturn": 49.954243, "Uranus": 313.2381, "Neptune": 0, "Pluto": 238.92903,
    "1 Ceres": 0, "2 Pallas": 357, "3 Juno": 350, "4 Vesta": 314, "5 Astraea": 167, "6 Hebe": 207,
    "7 Iris": 29, "8 Flora": 303, "9 Metis": 0, "10 Hygiea": 15, "11 Parthenope": 299, "12 Victoria": 75,
    "13 Egeria": 150, "2048 Dwornik": 256, "2495 Noviomagum": 125, "5426 Sharp": 137, "267 Tirza": 305,
    "279 Thule": 111, "368 Haidea": 305, "2312 Duboshin": 305, "99942 Apophis": 100, "101955 Bennu": 84,
    "1036 Ganymed": 285, "25143 Itokawa": 84, "7088 Ishtar": 127, "3753 Cruithne": 84,
    "469219 Kamoʻoalewa": 190, "617 Patroclus": 323.7, "1172 Aneas": 238.69, "3317 Paris": 287.65,
    "588 Achilles": 205.11, "624 Hektor": 128.09, "911 Agamemnon": 136.09, "659 Nestor": 288.33,
    "098-Y Peppin": 20, "TJ66-2145": 102, "PC0-01 Kurai": 5, "MP3-87 Nosfer": 123, "KB5-98 Kris": 91,
    "PW4-13 Rider": 77, "BG1-65 Usher": 333, "TT-9025": 84, "AB2-38 Dover": 1, "ZZ9-01 Nebulavsky": 245,
    "DE8-42 Sunset": 334, "KH7-23 Geraldino": 355, "FL8-09 Varsoviom": 255, "UT7-55 Kutno": 305,
    "EX0-99 Extinctor": 70, "1P Halley": 0, "4P Faye": 0, "2P Encke": 0,
    "Luna": 168, "Phobos": 0, "Deimos": 0, "Amalthea": 34.396442, "Io": 34.396442, "Europa": 34.396442,
    "Ganymede": 34.396442, "Callisto": 34.396442, "Titan": 49.954243, "Enceladus": 49.954243,
    "Rhea": 49.954243, "Iapetus": 49.954243, "Tethys": 49.954243, "Mimas": 49.954243, "Hyperion": 49.954243,
    "Dione": 49.954243, "Ariel": 313.2381, "Umbriel": 313.2381, "Titania": 313.2381, "Oberon": 313.2381,
    "Puck": 313.2381, "Triton": 0, "Proteus": 0, "Nereid": 0, "Charon": 238.92903
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.BODY_LONGITUDES;
})(typeof self !== "undefined" ? self : this);
