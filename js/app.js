/* Solar Expanse Hub — single-page app over gamedata.json.
   No framework, no build step. All events via addEventListener (CSP-safe). */
(function () {
  "use strict";

  var DATA = null;
  var IDX = {};            // lookup indexes built after load
  var view = document.getElementById("view");

  // ---- persistent state ----------------------------------------------------
  var owned = loadSet("se-owned");          // research ids the player has completed
  // ---- Build & Cost state (merged Build Calculator + Expansion Planner) -----
  // Canonical store is se-build, extended with an optional `dest`. The old
  // Expansion Planner store (se-exp) is read defensively and migrated in so a
  // returning user keeps their list/destination without errors.
  var build = migrateBuildState();
  var SAVE = loadJSON("se-save", null);     // imported save summary (stockpile/fleet/money)
  var plannerTarget = null;                 // pending planner selection

  function migrateBuildState() {
    var b = loadJSON("se-build", null);
    var e = loadJSON("se-exp", null);
    b = (b && typeof b === "object") ? b : {};
    e = (e && typeof e === "object") ? e : {};
    var placed = (b.placed && typeof b.placed === "object") ? b.placed : {};
    // If the Build Calculator list is empty but the old Expansion list isn't,
    // adopt the Expansion list so nothing the user planned is lost.
    if (!Object.keys(placed).length && e.placed && typeof e.placed === "object" && Object.keys(e.placed).length) {
      placed = e.placed;
    }
    var state = {
      placed: placed,
      ship: (b.ship != null) ? b.ship : null,
      // carry a destination from either store (prefer the new one)
      dest: (b.dest != null) ? b.dest : (e.dest != null ? e.dest : null)
    };
    saveJSON("se-build", state);
    return state;
  }

  function loadSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); }
    catch (e) { return new Set(); }
  }
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([].concat.apply([], [Array.from(set)]))); } catch (e) {}
  }
  function loadJSON(key, dflt) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v || dflt; } catch (e) { return dflt; }
  }
  function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  // ---- tiny helpers --------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function fmtInt(n) { if (n == null) return "—"; return Math.round(n).toLocaleString(); }
  function fmtHours(n) {
    if (n == null) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
  }
  function num(n, dp) { if (n == null) return "—"; return (+n).toLocaleString(undefined, { maximumFractionDigits: dp == null ? 4 : dp }); }

  var RES_FALLBACK = {
    hel3: "Helium-3", water: "Water", volatile: "Carbon", hydrogen: "Hydrogen",
    oxygen: "Oxygen", nitrogen: "Nitrogen", co2: "Carbon Dioxide", noblegas: "Noble Gas",
    fuel: "Chemical Fuel", energy: "Energy", human: "Humans", antimatter: "Antimatter",
    consumergoods: "Consumer Goods"
  };
  function resName(id) {
    if (IDX.resName && IDX.resName[id]) return IDX.resName[id];
    return RES_FALLBACK[id] || id;
  }
  function resIcon(id) { return "img/resources/" + (id === "hel3" ? "hel3" : id) + ".png"; }
  function resPip(id, amount) {
    return '<span class="res" title="' + esc(resName(id)) + '">' +
      '<img src="' + resIcon(id) + '" alt="" loading="lazy">' +
      '<span class="n">' + fmtInt(amount) + '</span></span>';
  }
  function costPips(arr) {
    if (!arr || !arr.length) return '<span class="muted">free</span>';
    return arr.map(function (b) { return resPip(b.resource, b.amount); }).join("");
  }
  function eraBadge(era) {
    if (!era) return "";
    return '<span class="badge era-' + esc(era) + '">' + esc(era) + "</span>";
  }
  function lockBadge(locked) { return locked ? ' <span class="badge lock">locked</span>' : ""; }

  // =========================================================================
  // Generic sortable + filterable table
  // =========================================================================
  // cols: [{key,label,num?,title?,get?(row)->sortValue, html?(row)->cell html}]
  function makeTable(mount, opts) {
    var rows = opts.rows.slice();
    var sortKey = opts.initialSort || (opts.cols[0] && opts.cols[0].key);
    var sortAsc = opts.initialAsc !== false;
    var filter = "";
    var colByKey = {};
    opts.cols.forEach(function (c) { colByKey[c.key] = c; });

    var wrap = el('<div></div>');
    var bar = el('<div class="controls"></div>');
    var search = el('<input type="search" placeholder="' + esc(opts.placeholder || "Filter…") + '">');
    bar.appendChild(search);
    if (opts.extraControls) opts.extraControls.forEach(function (c) { bar.appendChild(c); });
    var count = el('<span class="muted"></span>');
    bar.appendChild(count);
    wrap.appendChild(bar);
    var tblWrap = el('<div class="tbl-wrap"></div>');
    wrap.appendChild(tblWrap);
    mount.appendChild(wrap);

    function valOf(row, col) {
      if (col.get) return col.get(row);
      var v = row[col.key];
      return v == null ? (col.num ? -Infinity : "") : v;
    }
    function draw() {
      var q = filter.trim().toLowerCase();
      var filtered = rows.filter(function (r) {
        if (!q) return true;
        return (opts.search || []).some(function (k) {
          var v = typeof k === "function" ? k(r) : r[k];
          return v != null && String(v).toLowerCase().indexOf(q) !== -1;
        });
      });
      filtered.sort(function (a, b) {
        var col = colByKey[sortKey];
        var va = valOf(a, col), vb = valOf(b, col);
        if (typeof va === "string" || typeof vb === "string") {
          va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
          return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        return sortAsc ? va - vb : vb - va;
      });
      count.textContent = filtered.length + " / " + rows.length;
      var thead = "<thead><tr>" + opts.cols.map(function (c) {
        var cls = (c.num ? "num " : "") + (c.key === sortKey ? "sorted " + (sortAsc ? "asc" : "") : "");
        return '<th class="' + cls.trim() + '" data-k="' + esc(c.key) + '"' +
          (c.title ? ' title="' + esc(c.title) + '"' : "") + ">" + esc(c.label) + "</th>";
      }).join("") + "</tr></thead>";
      var tbody = "<tbody>" + filtered.map(function (r) {
        var tr = '<tr class="' + (opts.rowClass ? opts.rowClass(r) : "") + '">';
        tr += opts.cols.map(function (c) {
          var cls = c.num ? ' class="num"' : (c.cls ? ' class="' + c.cls + '"' : "");
          return "<td" + cls + ">" + (c.html ? c.html(r) : esc(r[c.key] == null ? "—" : r[c.key])) + "</td>";
        }).join("");
        return tr + "</tr>";
      }).join("") + "</tbody>";
      tblWrap.innerHTML = '<table class="data">' + thead + tbody + "</table>";
      tblWrap.querySelectorAll("th").forEach(function (th) {
        th.addEventListener("click", function () {
          var k = th.getAttribute("data-k");
          if (k === sortKey) sortAsc = !sortAsc; else { sortKey = k; sortAsc = !colByKey[k].num; }
          draw();
        });
      });
      if (opts.afterDraw) opts.afterDraw(tblWrap);
    }
    search.addEventListener("input", function () { filter = search.value; draw(); });
    draw();
    return { redraw: draw };
  }

  // =========================================================================
  // Build-calculator math — ported verbatim from the wiki's calculator.js,
  // which mirrors the game's BonusController (additive stacking).
  // =========================================================================
  function activeReductions() {
    return DATA.reductions.filter(function (r) { return r.research_id && owned.has(r.research_id); });
  }
  function buildCostMult(fac, reds) {
    var sum = 0;
    reds.forEach(function (r) {
      if (r.kind !== "BuildCost") return;
      if (r.affects_all === true || (r.affects && r.affects.indexOf(fac.id) !== -1)) sum += r.percent;
    });
    return Math.max(0, (100 - sum) / 100);
  }
  function crewMult(fac, reds) {
    var sum = 0;
    reds.forEach(function (r) {
      if (r.kind !== "ReduceCrewRequirements") return;
      if (r.affects_all === true || (r.affects && r.affects.indexOf(fac.id) !== -1)) sum += r.percent;
    });
    return Math.max(0, (100 - sum) / 100);
  }
  function powerMult(fac, reds) {
    var sum = 0;
    reds.forEach(function (r) {
      if (r.kind !== "PowerProduction") return;
      if (r.affects_all === true || (r.affects && r.affects.indexOf(fac.id) !== -1)) sum += r.percent;
    });
    return (100 + sum) / 100;
  }

  // =========================================================================
  // Router
  // =========================================================================
  var ROUTES = {
    home: viewHome, planner: viewPlanner, build: viewBuild,
    // Phase 2: "Build & Cost" (viewBuild) absorbed the old Expansion Planner;
    // keep #/expansion working by pointing it at the same merged view.
    expansion: viewBuild,
    trip: viewTrip,
    research: viewResearch, facilities: viewFacilities, spacecraft: viewSpacecraft,
    launchvehicles: viewLaunchVehicles, modules: viewModules, bodies: viewBodies,
    terraform: viewTerraform, resources: viewResources,
    // Phase 2: Economy retired — its content (per-resource producers/consumers
    // and facility Power+/Power−) lives on Resources & Facilities. Land #/economy
    // on Resources so old links still make sense.
    economy: viewResources,
    progression: viewProgression
  };

  // ---- two-level navigation (layout only; every tabKey is an existing route) -
  // Primary bar = these 5 groups; sub-nav lists the active group's items.
  var GROUPS = [
    { key: "home", label: "Home", items: [
      { tab: "home", label: "Home" }
    ] },
    { key: "plan", label: "Plan", items: [
      { tab: "build", label: "Build & Cost" },
      { tab: "planner", label: "Research Planner" }
    ] },
    { key: "travel", label: "Travel", items: [
      { tab: "trip", label: "Trip Planner" },
      { tab: "launchvehicles", label: "Launch Vehicles" }
    ] },
    { key: "worlds", label: "Worlds", items: [
      { tab: "bodies", label: "Bodies" },
      { tab: "terraform", label: "Terraforming" },
      { tab: "resources", label: "Resources" }
    ] },
    { key: "reference", label: "Reference", items: [
      { tab: "research", label: "Research" },
      { tab: "facilities", label: "Facilities" },
      { tab: "spacecraft", label: "Spacecraft" },
      { tab: "modules", label: "Modules" },
      { tab: "progression", label: "Progression" }
    ] }
  ];
  // Legacy hash aliases that no longer have their own nav item — they render a
  // merged/relocated view but should highlight (and be remembered as) the
  // canonical tab so the nav stays consistent.
  var TAB_ALIAS = { expansion: "build", economy: "resources" };
  function canonTab(tab) { return TAB_ALIAS[tab] || tab; }
  var TAB_GROUP = {};  // tabKey -> group key
  GROUPS.forEach(function (g) { g.items.forEach(function (it) { TAB_GROUP[it.tab] = g.key; }); });
  function groupByKey(gkey) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].key === gkey) return GROUPS[i]; return null; }
  function groupForTab(tab) { return groupByKey(TAB_GROUP[tab] || "home"); }
  // remember the last sub-item visited per group, so re-clicking a group returns there
  var lastTabInGroup = loadJSON("se-nav-last", {});

  // Build the primary group bar once (data-driven). Sub-nav is (re)built per render.
  function buildNav() {
    var groupsBar = document.getElementById("nav-groups");
    if (!groupsBar) return;
    groupsBar.innerHTML = "";
    GROUPS.forEach(function (g) {
      var first = g.items[0];
      var targetTab = (lastTabInGroup[g.key] && ROUTES[lastTabInGroup[g.key]]) ? lastTabInGroup[g.key] : first.tab;
      var a = el('<a class="nav-group" data-group="' + esc(g.key) +
        '" href="#/' + esc(targetTab) + '">' + esc(g.label) + "</a>");
      groupsBar.appendChild(a);
    });
  }
  function renderSubNav(tab) {
    var sub = document.getElementById("nav-sub");
    if (!sub) return;
    var g = groupForTab(tab);
    sub.innerHTML = "";
    // single-item groups (Home) have no useful sub-nav; hide the row.
    if (!g || g.items.length <= 1) { sub.classList.add("subnav-empty"); return; }
    sub.classList.remove("subnav-empty");
    g.items.forEach(function (it) {
      var a = el('<a data-tab="' + esc(it.tab) + '" href="#/' + esc(it.tab) + '">' + esc(it.label) + "</a>");
      a.classList.toggle("active", it.tab === tab);
      sub.appendChild(a);
    });
  }

  function currentTab() {
    var h = (location.hash || "#/home").replace(/^#\//, "");
    return ROUTES[h] ? h : "home";
  }
  function render() {
    var rawTab = currentTab();
    var tab = canonTab(rawTab);   // normalize legacy aliases (#/expansion, #/economy)
    var gkey = TAB_GROUP[tab] || "home";
    lastTabInGroup[gkey] = tab; saveJSON("se-nav-last", lastTabInGroup);
    // highlight the active group in the primary bar
    document.querySelectorAll("#nav-groups .nav-group").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-group") === gkey);
    });
    // (re)build the sub-nav for the active group and highlight the active sub-item
    renderSubNav(tab);
    view.innerHTML = "";
    window.scrollTo(0, 0);
    ROUTES[tab](view);
  }

  function pageHeader(mount, title, sub) {
    mount.appendChild(el('<h2 class="page-title">' + esc(title) + "</h2>"));
    if (sub) mount.appendChild(el('<p class="page-sub">' + sub + "</p>"));
  }

  // =========================================================================
  // HOME
  // =========================================================================
  function viewHome(mount) {
    pageHeader(mount, "Solar Expanse Hub",
      "One page for the data and the math — so you don't have to bounce between six sites. " +
      "Data is extracted straight from the game's own files (v" + esc(DATA.meta.game_version) + ").");

    if (!SAVE) {
      // No save yet: lead with a big, inviting import hero.
      var hero = el('<div class="panel home-hero"></div>');
      hero.innerHTML =
        '<div class="home-hero-icon">📁</div>' +
        "<h3>Import your save to make this yours</h3>" +
        '<p>Load a Solar Expanse save and the Hub fills in your research, stockpile and fleet — ' +
        "so the planners show exactly what <i>you</i> still need and how to ship it.</p>" +
        '<p class="muted home-hero-note">No save? No problem — every tool works without one. ' +
        "You can also just drag a save file anywhere onto the page.</p>";
      var heroBtn = el('<button class="btn home-hero-btn">📁 Import save</button>');
      heroBtn.addEventListener("click", function () {
        var ib = document.getElementById("import-btn");
        if (ib) ib.click();
      });
      hero.appendChild(heroBtn);
      mount.appendChild(hero);
    } else {
      // Save imported: lead with the live colony dashboard.
      homeDashboard(mount);
    }

    var stats = el('<div class="panel"></div>');
    stats.appendChild(el("<h3>Game data loaded</h3>"));
    var sr = el('<div class="stat-row"></div>');
    [["research", "research nodes"], ["facilities", "facilities"], ["spacecraft", "spacecraft"],
     ["launch_vehicles", "launch vehicles"], ["planets", "planets"], ["moons", "moons"],
     ["asteroids", "asteroids"], ["contracts", "contracts"]].forEach(function (p) {
      sr.appendChild(el('<div class="stat"><div class="big">' + DATA[p[0]].length + '</div><div class="lbl">' + p[1] + "</div></div>"));
    });
    stats.appendChild(sr);
    mount.appendChild(stats);

    var grid = el('<div class="grid"></div>');
    grid.appendChild(el(
      '<div class="card"><h4>🔬 Research Planner</h4><p>Pick what you want — a tech, a facility, or a ship — and get the exact prerequisite chain, total work-hours, and an ETA from your lab output.</p>' +
      '<a href="#/planner">Open planner →</a></div>'));
    grid.appendChild(el(
      '<div class="card"><h4>🏗️ Build &amp; Cost</h4><p>Add facilities &amp; modules, apply your completed research discounts automatically, and see total resources, tonnage, ship trips, workers and power. Pick a destination and (with a save) what you still need to ship.</p>' +
      '<a href="#/build">Open Build &amp; Cost →</a></div>'));
    grid.appendChild(el(
      '<div class="card"><h4>🪐 Reference</h4><p>Every facility, spacecraft, module, planet, moon, asteroid and terraforming constant — all sortable and searchable.</p>' +
      '<a href="#/research">Browse research →</a></div>'));
    mount.appendChild(grid);

    var src = el('<div class="panel"></div>');
    src.innerHTML = "<h3>Original tools (still here if you need them)</h3>" +
      '<div class="grid">' +
      '<div class="linklist"><a href="' + DATA.meta.sources.wiki + '" target="_blank" rel="noopener">📚 Solar Expanse Wiki</a>' +
      '<a href="' + DATA.meta.sources.build_calc + '" target="_blank" rel="noopener">🧮 SE Build Calculator</a></div>' +
      '<div class="linklist"><a href="' + DATA.meta.sources.terraform_sim + '" target="_blank" rel="noopener">🌍 Terraforming Simulator</a>' +
      '<a href="' + DATA.meta.sources.colonisation_planner + '" target="_blank" rel="noopener">🛰️ Colonisation Planner</a></div>' +
      "</div>" +
      '<p class="page-sub" style="margin-top:12px">Tip: tick research you\'ve completed on the <a href="#/research">Research</a> tab — it carries into the planner (skips done techs) and the build calculator (auto-applies discounts).</p>';
    mount.appendChild(src);
  }

  // =========================================================================
  // RESEARCH (reference) — with owned toggle + plan button
  // =========================================================================
  function researchById(id) { return IDX.research[id]; }

  function viewResearch(mount) {
    pageHeader(mount, "Research tech tree",
      "Tick <b>✓</b> for techs you've completed — it feeds the planner and the build-calc discounts. Cost is in work-hours.");

    var showUnreleased = { v: false };
    var unrelChip = el('<span class="chip">Show unreleased</span>');
    unrelChip.addEventListener("click", function () {
      showUnreleased.v = !showUnreleased.v; unrelChip.classList.toggle("on", showUnreleased.v); rebuild();
    });
    var branchSel = el('<select><option value="">All branches</option>' +
      uniq(DATA.research.map(function (r) { return r.branch; })).sort().map(function (b) {
        return '<option value="' + esc(b) + '">' + esc(b) + "</option>";
      }).join("") + "</select>");
    branchSel.addEventListener("change", rebuild);

    var holder = el("<div></div>");
    mount.appendChild(holder);
    var tableApi = null;

    function rebuild() {
      holder.innerHTML = "";
      var rows = DATA.research.filter(function (r) {
        if (!showUnreleased.v && !r.released) return false;
        if (branchSel.value && r.branch !== branchSel.value) return false;
        return true;
      });
      makeTable(holder, {
        rows: rows, placeholder: "Filter research…", search: ["name", "branch", "description"],
        initialSort: "cost_hours", initialAsc: true,
        extraControls: [branchSel, unrelChip],
        rowClass: function (r) { return r.released ? "" : "row-locked"; },
        cols: [
          { key: "own", label: "✓", title: "Mark as researched", html: function (r) {
              return '<input type="checkbox" class="own-cb" data-id="' + esc(r.id) + '"' + (owned.has(r.id) ? " checked" : "") + ">"; } },
          { key: "name", label: "Research", cls: "namecell", html: function (r) { return esc(r.name) + lockBadge(!r.released); } },
          { key: "branch", label: "Branch", html: function (r) { return '<span class="badge cat">' + esc(r.branch) + "</span>"; } },
          { key: "era", label: "Era", html: function (r) { return eraBadge(r.era); } },
          { key: "cost_hours", label: "Cost (h)", num: true, html: function (r) { return fmtHours(r.cost_hours); } },
          { key: "prereqs", label: "Prereqs", get: function (r) { return r.prereqs.length; }, html: function (r) {
              return r.prereqs.length ? r.prereqs.map(function (p) { return '<a href="#/planner" class="goto-plan" data-id="' + esc(p.id) + '">' + esc(p.name) + "</a>"; }).join(", ") : '<span class="muted">—</span>'; }, cls: "desccell" },
          { key: "unlocks", label: "Unlocks", get: function (r) { return (r.unlock_links || []).length; }, html: function (r) {
              var links = (r.unlock_links || []).map(resolveUnlockToken).filter(Boolean);
              if (!links.length) { var disp = (r.unlocks || []).filter(function (u) { return u && u !== "—"; }); return disp.length ? esc(disp.join(" · ")) : '<span class="muted">—</span>'; }
              return links.map(function (t) { return '<a href="#/' + t.tab + '" class="xlink" data-tab="' + esc(t.tab) + '" data-name="' + esc(t.name) + '" data-cat="' + esc(t.cat) + '">' + esc(t.name) + "</a>"; }).join(" "); }, cls: "desccell" },
          { key: "plan", label: "", html: function (r) { return '<button class="chip plan-btn" data-id="' + esc(r.id) + '">plan ▸</button>'; } }
        ],
        afterDraw: function (w) {
          w.querySelectorAll(".own-cb").forEach(function (cb) {
            cb.addEventListener("change", function () {
              var id = cb.getAttribute("data-id");
              if (cb.checked) owned.add(id); else owned.delete(id);
              saveSet("se-owned", owned);
            });
          });
          w.querySelectorAll(".plan-btn").forEach(function (b) {
            b.addEventListener("click", function () {
              plannerTarget = { kind: "research", id: b.getAttribute("data-id") };
              location.hash = "#/planner";
            });
          });
          wirePlanLinks(w); wireXLinks(w); applySearchJump(w, "research");
        }
      });
    }
    rebuild();
  }

  // =========================================================================
  // RESEARCH PLANNER (optimizer)
  // =========================================================================
  function planFor(targetIds) {
    var needed = {};
    function visit(id) {
      var node = researchById(id);
      if (!node || needed[id]) return;
      needed[id] = node;
      node.prereqs.forEach(function (p) { visit(p.id); });
    }
    targetIds.forEach(visit);
    // topological order: prereqs first; tie-break era then cost
    var eraRank = { Early: 0, Mid: 1, Late: 2 };
    var placed = {}, order = [];
    var pending = Object.keys(needed);
    var guard = 0;
    while (pending.length && guard++ < 10000) {
      var avail = pending.filter(function (id) {
        return needed[id].prereqs.every(function (p) { return !needed[p.id] || placed[p.id]; });
      });
      if (!avail.length) avail = pending.slice(); // cycle safety
      avail.sort(function (a, b) {
        var na = needed[a], nb = needed[b];
        var ra = eraRank[na.era] == null ? 9 : eraRank[na.era];
        var rb = eraRank[nb.era] == null ? 9 : eraRank[nb.era];
        if (ra !== rb) return ra - rb;
        return (na.cost_hours || 0) - (nb.cost_hours || 0);
      });
      var pick = avail[0];
      placed[pick] = true; order.push(needed[pick]);
      pending.splice(pending.indexOf(pick), 1);
    }
    return order;
  }

  function viewPlanner(mount) {
    pageHeader(mount, "Research Planner",
      "Choose a goal — the planner walks every prerequisite, in order, and totals the work-hours left after what you've already researched.");

    // build the goal options
    var goals = [];
    DATA.research.filter(function (r) { return r.released; }).forEach(function (r) {
      goals.push({ value: "research:" + r.id, label: "🔬 " + r.name + "  [" + r.branch + "]" });
    });
    DATA.facilities.filter(function (f) { return f.unlocked_by && f.unlocked_by.length; }).forEach(function (f) {
      goals.push({ value: "fac:" + f.id, label: "🏗️ Build: " + f.name });
    });
    DATA.spacecraft.filter(function (s) { return s.unlocked_by && s.unlocked_by.length; }).forEach(function (s) {
      goals.push({ value: "ship:" + s.id, label: "🚀 Ship: " + s.name });
    });
    goals.sort(function (a, b) { return a.label.localeCompare(b.label); });

    var panel = el('<div class="panel"></div>');
    panel.appendChild(el("<h3>Goal</h3>"));
    var ctr = el('<div class="controls"></div>');
    var sel = el('<select id="goal-sel" style="min-width:340px;flex:1"><option value="">— pick a tech, facility, or ship —</option>' +
      goals.map(function (g) { return '<option value="' + esc(g.value) + '">' + esc(g.label) + "</option>"; }).join("") + "</select>");
    ctr.appendChild(sel);
    ctr.appendChild(el('<label class="check" title="Your total research output per day across all labs">Lab output (h/day): ' +
      '<input type="number" id="lab-out" min="1" value="' + (loadJSON("se-labout", 5000)) + '" style="width:110px"></label>'));
    panel.appendChild(ctr);
    panel.appendChild(el('<p class="page-sub" style="margin:0">Work-hours / day depends on your labs &amp; computing research. Put your in-game research rate here for a day estimate.</p>'));
    mount.appendChild(panel);

    var out = el("<div></div>");
    mount.appendChild(out);

    function resolveTargets() {
      var v = sel.value;
      if (!v) return null;
      var parts = v.split(":"), kind = parts[0], id = parts.slice(1).join(":");
      if (kind === "research") return { name: researchById(id).name, ids: [id] };
      if (kind === "fac") { var f = IDX.facilities[id]; return { name: "Build " + f.name, ids: f.unlocked_by.map(function (u) { return u.id; }) }; }
      if (kind === "ship") { var s = IDX.spacecraftById[id]; return { name: s.name, ids: s.unlocked_by.map(function (u) { return u.id; }) }; }
      return null;
    }

    function draw() {
      out.innerHTML = "";
      var tgt = resolveTargets();
      if (!tgt) { out.appendChild(el('<p class="empty">Pick a goal above to see the path.</p>')); return; }
      var order = planFor(tgt.ids);
      var labOut = Math.max(1, parseInt(document.getElementById("lab-out").value, 10) || 1);
      saveJSON("se-labout", labOut);

      var remaining = order.filter(function (n) { return !owned.has(n.id); });
      var totalAll = order.reduce(function (s, n) { return s + (n.cost_hours || 0); }, 0);
      var totalLeft = remaining.reduce(function (s, n) { return s + (n.cost_hours || 0); }, 0);
      var daysLeft = Math.ceil(totalLeft / labOut);

      var summary = el('<div class="panel"></div>');
      summary.innerHTML = "<h3>Path to " + esc(tgt.name) + "</h3>" +
        '<div class="callout">' +
        "<b>" + remaining.length + "</b> tech" + (remaining.length === 1 ? "" : "s") + " left of " + order.length +
        " · <b>" + fmtHours(totalLeft) + "</b> work-hours remaining" +
        (totalAll !== totalLeft ? ' <span class="muted">(' + fmtHours(totalAll) + " full chain)</span>" : "") +
        " · ≈ <b>" + daysLeft.toLocaleString() + "</b> days at " + labOut.toLocaleString() + " h/day" +
        "</div>";
      out.appendChild(summary);

      var steps = el('<div class="panel"></div>');
      steps.appendChild(el("<h3>Order to research</h3>"));
      var cum = 0, n = 0;
      order.forEach(function (node) {
        var done = owned.has(node.id);
        if (!done) { cum += node.cost_hours || 0; n++; }
        var step = el('<div class="chain-step ' + (done ? "done" : "") + '"></div>');
        step.innerHTML =
          '<span class="step-n">' + (done ? "✓" : n) + "</span>" +
          '<span class="step-name">' + esc(node.name) + " " + eraBadge(node.era) +
          ' <span class="muted">· ' + esc(node.branch) + "</span></span>" +
          '<span class="muted">' + fmtHours(node.cost_hours) + " h" +
          (done ? "" : ' · Σ ' + fmtHours(cum)) + "</span>";
        steps.appendChild(step);
      });
      out.appendChild(steps);
    }

    sel.addEventListener("change", draw);
    document.getElementById("lab-out").addEventListener("input", draw);
    if (plannerTarget && plannerTarget.kind === "research") {
      sel.value = "research:" + plannerTarget.id; plannerTarget = null;
    }
    draw();
  }

  // =========================================================================
  // BUILD & COST (optimizer) — merged Build Calculator + Expansion Planner.
  // Core: pick items, auto-apply research discounts, show resources / tonnage /
  // ship trips / workers / power. Optionally pick a destination; with a save
  // imported it additionally shows have / short / missing-research and how many
  // fleet trips/waves the build-out needs.
  // =========================================================================
  function placeables() {
    var items = [];
    DATA.facilities.forEach(function (f) { items.push({ id: f.id, name: f.name, cat: f.category, kind: "fac", ref: f }); });
    DATA.space_modules.forEach(function (m) { items.push({ id: m.id, name: m.name, cat: "Module: " + m.category, kind: "mod", ref: m }); });
    DATA.crew_transports.forEach(function (c) { items.push({ id: c.id, name: c.name, cat: "Crew Transport", kind: "crew", ref: c }); });
    return items;
  }

  function viewBuild(mount) {
    pageHeader(mount, "Build &amp; Cost",
      "Add what you want to build; discounts from research you've ticked apply automatically (additive, exactly like the game). " +
      "Pick an optional destination — with a save imported you also see what you have, what's short, and how many fleet trips it takes.");

    if (!SAVE) mount.appendChild(el('<div class="callout">Tip: click <b>📁 Import save</b> (top-right) — or just <b>drag your save file onto this page</b> — to load your research, stockpile and fleet. Then a destination shows exactly what you still need and how to ship it. Everything works without a save too (it just shows totals).</div>'));

    var items = placeables();
    var byId = {}; items.forEach(function (i) { byId[i.id] = i; });

    var cols = el('<div class="cols"></div>');

    // left: picker
    var left = el('<div class="panel"></div>');
    left.appendChild(el("<h3>Add facilities &amp; modules</h3>"));
    var pf = el('<input type="search" placeholder="Filter…">');
    left.appendChild(pf);
    var pickList = el('<div class="picker-list"></div>');
    left.appendChild(pickList);
    cols.appendChild(left);

    // right: placed + totals
    var right = el("<div></div>");
    var placedPanel = el('<div class="panel"></div>');
    placedPanel.innerHTML = "<h3>Plan <button class='chip' id='clr' style='float:right'>clear</button></h3>";
    // optional destination selector (from the old Expansion Planner)
    var destCtl = el('<div class="controls"><label class="check">Destination:</label></div>');
    var bodies = DATA.planets.map(function (p) { return p.name; })
      .concat(DATA.moons.map(function (m) { return m.name + " (" + m.parent + ")"; }));
    var destSel = el('<select style="min-width:180px"><option value="">— none (totals only) —</option>' +
      bodies.map(function (b) { return '<option' + (build.dest === b ? " selected" : "") + ">" + esc(b) + "</option>"; }).join("") + "</select>");
    destCtl.appendChild(destSel);
    placedPanel.appendChild(destCtl);
    var placedList = el("<div></div>");
    placedPanel.appendChild(placedList);
    right.appendChild(placedPanel);
    var totalsPanel = el('<div class="panel"></div>');
    totalsPanel.appendChild(el("<h3>Totals</h3>"));
    var shipSel = el('<select id="ship-sel"></select>');
    DATA.spacecraft.filter(function (s) { return s.cargo_t; }).sort(function (a, b) { return a.cargo_t - b.cargo_t; })
      .forEach(function (s) {
        shipSel.appendChild(el('<option value="' + esc(s.id) + '">' + esc(s.name) + " — " + fmtInt(s.cargo_t) + " t/trip</option>"));
      });
    if (build.ship) shipSel.value = build.ship;
    var shipCtl = el('<div class="controls"><label class="check">Ship: </label></div>');
    shipCtl.appendChild(shipSel);
    totalsPanel.appendChild(shipCtl);
    var totalsBox = el("<div></div>");
    totalsPanel.appendChild(totalsBox);
    right.appendChild(totalsPanel);
    cols.appendChild(right);

    mount.appendChild(cols);

    // reductions panel (full width)
    var redPanel = el('<div class="panel"></div>');
    redPanel.innerHTML = "<h3>Research discounts <span class='muted' style='font-weight:400;font-size:12px'>(ticked = completed; shared with the Research tab)</span></h3>";
    var redGrid = el('<div class="reduction-grid"></div>');
    DATA.reductions.slice().sort(function (a, b) { return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name); })
      .forEach(function (r) {
        if (!r.research_id) return;
        var kindLbl = { BuildCost: "build cost", PowerProduction: "power", ReduceCrewRequirements: "crew" }[r.kind] || r.kind;
        var lab = el('<label class="check"><input type="checkbox" class="red-cb" data-id="' + esc(r.research_id) + '"' +
          (owned.has(r.research_id) ? " checked" : "") + "> " + esc(r.name) +
          ' <span class="muted">(−' + r.percent + "% " + kindLbl + ")</span></label>");
        redGrid.appendChild(lab);
      });
    redPanel.appendChild(redGrid);
    mount.appendChild(redPanel);

    // destination-aware results (have / short / missing-research / fleet trips).
    // Only shown when a destination is chosen; hidden otherwise so a no-destination
    // user gets exactly the old Build Calculator.
    var destBox = el('<div class="panel"></div>');
    destBox.style.display = "none";
    mount.appendChild(destBox);

    function refresh() { drawPlaced(); drawTotals(); drawDest(); drawPicker(); }
    function add(id, d) { build.placed[id] = Math.max(0, (build.placed[id] || 0) + d); if (!build.placed[id]) delete build.placed[id]; saveJSON("se-build", build); drawPlaced(); drawTotals(); drawDest(); drawPicker(); }
    function setCount(id, v) { build.placed[id] = Math.max(0, Math.floor(v || 0)); if (!build.placed[id]) delete build.placed[id]; saveJSON("se-build", build); drawPlaced(); drawTotals(); drawDest(); }

    function drawPicker() {
      var q = pf.value.trim().toLowerCase();
      var reds = activeReductions();
      var byCat = {};
      items.forEach(function (it) {
        if (q && it.name.toLowerCase().indexOf(q) === -1) return;
        (byCat[it.cat] = byCat[it.cat] || []).push(it);
      });
      var html = "";
      Object.keys(byCat).sort().forEach(function (cat) {
        html += '<div class="pick-cat">' + esc(cat) + "</div>";
        byCat[cat].sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (it) {
          var costStr = "";
          if (it.kind === "fac") {
            var m = buildCostMult(it.ref, reds);
            costStr = (it.ref.build_cost || []).map(function (b) { return resPip(b.resource, Math.round(b.amount * m)); }).join("");
          } else { costStr = '<span class="pick-cost">' + fmtInt(it.ref.mass) + " t" + (it.ref.is_locked ? " 🔒" : "") + "</span>"; }
          html += '<div class="pick-item" data-id="' + esc(it.id) + '"><span class="pick-name">' + esc(it.name) +
            "</span><span class='pick-cost'>" + costStr + "</span></div>";
        });
      });
      pickList.innerHTML = html || '<p class="empty">No matches.</p>';
      pickList.querySelectorAll(".pick-item").forEach(function (d) {
        d.addEventListener("click", function () { add(d.getAttribute("data-id"), 1); });
      });
    }

    function drawPlaced() {
      var ids = Object.keys(build.placed);
      if (!ids.length) { placedList.innerHTML = '<p class="empty">Click items on the left to add them.</p>'; return; }
      placedList.innerHTML = "";
      ids.sort(function (a, b) { return byId[a].name.localeCompare(byId[b].name); }).forEach(function (id) {
        var it = byId[id], c = build.placed[id];
        var row = el('<div class="placed-row"><span class="pname">' + esc(it.name) + "</span></div>");
        var counter = el('<span class="counter"></span>');
        var dec = el("<button>−</button>"), inc = el("<button>+</button>");
        var inp = el('<input type="number" min="0" value="' + c + '">');
        dec.addEventListener("click", function () { add(id, -1); });
        inc.addEventListener("click", function () { add(id, 1); });
        inp.addEventListener("change", function () { setCount(id, parseInt(inp.value, 10)); });
        counter.appendChild(dec); counter.appendChild(inp); counter.appendChild(inc);
        row.appendChild(counter);
        var rm = el('<button class="chip">✕</button>'); rm.addEventListener("click", function () { delete build.placed[id]; saveJSON("se-build", build); drawPlaced(); drawTotals(); drawPicker(); });
        row.appendChild(rm);
        placedList.appendChild(row);
      });
    }

    function drawTotals() {
      var reds = activeReductions();
      var resTotals = {}, totalTons = 0, workers = 0, powerNet = 0, days = 0;
      Object.keys(build.placed).forEach(function (id) {
        var it = byId[id], c = build.placed[id];
        if (it.kind === "fac") {
          var f = it.ref, m = buildCostMult(f, reds);
          (f.build_cost || []).forEach(function (b) {
            var amt = Math.round(b.amount * m) * c;
            resTotals[b.resource] = (resTotals[b.resource] || 0) + amt; totalTons += amt;
          });
          workers += (f.workers_required || 0) * crewMult(f, reds) * c;
          powerNet += ((f.energy_consumption || 0) - (f.power_production || 0) * powerMult(f, reds)) * c;
          days += (f.build_time_days || 0) * c;
        } else {
          totalTons += (it.ref.mass || 0) * c;
        }
      });
      var resIds = Object.keys(resTotals);
      if (!resIds.length && !Object.keys(build.placed).length) { totalsBox.innerHTML = '<p class="empty">Add items to see totals.</p>'; return; }
      // have/short columns appear only when a destination is chosen AND a save is loaded
      var showHave = !!(build.dest && SAVE);
      var html = '<table class="totals">';
      html += "<thead><tr><th>Resource</th><th class='num'>Need</th>" +
        (showHave ? "<th class='num'>Have</th><th class='num'>Short</th>" : "") + "</tr></thead><tbody>";
      resIds.sort(function (a, b) { return resName(a).localeCompare(resName(b)); }).forEach(function (rid) {
        var have = showHave ? Math.round((SAVE.stockpile && SAVE.stockpile[rid]) || 0) : null;
        var short = have != null ? Math.max(0, resTotals[rid] - have) : null;
        html += "<tr><td>" + resPip(rid, resTotals[rid]) + " " + esc(resName(rid)) + "</td><td class='num'>" + fmtInt(resTotals[rid]) + "</td>" +
          (showHave ? "<td class='num muted'>" + fmtInt(have) + "</td><td class='num'" + (short > 0 ? " style='color:var(--bad)'" : " style='color:var(--good)'") + ">" + (short > 0 ? fmtInt(short) : "✓") + "</td>" : "") + "</tr>";
      });
      html += "<tr class='grand'><td>Total tonnage</td><td class='num'>" + fmtInt(totalTons) + " t</td>" + (showHave ? "<td colspan='2'></td>" : "") + "</tr>";
      var ship = IDX.spacecraftById[shipSel.value];
      if (ship && ship.cargo_t > 0 && totalTons > 0) {
        html += "<tr><td>" + esc(ship.name) + " trips <span class='muted'>(" + fmtInt(ship.cargo_t) + " t)</span></td><td class='num'>" + Math.ceil(totalTons / ship.cargo_t).toLocaleString() + "</td>" + (showHave ? "<td colspan='2'></td>" : "") + "</tr>";
      }
      html += "</tbody><tbody>";
      if (workers > 0) html += "<tr><td>" + resPip("human", Math.round(workers)) + " Workers needed</td><td class='num'>" + fmtInt(workers) + (showHave ? " / " + fmtInt(SAVE.population) + " pop" : "") + "</td>" + (showHave ? "<td colspan='2'></td>" : "") + "</tr>";
      if (Math.round(powerNet) !== 0) html += "<tr><td>Net power " + (powerNet > 0 ? "<span style='color:var(--bad)'>(deficit)</span>" : "<span style='color:var(--good)'>(surplus)</span>") + "</td><td class='num'>" + fmtInt(powerNet) + "</td>" + (showHave ? "<td colspan='2'></td>" : "") + "</tr>";
      if (days > 0) html += "<tr><td>Build days <span class='muted'>(serial)</span></td><td class='num'>" + fmtInt(days) + "</td>" + (showHave ? "<td colspan='2'></td>" : "") + "</tr>";
      html += "</tbody></table>";
      totalsBox.innerHTML = html;
    }

    // Destination-aware extras: missing research warning + fleet logistics.
    // Mirrors the old Expansion Planner's result math exactly.
    function drawDest() {
      if (!build.dest) { destBox.style.display = "none"; destBox.innerHTML = ""; return; }
      destBox.style.display = "";
      var reds = activeReductions();
      var tons = 0, workers = 0, missing = [];
      Object.keys(build.placed).forEach(function (id) {
        var it = byId[id], c = build.placed[id];
        if (it.kind === "fac") {
          var f = it.ref, m = buildCostMult(f, reds);
          (f.build_cost || []).forEach(function (b) { tons += Math.round(b.amount * m) * c; });
          workers += (f.workers_required || 0) * crewMult(f, reds) * c;
          if (f.unlocked_by && f.unlocked_by.length && !f.unlocked_by.some(function (u) { return owned.has(u.id); }))
            missing.push({ fac: f.name, res: f.unlocked_by });
        } else { tons += (it.ref.mass || 0) * c; }
      });

      var html = "<h3>Destination <span class='muted' style='font-weight:400'>→ " + esc(build.dest) + "</span></h3>";
      if (!Object.keys(build.placed).length) { html += '<p class="empty">Add items above to see what you need to ship to ' + esc(build.dest) + ".</p>"; destBox.innerHTML = html; return; }
      if (missing.length) {
        html += '<div class="callout" style="border-color:var(--bad)">⚠ Missing research: ' +
          missing.map(function (x) { return "<b>" + esc(x.fac) + "</b> needs " + x.res.map(function (u) { return '<a href="#/planner" class="goto-plan" data-id="' + esc(u.id) + '">' + esc(u.name) + "</a>"; }).join(" or "); }).join("; ") + "</div>";
      }
      // logistics: trips/waves with your imported fleet, else a reference ship
      html += "<h4 style='margin:14px 0 6px'>Logistics</h4>";
      if (SAVE && SAVE.fleet && Object.keys(SAVE.fleet).length) {
        var fleetCargo = 0, lines = [];
        Object.keys(SAVE.fleet).forEach(function (sid) {
          var info = IDX.shipBySaveId[sid]; var cargo = info ? info.cargo : 0; var cnt = SAVE.fleet[sid];
          fleetCargo += cargo * cnt;
          lines.push(cnt + "× " + (info ? info.name : sid) + " (" + fmtInt(cargo) + "t)");
        });
        var waves = fleetCargo > 0 ? Math.ceil(tons / fleetCargo) : "—";
        html += "<p>Your fleet: " + esc(lines.join(", ")) + " = <b>" + fmtInt(fleetCargo) + " t</b> per wave → <b>" + waves + "</b> full wave(s) to move " + fmtInt(tons) + " t.</p>";
      } else {
        var big = DATA.spacecraft.filter(function (s) { return s.cargo_t; }).sort(function (a, b) { return b.cargo_t - a.cargo_t; })[0];
        if (big && tons > 0) html += "<p class='muted'>No fleet imported. Reference: a " + esc(big.name) + " carries " + fmtInt(big.cargo_t) + " t → " + Math.ceil(tons / big.cargo_t) + " trips. Import a save to use your real fleet.</p>";
      }
      destBox.innerHTML = html;
      destBox.querySelectorAll(".goto-plan").forEach(function (a) { a.addEventListener("click", function () { plannerTarget = { kind: "research", id: a.getAttribute("data-id") }; }); });
    }

    pf.addEventListener("input", drawPicker);
    shipSel.addEventListener("change", function () { build.ship = shipSel.value; saveJSON("se-build", build); drawTotals(); });
    destSel.addEventListener("change", function () { build.dest = destSel.value || null; saveJSON("se-build", build); drawTotals(); drawDest(); });
    placedPanel.querySelector("#clr").addEventListener("click", function () { build.placed = {}; saveJSON("se-build", build); refresh(); });
    redGrid.querySelectorAll(".red-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var id = cb.getAttribute("data-id");
        if (cb.checked) owned.add(id); else owned.delete(id);
        saveSet("se-owned", owned);
        drawPicker(); drawTotals(); drawDest();
      });
    });

    if (!build.ship && shipSel.options.length) { build.ship = shipSel.value; }
    drawPicker(); drawPlaced(); drawTotals(); drawDest();
  }

  // =========================================================================
  // FACILITIES (reference)
  // =========================================================================
  function viewFacilities(mount) {
    pageHeader(mount, "Facilities", "Ground buildings and orbital modules. Costs are base (before research discounts).");
    makeTable(mount, {
      rows: DATA.facilities, placeholder: "Filter facilities…",
      search: ["name", "category"], initialSort: "name",
      cols: [
        { key: "name", label: "Facility", cls: "namecell" },
        { key: "category", label: "Category", html: function (f) { return '<span class="badge cat">' + esc(f.category) + "</span>"; } },
        { key: "cost", label: "Build cost", get: function (f) { return (f.build_cost || []).reduce(function (s, b) { return s + b.amount; }, 0); }, html: function (f) { return costPips(f.build_cost); } },
        { key: "build_time_days", label: "Days", num: true, html: function (f) { return fmtInt(f.build_time_days); } },
        { key: "workers_required", label: "Workers", num: true, html: function (f) { return fmtInt(f.workers_required); } },
        { key: "power_production", label: "Power +", num: true, html: function (f) { return f.power_production ? fmtInt(f.power_production) : "—"; } },
        { key: "energy_consumption", label: "Power −", num: true, html: function (f) { return f.energy_consumption ? num(f.energy_consumption, 2) : "—"; } },
        { key: "unlock", label: "Unlocked by", get: function (f) { return (f.unlocked_by[0] || {}).name || "zzz"; }, html: function (f) {
            return f.unlocked_by.length ? f.unlocked_by.map(function (u) { return '<a href="#/planner" class="goto-plan" data-id="' + esc(u.id) + '">' + esc(u.name) + "</a>"; }).join(", ") : '<span class="muted">start</span>'; }, cls: "desccell" }
      ],
      afterDraw: function (w) { wirePlanLinks(w); applySearchJump(w, "facilities"); }
    });
  }
  function wirePlanLinks(w) {
    w.querySelectorAll(".goto-plan").forEach(function (a) {
      a.addEventListener("click", function () { plannerTarget = { kind: "research", id: a.getAttribute("data-id") }; });
    });
  }

  // =========================================================================
  // SPACECRAFT (reference)
  // =========================================================================
  function viewSpacecraft(mount) {
    pageHeader(mount, "Spacecraft", "Interplanetary craft. Cargo, fuel and exhaust velocity drive trip planning.");
    var showUnreleased = { v: false };
    var chip = el('<span class="chip">Show unreleased</span>');
    var holder = el("<div></div>"); mount.appendChild(holder);
    chip.addEventListener("click", function () { showUnreleased.v = !showUnreleased.v; chip.classList.toggle("on", showUnreleased.v); build2(); });
    function build2() {
      holder.innerHTML = "";
      makeTable(holder, {
        rows: DATA.spacecraft.filter(function (s) { return showUnreleased.v || s.released; }),
        placeholder: "Filter spacecraft…", search: ["name", "propulsion", "description"], initialSort: "cargo_t",
        extraControls: [chip], rowClass: function (s) { return s.released ? "" : "row-locked"; },
        cols: [
          { key: "name", label: "Spacecraft", cls: "namecell", html: function (s) { return esc(s.name) + lockBadge(!s.released); } },
          { key: "propulsion", label: "Propulsion", html: function (s) { return '<span class="badge cat">' + esc(s.propulsion) + "</span>"; } },
          { key: "cargo_t", label: "Cargo (t)", num: true, html: function (s) { return fmtInt(s.cargo_t); } },
          { key: "mass_t", label: "Dry (t)", num: true, html: function (s) { return fmtInt(s.mass_t); } },
          { key: "fuel_t", label: "Fuel (t)", num: true, html: function (s) { return fmtInt(s.fuel_t); } },
          { key: "exhaust_v", label: "Exhaust V", html: function (s) { return esc(s.exhaust_v || "—"); } },
          { key: "life_support", label: "Crew", html: function (s) { return esc(s.life_support); } },
          { key: "built_at", label: "Built at", html: function (s) { return esc(s.built_at); } },
          { key: "cost", label: "Build cost", get: function (s) { return (s.build_cost || []).reduce(function (a, b) { return a + b.amount; }, 0); }, html: function (s) { return costPips(s.build_cost); } },
          { key: "unlock", label: "Unlocked by", html: function (s) { return s.unlocked_by.length ? s.unlocked_by.map(function (u) { return '<a href="#/planner" class="goto-plan" data-id="' + esc(u.id) + '">' + esc(u.name) + "</a>"; }).join(", ") : '<span class="muted">start</span>'; }, cls: "desccell" }
        ],
        afterDraw: function (w) { wirePlanLinks(w); applySearchJump(w, "spacecraft"); }
      });
    }
    build2();
  }

  // =========================================================================
  // MODULES (reference)
  // =========================================================================
  function viewModules(mount) {
    pageHeader(mount, "Modules &amp; crew transports",
      "Spacecraft payload — shipped pre-assembled, so you pay their mass in cargo. Mining / refining / crew / probe roles included.");
    function minesPips(m) {
      if (!m.mines || !m.mines.length) return '<span class="muted">—</span>';
      return m.mines.map(function (r) { return '<img src="' + resIcon(r) + '" alt="" title="' + esc(resName(r)) + '" style="width:16px;height:16px;vertical-align:-3px;margin-right:2px">'; }).join("");
    }
    function nameCell(m) {
      var sub = (m.wiki_name && m.wiki_name !== m.name) ? '<br><span class="muted" style="font-size:11px">wiki: ' + esc(m.wiki_name) + "</span>" : "";
      return esc(m.name) + lockBadge(m.is_locked) + sub;
    }
    function costSum(m) { return (m.build_cost || []).reduce(function (s, b) { return s + (b.amount || 0); }, 0); }
    function days(m) { return m.build_time_days == null ? "—" : fmtInt(m.build_time_days); }
    var p1 = el('<div class="panel"><h3>Space modules</h3></div>'); mount.appendChild(p1);
    makeTable(p1, {
      rows: DATA.space_modules, placeholder: "Filter modules…", search: ["name", "category", "role", "description"], initialSort: "name",
      cols: [
        { key: "name", label: "Module", cls: "namecell", html: nameCell },
        { key: "role", label: "Role", html: function (m) { return m.role ? esc(m.role) : '<span class="muted">—</span>'; } },
        { key: "mines", label: "Mines", get: function (m) { return (m.mines || []).length; }, html: minesPips },
        { key: "mass", label: "Mass (t)", num: true, html: function (m) { return fmtInt(m.mass); } },
        { key: "cost", label: "Build cost", get: costSum, html: function (m) { return costPips(m.build_cost); } },
        { key: "build_time_days", label: "Days", num: true, html: days },
        { key: "description", label: "Notes", cls: "desccell", html: function (m) { return esc(m.description || ""); } }
      ]
    });
    var p2 = el('<div class="panel"><h3>Crew transports</h3></div>'); mount.appendChild(p2);
    makeTable(p2, {
      rows: DATA.crew_transports, placeholder: "Filter…", search: ["name", "description"], initialSort: "capacity",
      cols: [
        { key: "name", label: "Transport", cls: "namecell", html: nameCell },
        { key: "capacity", label: "Seats", num: true },
        { key: "mass", label: "Mass empty (t)", num: true, html: function (m) { return fmtInt(m.mass); } },
        { key: "cost", label: "Build cost", get: costSum, html: function (m) { return costPips(m.build_cost); } },
        { key: "build_time_days", label: "Days", num: true, html: days },
        { key: "description", label: "Notes", cls: "desccell", html: function (m) { return esc(m.description || ""); } }
      ]
    });
  }

  // =========================================================================
  // BODIES (reference, sub-tabs)
  // =========================================================================
  function viewBodies(mount) {
    pageHeader(mount, "Celestial bodies", "Planets, moons, asteroids, comets and exoplanet systems — orbital and physical data.");
    var subs = ["Planets", "Moons", "Asteroids", "Asteroid types", "Comets", "Exoplanets"];
    var bar = el('<div class="subtabs"></div>');
    var holder = el("<div></div>");
    var cur = "Planets";
    subs.forEach(function (s) {
      var b = el("<button" + (s === cur ? ' class="on"' : "") + ">" + s + "</button>");
      b.addEventListener("click", function () { cur = s; bar.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on"); drawSub(); });
      bar.appendChild(b);
    });
    mount.appendChild(bar); mount.appendChild(holder);

    function drawSub() {
      holder.innerHTML = "";
      if (cur === "Asteroid types") {
        (DATA.asteroid_taxonomy || []).forEach(function (t) {
          var pn = el('<div class="panel"><h3>' + esc(t.name) + "</h3></div>");
          if (t.description) pn.appendChild(el('<p class="page-sub">' + esc(t.description) + "</p>"));
          var yr = (t.yields || []).map(function (y) { return "<tr><td>" + esc(y.tier) + "</td><td>" + esc(y.resource) + '</td><td class="num">' + esc(y.probability) + "</td></tr>"; }).join("");
          pn.appendChild(el('<div class="tbl-wrap"><table class="data"><thead><tr><th>Tier</th><th>Resource</th><th class="num">Probability</th></tr></thead><tbody>' + yr + "</tbody></table></div>"));
          holder.appendChild(pn);
        });
        return;
      }
      if (cur === "Planets") makeTable(holder, { rows: DATA.planets, placeholder: "Filter…", search: ["name"], initialSort: "semi_major_au", cols: [
        { key: "name", label: "Planet", cls: "namecell" },
        { key: "mass_e24kg", label: "Mass (×10²⁴kg)", num: true, html: c("mass_e24kg") },
        { key: "radius_km", label: "Radius (km)", num: true, html: c("radius_km") },
        { key: "semi_major_au", label: "Axis (AU)", num: true, html: c("semi_major_au") },
        { key: "eccentricity", label: "Ecc.", num: true, html: c("eccentricity") },
        { key: "inclination_deg", label: "Incl. (°)", num: true, html: c("inclination_deg") },
        { key: "moons", label: "Moons" }
      ] });
      else if (cur === "Moons") makeTable(holder, { rows: DATA.moons, placeholder: "Filter… (try 'Jupiter')", search: ["name", "parent"], initialSort: "name", cols: [
        { key: "name", label: "Moon", cls: "namecell" },
        { key: "parent", label: "Parent", html: function (m) { return '<span class="badge cat">' + esc(m.parent) + "</span>"; } },
        { key: "mass_e24kg", label: "Mass (×10²⁴kg)", num: true, html: c("mass_e24kg") },
        { key: "distance_km", label: "Distance (km)", num: true, html: c("distance_km") },
        { key: "eccentricity", label: "Ecc.", num: true, html: c("eccentricity") },
        { key: "inclination_deg", label: "Incl. (°)", num: true, html: c("inclination_deg") }
      ] });
      else if (cur === "Asteroids") makeTable(holder, { rows: DATA.asteroids, placeholder: "Filter… (try 'NEO')", search: ["name", "region"], initialSort: "semi_major_au", cols: [
        { key: "name", label: "Asteroid", cls: "namecell" },
        { key: "region", label: "Region", cls: "desccell", html: function (a) { return '<span class="badge cat">' + esc(a.region) + "</span>"; } },
        { key: "radius_km", label: "Radius (km)", num: true, html: c("radius_km") },
        { key: "semi_major_au", label: "Axis (AU)", num: true, html: c("semi_major_au") },
        { key: "eccentricity", label: "Ecc.", num: true, html: c("eccentricity") },
        { key: "inclination_deg", label: "Incl. (°)", num: true, html: c("inclination_deg") }
      ] });
      else if (cur === "Comets") makeTable(holder, { rows: DATA.comets, placeholder: "Filter…", search: ["name"], initialSort: "name", cols: [
        { key: "name", label: "Comet", cls: "namecell" },
        { key: "radius_km", label: "Radius (km)", num: true, html: c("radius_km") },
        { key: "semi_major_au", label: "Axis (AU)", num: true, html: c("semi_major_au") },
        { key: "eccentricity", label: "Ecc.", num: true, html: c("eccentricity") },
        { key: "inclination_deg", label: "Incl. (°)", num: true, html: c("inclination_deg") }
      ] });
      else makeTable(holder, { rows: DATA.exoplanets, placeholder: "Filter… (try a system)", search: ["name", "system", "type"], initialSort: "system", cols: [
        { key: "system", label: "System", html: function (e) { return '<span class="badge cat">' + esc(e.system) + "</span>"; } },
        { key: "name", label: "Body", cls: "namecell" },
        { key: "type", label: "Type" },
        { key: "semi_major_au", label: "Axis (AU)", num: true, html: c("semi_major_au") },
        { key: "mass_e24kg", label: "Mass (×10²⁴kg)", num: true, html: c("mass_e24kg") },
        { key: "radius_km", label: "Radius (km)", num: true, html: c("radius_km") }
      ] });
    }
    function c(k) { return function (r) { return num(r[k]); }; }
    drawSub();
  }

  // =========================================================================
  // TERRAFORMING (reference + habitability lookup)
  // =========================================================================
  function viewTerraform(mount) {
    pageHeader(mount, "Terraforming",
      "Simulate a body's climate with the game's real physics (Stefan-Boltzmann + greenhouse), or use the habitability buckets below.");
    if (typeof TerraSim !== "undefined") buildClimateSim(mount);

    var tf = DATA.terraforming;

    // habitability lookup
    var look = el('<div class="panel"><h3>Habitability lookup</h3></div>');
    var ctr = el('<div class="controls"></div>');
    ctr.innerHTML =
      '<label class="check">Temp (°C): <input type="number" id="hab-t" value="15" style="width:90px"></label>' +
      '<label class="check">Pressure (atm): <input type="number" id="hab-p" value="1" step="0.1" style="width:90px"></label>' +
      '<label class="check">Gravity (m/s²): <input type="number" id="hab-g" value="9.8" step="0.1" style="width:90px"></label>';
    look.appendChild(ctr);
    var habOut = el("<div></div>"); look.appendChild(habOut);
    mount.appendChild(look);

    function bucketFor(kind, v) {
      // Buckets share boundaries (one's high == next's low); resolve an exact
      // boundary value to the higher bucket by taking the last bucket whose
      // low <= v. (So Earth's 9.8 m/s² reads as Standard Gravity, not Low.)
      var bs = tf.buckets[kind] || [];
      if (!bs.length || isNaN(v)) return null;
      var pick = bs[0];
      for (var i = 0; i < bs.length; i++) { if (v >= bs[i].low) pick = bs[i]; }
      return pick;
    }
    function drawHab() {
      var t = parseFloat(document.getElementById("hab-t").value);
      var p = parseFloat(document.getElementById("hab-p").value);
      var g = parseFloat(document.getElementById("hab-g").value);
      var bt = bucketFor("temperature", t), bp = bucketFor("atmosphere", p), bg = bucketFor("gravity", g);
      function line(lbl, b) {
        if (!b) return "";
        var col = b.score >= 80 ? "var(--good)" : b.score >= 40 ? "var(--warn)" : "var(--bad)";
        return "<tr><td>" + lbl + "</td><td><b>" + esc(b.label) + "</b></td><td class='num' style='color:" + col + "'>" + b.score + "</td></tr>";
      }
      var avg = [bt, bp, bg].filter(Boolean).reduce(function (s, b) { return s + b.score; }, 0) / 3;
      habOut.innerHTML = "<table class='totals'><tbody>" +
        line("🌡️ Temperature", bt) + line("💨 Atmosphere", bp) + line("⚖️ Gravity", bg) +
        "<tr class='grand'><td colspan='2'>Mean axis score</td><td class='num'>" + Math.round(avg) + "</td></tr>" +
        "</tbody></table><p class='page-sub'>Note: radiation/magnetic field is the 4th in-game axis (improved by magnetosphere generators) and isn't included here.</p>";
    }
    ["hab-t", "hab-p", "hab-g"].forEach(function (id) { ctr.querySelector("#" + id).addEventListener("input", drawHab); });
    drawHab();

    // thermal constants table
    var th = el('<div class="panel"><h3>Resource thermal properties</h3></div>'); mount.appendChild(th);
    makeTable(th, {
      rows: tf.thermal, placeholder: "Filter resources…", search: ["resource"], initialSort: "boiling_k",
      cols: [
        { key: "resource", label: "Resource", cls: "namecell", html: function (r) { return (r.icon ? '<img src="' + resIcon(r.icon) + '" style="width:15px;vertical-align:-2px"> ' : "") + esc(r.resource); } },
        { key: "melting_k", label: "Melting (K)", num: true, html: function (r) { return num(r.melting_k); } },
        { key: "boiling_k", label: "Boiling (K)", num: true, html: function (r) { return num(r.boiling_k); } },
        { key: "latent_heat_j_mol", label: "Latent heat (J/mol)", num: true, html: function (r) { return fmtInt(r.latent_heat_j_mol); } },
        { key: "heat_capacity_j_kgk", label: "Heat cap. (J/kg·K)", num: true, html: function (r) { return fmtInt(r.heat_capacity_j_kgk); } },
        { key: "optical_depth", label: "Optical depth", num: true, html: function (r) { return num(r.optical_depth); } },
        { key: "triple_point_atm", label: "Triple-pt (atm)", num: true, html: function (r) { return num(r.triple_point_atm); } }
      ]
    });

    // bucket reference tables
    var bp = el('<div class="panel"><h3>Habitability bucket ranges</h3></div>');
    ["temperature", "atmosphere", "gravity"].forEach(function (kind) {
      var unit = kind === "temperature" ? "°C" : kind === "atmosphere" ? "atm" : "m/s²";
      var rows = (tf.buckets[kind] || []).map(function (b) {
        return "<tr><td>" + esc(b.label) + "</td><td class='num'>" + num(b.low) + "</td><td class='num'>" + num(b.high) + "</td><td class='num'>" + b.score + "</td></tr>";
      }).join("");
      bp.appendChild(el("<h4 style='margin:14px 0 6px;text-transform:capitalize'>" + kind + " (" + unit + ")</h4>" +
        "<div class='tbl-wrap'><table class='data'><thead><tr><th>Bucket</th><th class='num'>Low</th><th class='num'>High</th><th class='num'>Score</th></tr></thead><tbody>" + rows + "</tbody></table></div>"));
    });
    mount.appendChild(bp);

    // terraforming facilities
    var fp = el('<div class="panel"><h3>Terraforming facilities</h3></div>');
    fp.appendChild(el("<p class='page-sub'>Per-day habitability deltas applied while running.</p>"));
    tf.facilities.forEach(function (f) {
      var d = Object.keys(f.deltas).map(function (k) { return k + " " + (f.deltas[k] > 0 ? "+" : "") + f.deltas[k]; }).join(" · ");
      fp.appendChild(el("<div class='placed-row'><span class='pname'>" + esc(f.name) + "</span><span class='muted'>" + esc(d) + "</span></div>"));
    });
    mount.appendChild(fp);
  }

  // =========================================================================
  // TERRAFORMING CLIMATE SIM (TerraSim) — game-accurate physics
  // =========================================================================
  function buildClimateSim(mount) {
    var bodies = DATA.planets.filter(function (p) { return TerraSim.PLANETS_BY_NAME[p.name.toUpperCase()]; });
    if (!bodies.length) return;
    var st = loadJSON("se-terra", {});
    var panel = el('<div class="panel"><h3>Climate simulator</h3></div>');
    panel.appendChild(el('<p class="page-sub">Pick a body, set its atmosphere (kilotonnes of gas) and add mirrors/shades. Temperature uses the game\'s Stefan-Boltzmann + greenhouse model; habitability is the in-game weighted score (−100…100).</p>'));
    var ctr = el('<div class="controls"></div>');
    var bodySel = el('<select style="min-width:140px">' + bodies.map(function (b) { return "<option" + (b.name === (st.body || "Mars") ? " selected" : "") + ">" + esc(b.name) + "</option>"; }).join("") + "</select>");
    ctr.appendChild(el('<label class="check">Body</label>')); ctr.appendChild(bodySel);
    ctr.appendChild(el('<label class="check">Mirrors <input type="number" id="ts-mir" min="0" value="' + (st.mirrors || 0) + '" style="width:70px"></label>'));
    ctr.appendChild(el('<label class="check">in orbit <select id="ts-mir-orb">' + TerraSim.MIRROR_ORBITS.map(function (o, i) { return '<option value="' + i + '"' + (i === (st.mirrorOrbit != null ? st.mirrorOrbit : 4) ? " selected" : "") + ">" + esc(o.name) + "</option>"; }).join("") + "</select></label>"));
    ctr.appendChild(el('<label class="check">Shades <input type="number" id="ts-shd" min="0" value="' + (st.shades || 0) + '" style="width:70px"></label>'));
    panel.appendChild(ctr);
    var GASES = ["nitrogen", "oxygen", "co2", "water", "noblegas", "hydrogen"];
    var atmCtr = el('<div class="controls"></div>');
    GASES.forEach(function (id) {
      var rn = TerraSim.RES_BY_ID[id] ? TerraSim.RES_BY_ID[id].name : id;
      var v = (st.gas && st.gas[id]) || 0;
      atmCtr.appendChild(el('<label class="check">' + esc(rn) + ' (kt) <input type="number" class="ts-gas" data-res="' + id + '" min="0" value="' + v + '" style="width:90px"></label>'));
    });
    panel.appendChild(atmCtr);
    var prefill = el('<div class="muted" style="font-size:12px;margin:4px 0"></div>'); panel.appendChild(prefill);
    var out = el("<div></div>"); panel.appendChild(out);
    mount.appendChild(panel);
    function readAtm() { var a = {}; atmCtr.querySelectorAll(".ts-gas").forEach(function (inp) { var v = parseFloat(inp.value) || 0; if (v > 0) a[inp.getAttribute("data-res")] = v; }); return a; }
    function draw() {
      var name = bodySel.value, atm = readAtm();
      var iv = { mirrors: parseFloat(document.getElementById("ts-mir").value) || 0, mirrorOrbitIndex: parseInt(document.getElementById("ts-mir-orb").value, 10), shades: parseFloat(document.getElementById("ts-shd").value) || 0 };
      saveJSON("se-terra", { body: name, gas: atm, mirrors: iv.mirrors, mirrorOrbit: iv.mirrorOrbitIndex, shades: iv.shades });
      var body = bodies.filter(function (b) { return b.name === name; })[0];
      var phys = TerraSim.PLANETS_BY_NAME[name.toUpperCase()];
      if (phys) prefill.innerHTML = "Prefilled from physics: albedo " + num(phys.albedo, 2) + " · gravity " + num(phys.computedGravity, 2) + " m/s² · " + num(phys.distanceAU, 3) + " AU · internal flux " + num(phys.internalFlux, 2) + " W/m²";
      out.innerHTML = "";
      var r;
      try { r = TerraSim.equilibrium(body, atm, iv); } catch (e) { r = { error: e.message }; }
      if (!r || r.error) { out.appendChild(el('<div class="callout">' + esc((r && r.error) || "Could not simulate.") + "</div>")); return; }
      renderClimate(out, r);
    }
    bodySel.addEventListener("change", draw);
    ["ts-mir", "ts-mir-orb", "ts-shd"].forEach(function (id) { panel.querySelector("#" + id).addEventListener("input", draw); });
    atmCtr.querySelectorAll(".ts-gas").forEach(function (inp) { inp.addEventListener("input", draw); });
    draw();
  }
  function renderClimate(out, r) {
    var conv = r.converged ? "" : ' <span class="muted">(did not converge in ' + r.ticks + ' ticks)</span>';
    out.appendChild(el('<div class="cols">' +
      '<div><h4 style="margin:0 0 6px">🌡️ Temperature</h4><p><b>' + num(r.temperatureC, 1) + " °C</b> (" + num(r.temperatureK, 1) + " K)" + conv + "</p>" +
      '<p class="muted">Swing ±' + num(r.swings, 1) + " K · airless eq. " + num(r.equilibriumTempC, 1) + " °C</p></div>" +
      '<div><h4 style="margin:0 0 6px">💨 Pressure &amp; air</h4><p><b>' + num(r.pressureAtm, 3) + " atm</b></p>" +
      '<p class="muted">O₂ mass fraction ' + num((r.oxygenMassFrac || 0) * 100, 1) + "%</p></div>" +
      '<div><h4 style="margin:0 0 6px">🌍 Habitability</h4><p><b>' + num(r.habitability, 1) + "</b> / 100</p></div>" +
      "</div>"));
    var ids = Object.keys(r.phaseByResource || {});
    if (ids.length) {
      var rows = ids.map(function (id) {
        var p = r.phaseByResource[id];
        var col = p.dominant === "gas" ? "var(--warn)" : p.dominant === "liquid" ? "var(--good)" : "var(--accent)";
        var lbl = p.dominant.charAt(0).toUpperCase() + p.dominant.slice(1);
        return "<tr><td>" + esc(p.name) + '</td><td style="color:' + col + '"><b>' + lbl + "</b></td><td class=\"num\">" + num(p.gasFrac * 100, 0) + "%</td><td class=\"num\">" + num(p.liquidFrac * 100, 0) + "%</td><td class=\"num\">" + num(p.solidFrac * 100, 0) + "%</td></tr>";
      }).join("");
      out.appendChild(el('<div class="tbl-wrap"><table class="data"><thead><tr><th>Resource</th><th>Phase</th><th class="num">Gas</th><th class="num">Liquid</th><th class="num">Solid</th></tr></thead><tbody>' + rows + "</tbody></table></div>"));
    }
    out.appendChild(el('<p class="muted" style="font-size:12px;margin:8px 0 0">Game-accurate model: atmosphere is in game-scale kilotonnes (~11,000 kt ≈ 1 atm on Earth); the greenhouse term has no saturation, so very thick atmospheres run hot. Airless equilibrium is the textbook blackbody temperature.</p>'));
  }

  // =========================================================================
  // RESOURCES (reference)
  // =========================================================================
  function viewResources(mount) {
    pageHeader(mount, "Resources",
      "Every resource — market price, Earth export license, and which facilities produce or consume it (the supply chain). " +
      'For colony power balance, the <a href="#/facilities">Facilities</a> tab has Power + / Power − per building. Thermal/phase data is on the Terraforming tab.');
    function money(n) { return n == null ? "—" : "$" + num(n); }
    makeTable(mount, {
      rows: DATA.resources, placeholder: "Filter resources…", search: ["name", "type", "id"], initialSort: "name",
      cols: [
        { key: "name", label: "Resource", cls: "namecell", html: function (r) {
            return '<img src="' + resIcon(r.id) + '" alt="" style="width:20px;height:20px;vertical-align:-5px;margin-right:6px">' + esc(r.name); } },
        { key: "type", label: "Type", html: function (r) { return '<span class="badge cat">' + esc(r.type || "—") + "</span>"; } },
        { key: "market_base", label: "Market ($/t)", num: true, html: function (r) { return money(r.market_base); } },
        { key: "license", label: "Earth license ($/t)", num: true, html: function (r) { return money(r.license); } },
        { key: "producers", label: "Produced by", cls: "desccell", get: function (r) { return (r.producers || []).length; },
          html: function (r) { return (r.producers && r.producers.length) ? esc(r.producers.join(", ")) : '<span class="muted">—</span>'; } },
        { key: "consumers", label: "Consumed by", cls: "desccell", get: function (r) { return (r.consumers || []).length; },
          html: function (r) { return (r.consumers && r.consumers.length) ? esc(r.consumers.join(", ")) : '<span class="muted">—</span>'; } },
        { key: "description", label: "Notes", cls: "desccell", html: function (r) { return esc(r.description || ""); } }
      ]
    });
  }

  // =========================================================================
  // LAUNCH VEHICLES + launch methods (reference)
  // =========================================================================
  function viewLaunchVehicles(mount) {
    pageHeader(mount, "Launch vehicles", "Getting mass off a body: payload, reuse, crew capability, build cost, and per-launch cost.");
    var p1 = el('<div class="panel"><h3>Launch vehicles</h3></div>'); mount.appendChild(p1);
    makeTable(p1, {
      rows: DATA.launch_vehicles, placeholder: "Filter launch vehicles…", search: ["name", "description", "reusable"],
      initialSort: "payload_t", initialAsc: false,
      cols: [
        { key: "name", label: "Vehicle", cls: "namecell" },
        { key: "payload_t", label: "Payload (t)", num: true, html: function (v) { return fmtInt(v.payload_t); } },
        { key: "reusable", label: "Reusable" },
        { key: "crew", label: "Crew" },
        { key: "max_g", label: "Max G" },
        { key: "cost", label: "Build cost", get: function (v) { return (v.build_cost || []).reduce(function (s, b) { return s + (b.amount || 0); }, 0); }, html: function (v) { return costPips(v.build_cost); } },
        { key: "build_time_days", label: "Days", num: true, html: function (v) { return fmtInt(v.build_time_days); } },
        { key: "launch_cost", label: "Launch ($)", num: true, html: function (v) { return v.launch_cost == null ? "—" : "$" + fmtInt(v.launch_cost); } },
        { key: "maint_per_mo", label: "Upkeep ($/mo)", num: true, html: function (v) { return v.maint_per_mo == null ? "—" : "$" + fmtInt(v.maint_per_mo); } },
        { key: "description", label: "Notes", cls: "desccell", html: function (v) { return esc(v.description || ""); } }
      ],
      afterDraw: function (w) { applySearchJump(w, "launchvehicles"); }
    });
    if ((DATA.launch_methods || []).length) {
      var p2 = el('<div class="panel"><h3>Launch methods &amp; infrastructure</h3></div>'); mount.appendChild(p2);
      p2.appendChild(el('<p class="page-sub">Reusable launch infrastructure (space elevators, mass drivers…) that lowers launch cost.</p>'));
      makeTable(p2, {
        rows: DATA.launch_methods, placeholder: "Filter…", search: ["name", "description", "launch_bonus"], initialSort: "name",
        cols: [
          { key: "name", label: "Method", cls: "namecell" },
          { key: "launch_bonus", label: "Launch bonus" },
          { key: "cost", label: "Build cost", get: function (m) { return (m.build_cost || []).reduce(function (s, b) { return s + (b.amount || 0); }, 0); }, html: function (m) { return costPips(m.build_cost); } },
          { key: "build_time_days", label: "Days", num: true, html: function (m) { return fmtInt(m.build_time_days); } },
          { key: "workers", label: "Workers", num: true, html: function (m) { return m.workers == null ? "—" : fmtInt(m.workers); } },
          { key: "maint_per_mo", label: "Upkeep ($/mo)", num: true, html: function (m) { return m.maint_per_mo == null ? "—" : "$" + fmtInt(m.maint_per_mo); } },
          { key: "prereq", label: "Prereq", cls: "desccell", html: function (m) { return esc(m.prereq || "—"); } },
          { key: "description", label: "Notes", cls: "desccell", html: function (m) { return esc(m.description || ""); } }
        ]
      });
    }
  }

  // =========================================================================
  // PROGRESSION: contracts, achievements, corporations (reference, sub-tabs)
  // =========================================================================
  function viewProgression(mount) {
    pageHeader(mount, "Progression", "Story contracts, achievements, and which corporations each scenario lets you play.");
    var subs = ["Contracts", "Achievements", "Corporations"];
    var bar = el('<div class="subtabs"></div>');
    var holder = el("<div></div>");
    var cur = "Contracts";
    subs.forEach(function (s) {
      var b = el("<button" + (s === cur ? ' class="on"' : "") + ">" + s + "</button>");
      b.addEventListener("click", function () { cur = s; bar.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on"); drawSub(); });
      bar.appendChild(b);
    });
    mount.appendChild(bar); mount.appendChild(holder);
    function list(arr) { return (arr && arr.length) ? arr.map(esc).join("<br>") : '<span class="muted">—</span>'; }
    function drawSub() {
      holder.innerHTML = "";
      if (cur === "Contracts") makeTable(holder, {
        rows: DATA.contracts, placeholder: "Filter contracts…", search: ["name", "premise", "prereq"], initialSort: "order",
        cols: [
          { key: "order", label: "#", num: true },
          { key: "name", label: "Contract", cls: "namecell" },
          { key: "prereq", label: "After", html: function (c) { return esc(c.prereq || "—"); } },
          { key: "requirements", label: "Requirements", cls: "desccell", get: function (c) { return (c.requirements || []).length; }, html: function (c) { return list(c.requirements); } },
          { key: "rewards", label: "Rewards", cls: "desccell", get: function (c) { return (c.rewards || []).length; }, html: function (c) { return list(c.rewards); } },
          { key: "premise", label: "Premise", cls: "desccell", html: function (c) { return esc(c.premise || ""); } }
        ]
      });
      else if (cur === "Achievements") makeTable(holder, {
        rows: DATA.achievements, placeholder: "Filter achievements…", search: ["name", "earn_via", "trigger"], initialSort: "name",
        cols: [
          { key: "name", label: "Achievement", cls: "namecell" },
          { key: "earn_via", label: "Earn via", cls: "desccell", html: function (a) { return esc(a.earn_via || a.trigger || "—"); } },
          { key: "condition", label: "Condition", cls: "desccell", html: function (a) { return esc(a.condition || "—"); } }
        ]
      });
      else {
        var p = el('<div class="panel"><h3>Playable corporations by scenario</h3></div>');
        (DATA.corporations || []).forEach(function (c) {
          p.appendChild(el('<div class="placed-row"><span class="pname">' + esc(c.scenario) + '</span><span class="muted">' + esc((c.corporations || []).join(", ")) + "</span></div>"));
        });
        holder.appendChild(p);
      }
    }
    drawSub();
  }

  // =========================================================================
  // SAVE IMPORT
  // =========================================================================
  function isGzip(buf) { var b = new Uint8Array(buf); return b[0] === 0x1f && b[1] === 0x8b; }
  function readSaveFile(file) {
    return file.arrayBuffer().then(function (buf) {
      if (/\.gz$/i.test(file.name) || isGzip(buf)) {
        var stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
        return new Response(stream).text();
      }
      return new TextDecoder().decode(buf);
    });
  }
  function extractPlayer(save) {
    if (!save || !save.companyDataSave) throw new Error("Not a Solar Expanse save");
    var ai = {};
    (save.companyAISave || []).forEach(function (a) { if (a.IDCompany) ai[a.IDCompany.id] = true; });
    var comps = save.companyDataSave;
    var player = comps.find(function (c) { return c.companyID && !ai[c.companyID.id]; })
      || comps.find(function (c) { return typeof c.money === "number" && c.companyID && c.companyID.id !== "WorldGovernment"; })
      || comps[0];
    var research = (((player.researchDataToSave || {}).completeResearch) || [])
      .map(function (e) { return e && e.id; }).filter(Boolean)
      .map(function (id) { return "research-" + id.replace(/_/g, "-"); });
    var stock = {};
    (save.objectInfoDatas || []).forEach(function (od) {
      if (!od.companyId || od.companyId.id !== player.companyID.id) return;
      (od.listRowResourcesData || []).forEach(function (row) {
        var rid = ((row.resourceTypeIDSave || {}).id || "").replace("id_resource_", "");
        if (rid && row.value) stock[rid] = (stock[rid] || 0) + row.value;
      });
    });
    var fleet = {};
    (player.spacecrafts || []).forEach(function (s) {
      var t = (s.spacecraftType || "").replace("SpacecraftType/", "");
      if (t) fleet[t] = (fleet[t] || 0) + 1;
    });
    return { company: player.companyID.id, money: player.money, research: research,
      stockpile: stock, fleet: fleet, population: Math.round(stock.human || 0) };
  }
  function doImport(file, status) {
    status.textContent = "reading…";
    readSaveFile(file).then(function (text) {
      var p = extractPlayer(parseSolarExpanseSave(text));
      owned = new Set(p.research); saveSet("se-owned", owned);
      SAVE = { company: p.company, money: p.money, stockpile: p.stockpile, fleet: p.fleet,
        population: p.population, researchCount: p.research.length, at: Date.now() };
      saveJSON("se-save", SAVE);
      refreshStatus(); render();
    }).catch(function (e) { status.innerHTML = '<span style="color:var(--bad)">⚠ ' + esc(e.message) + "</span>"; });
  }
  function clearSave() { SAVE = null; try { localStorage.removeItem("se-save"); } catch (e) {} refreshStatus(); render(); }
  function refreshStatus() {
    var s = document.querySelector(".import-status");
    if (!s) return;
    if (SAVE) {
      s.innerHTML = '<span style="color:var(--good)">✓ ' + esc(SAVE.company) + "</span> · " +
        SAVE.researchCount + " techs · " + fmtInt(SAVE.population) + " pop " +
        '<button class="chip" id="clear-save">clear</button>';
      var c = document.getElementById("clear-save"); if (c) c.addEventListener("click", clearSave);
    } else { s.innerHTML = '<span class="muted">no save imported</span>'; }
  }
  function setupImportBar() {
    var header = document.querySelector(".topbar");
    var bar = el('<div class="importbar"></div>');
    var btn = el('<button class="btn ghost" id="import-btn" title="Import a Solar Expanse save (.gz or .json) — or drag the file anywhere onto the page">📁 Import save</button>');
    var inp = el('<input type="file" accept=".gz,.json" style="display:none">');
    var status = el('<span class="import-status"></span>');
    bar.appendChild(btn); bar.appendChild(status); bar.appendChild(inp);
    header.appendChild(bar);
    btn.addEventListener("click", function () { inp.click(); });
    inp.addEventListener("change", function () { if (inp.files[0]) { doImport(inp.files[0], status); inp.value = ""; } });
    setupDragDrop(status);
    refreshStatus();
  }
  // Drop a save file anywhere on the page to import it (same pipeline as the button).
  function setupDragDrop(status) {
    var overlay = el(
      '<div class="dropzone" aria-hidden="true">' +
        '<div class="dropzone-card">' +
          '<div class="dropzone-icon">📁</div>' +
          '<div class="dropzone-title">Drop your save to import</div>' +
          '<div class="dropzone-sub">a Solar Expanse <b>.gz</b> (or .json) save file</div>' +
        '</div>' +
      '</div>');
    document.body.appendChild(overlay);
    var depth = 0;
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      return !!t && Array.prototype.indexOf.call(t, "Files") !== -1;
    }
    function hide() { depth = 0; overlay.classList.remove("show"); }
    window.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth++; overlay.classList.add("show");
    });
    window.addEventListener("dragover", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
    });
    window.addEventListener("dragleave", function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) hide();
    });
    window.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); hide();
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) doImport(f, status);
    });
  }

  // =========================================================================
  // ECONOMY — RETIRED (Phase 2). No longer in the nav or routed to: #/economy
  // now lands on Resources (which already lists per-resource producers/consumers)
  // and Facilities (which already shows Power+/Power−). Kept here, unreferenced,
  // only so no data/logic is lost; safe to delete in a later cleanup.
  // =========================================================================
  function viewEconomy(mount) {
    pageHeader(mount, "Economy",
      "Plan a colony's power and supply chains. The public data gives exact power and which facility makes/uses each resource — but <b>not</b> per-resource throughput rates, so this shows the production web, not tonnes/day. (For live throughput, import a save into the Expansion Planner.)");
    var pwr = el('<div class="panel"><h3>Power</h3></div>');
    pwr.appendChild(el('<p class="page-sub">Generators (power out) and loads (power in). Balance a colony so generation ≥ consumption.</p>'));
    var pwrRows = DATA.facilities.filter(function (f) { return (f.power_production || 0) > 0 || (f.energy_consumption || 0) > 0; });
    makeTable(pwr, {
      rows: pwrRows, placeholder: "Filter facilities…", search: ["name", "category"], initialSort: "power_production", initialAsc: false,
      cols: [
        { key: "name", label: "Facility", cls: "namecell" },
        { key: "category", label: "Category", html: function (f) { return '<span class="badge cat">' + esc(f.category) + "</span>"; } },
        { key: "power_production", label: "Power +", num: true, html: function (f) { return f.power_production ? fmtInt(f.power_production) : "—"; } },
        { key: "energy_consumption", label: "Power −", num: true, html: function (f) { return f.energy_consumption ? num(f.energy_consumption, 2) : "—"; } },
        { key: "workers_required", label: "Workers", num: true, html: function (f) { return fmtInt(f.workers_required); } }
      ]
    });
    mount.appendChild(pwr);
    var sc = el('<div class="panel"><h3>Supply chains</h3></div>');
    sc.appendChild(el('<p class="page-sub">For each resource: which facilities produce it, and which consume it.</p>'));
    makeTable(sc, {
      rows: DATA.resources, placeholder: "Filter resources…", search: ["name", "type"], initialSort: "name",
      cols: [
        { key: "name", label: "Resource", cls: "namecell", html: function (r) { return '<img src="' + resIcon(r.id) + '" alt="" style="width:18px;height:18px;vertical-align:-4px;margin-right:6px">' + esc(r.name); } },
        { key: "producers", label: "Produced by", cls: "desccell", get: function (r) { return (r.producers || []).length; }, html: function (r) { return (r.producers && r.producers.length) ? esc(r.producers.join(", ")) : '<span class="muted">— (mined / imported)</span>'; } },
        { key: "consumers", label: "Consumed by", cls: "desccell", get: function (r) { return (r.consumers || []).length; }, html: function (r) { return (r.consumers && r.consumers.length) ? esc(r.consumers.join(", ")) : '<span class="muted">—</span>'; } }
      ]
    });
    mount.appendChild(sc);
  }

  // =========================================================================
  // TRIP PLANNER — launch window + cruise time + delta-v (uses TripMath)
  // =========================================================================
  function viewTrip(mount) {
    pageHeader(mount, "Trip planner",
      "Pick where you are and where you're heading — get the next launch window, the one-way cruise time, and the delta-v budget. Heliocentric Hohmann estimate; see the notes under each result.");
    if (typeof TripMath === "undefined") { mount.appendChild(el('<div class="callout">Trip math module failed to load.</div>')); return; }

    var planetsByName = {}; DATA.planets.forEach(function (p) { planetsByName[p.name] = p; });
    var groups = [
      { kind: "planet", label: "Planets", rows: DATA.planets, lbl: function (b) { return b.name; } },
      { kind: "moon", label: "Moons", rows: DATA.moons, lbl: function (b) { return b.name + " (" + b.parent + ")"; } },
      { kind: "asteroid", label: "Asteroids", rows: DATA.asteroids, lbl: function (b) { return b.name; } },
      { kind: "comet", label: "Comets", rows: DATA.comets, lbl: function (b) { return b.name; } }
    ];
    function optionsHtml(sel) {
      return groups.map(function (g) {
        var opts = g.rows.slice()
          .filter(function (b) { return TripMath.isTransferComputable(b, g.kind, planetsByName); })
          .map(function (b) {
            var v = g.kind + "|" + b.name;
            return '<option value="' + esc(v) + '"' + (v === sel ? " selected" : "") + ">" + esc(g.lbl(b)) + "</option>";
          }).join("");
        return '<optgroup label="' + esc(g.label) + '">' + opts + "</optgroup>";
      }).join("");
    }
    function resolve(v) {
      if (!v) return null;
      var i = v.indexOf("|"), kind = v.slice(0, i), nm = v.slice(i + 1);
      var g = groups.filter(function (x) { return x.kind === kind; })[0]; if (!g) return null;
      var b = g.rows.filter(function (r) { return r.name === nm; })[0];
      return b ? { body: b, kind: kind } : null;
    }
    function bodyLongitudeDeg(spec) {
      if (!spec || !window.BODY_LONGITUDES) return null;
      var L = window.BODY_LONGITUDES, nm = spec.kind === "moon" ? spec.body.parent : spec.body.name;
      return nm in L ? L[nm] : null;
    }

    var st = loadJSON("se-trip", {});
    var panel = el('<div class="panel"></div>');
    panel.appendChild(el("<h3>Route</h3>"));
    var ctr = el('<div class="controls"></div>');
    var fromSel = el('<select style="min-width:200px">' + optionsHtml(st.from || "planet|Earth") + "</select>");
    var toSel = el('<select style="min-width:200px">' + optionsHtml(st.to || "planet|Mars") + "</select>");
    ctr.appendChild(el('<label class="check">From</label>')); ctr.appendChild(fromSel);
    ctr.appendChild(el('<label class="check">To</label>')); ctr.appendChild(toSel);
    var todayISO = new Date().toISOString().slice(0, 10);
    var dateInput = el('<input type="date" value="' + esc(st.startDate || todayISO) + '">');
    ctr.appendChild(el('<label class="check">Depart on/after</label>')); ctr.appendChild(dateInput);
    panel.appendChild(ctr);
    var out = el("<div></div>"); panel.appendChild(out);
    mount.appendChild(panel);

    function draw() {
      saveJSON("se-trip", { from: fromSel.value, to: toSel.value, startDate: dateInput.value });
      out.innerHTML = "";
      var r = TripMath.transferBetween(resolve(fromSel.value), resolve(toSel.value), planetsByName);
      if (!r || r.error) { out.appendChild(el('<div class="callout">' + esc((r && r.error) || "Pick an origin and destination.") + "</div>")); return; }
      var win = isFinite(r.synodic_days)
        ? "A launch window opens every <b>" + fmtInt(r.synodic_days) + " days</b> (~" + num(TripMath.daysToMonths(r.synodic_days), 1) + " months)."
        : "No recurring window (co-orbital).";
      out.appendChild(el(
        '<div class="cols">' +
          '<div><h4 style="margin:0 0 6px">⏱️ Timing</h4>' +
            "<p>" + win + "</p>" +
            '<p class="muted">' + esc(TripMath.nextWindowPhaseText(r.origin_axis_au, r.dest_axis_au)) + "</p>" +
            "<p><b>" + fmtInt(r.transfer_days) + " days</b> (~" + num(TripMath.daysToMonths(r.transfer_days), 1) + " months) one-way cruise.</p></div>" +
          '<div><h4 style="margin:0 0 6px">🚀 Delta-v (cruise budget)</h4>' +
            '<table class="totals"><tbody>' +
            '<tr><td>Depart burn</td><td class="num">' + num(r.dv_depart_kms, 2) + " km/s</td></tr>" +
            '<tr><td>Arrive burn</td><td class="num">' + num(r.dv_arrive_kms, 2) + " km/s</td></tr>" +
            '<tr class="grand"><td>Total</td><td class="num">' + num(r.dv_total_kms, 2) + " km/s</td></tr>" +
            "</tbody></table></div>" +
        "</div>"));
      var note = el('<div class="callout" style="border-left-color:var(--warn)"><b>Notes</b></div>');
      var ul = el('<ul class="muted" style="margin:6px 0 0;padding-left:18px;font-size:12.5px"></ul>');
      (r.notes || []).forEach(function (n) { ul.appendChild(el("<li>" + esc(n) + "</li>")); });
      note.appendChild(ul); out.appendChild(note);
      var ts = resolve(toSel.value);
      if (ts) out.appendChild(el('<p style="margin-top:10px"><a href="#/build">Plan a build-out at ' + esc(ts.body.name) + " &rarr;</a></p>"));
      // dated launch windows (calendar dates) — uses BODY_LONGITUDES + LaunchWindows
      var fSpec = resolve(fromSel.value), tSpec = resolve(toSel.value);
      var aF = TripMath.heliocentricAxisAU(fSpec.body, fSpec.kind, planetsByName);
      var aT = TripMath.heliocentricAxisAU(tSpec.body, tSpec.kind, planetsByName);
      var lonF = bodyLongitudeDeg(fSpec), lonT = bodyLongitudeDeg(tSpec);
      if (window.LaunchWindows && lonF != null && lonT != null && aF && aT) {
        var startMs = Date.parse((dateInput.value || todayISO) + "T00:00:00Z");
        if (!isFinite(startMs)) startMs = Date.parse(todayISO + "T00:00:00Z");
        var wins = window.LaunchWindows.nextWindows(aF, lonF, aT, lonT, startMs, 5);
        if (wins.length) {
          var fmt = window.LaunchWindows.fmtDateUTC;
          out.appendChild(el('<div style="margin-top:12px"><h4 style="margin:0 0 6px">📅 Next launch windows</h4>' +
            '<table class="totals"><thead><tr><th>#</th><th>Launch</th><th>Arrive</th></tr></thead><tbody>' +
            wins.map(function (w, i) { return "<tr><td>" + (i + 1) + '</td><td class="num">' + esc(fmt(w.launchMs)) + '</td><td class="num">' + esc(fmt(w.arriveMs)) + "</td></tr>"; }).join("") +
            '</tbody></table><p class="muted" style="font-size:12px;margin:6px 0 0">Dates use mean longitudes at epoch 1959-01-01 (per the wiki) — treat the window spacing and transit time as exact, the absolute dates as a real-world-aligned reference.</p></div>'));
        }
      } else if (window.LaunchWindows && (lonF == null || lonT == null)) {
        out.appendChild(el('<p class="muted" style="margin-top:10px">No epoch longitude on file for one of these bodies, so calendar dates aren\'t available — the timing and &Delta;v above still apply.</p>'));
      }
    }
    fromSel.addEventListener("change", draw);
    toSel.addEventListener("change", draw);
    dateInput.addEventListener("change", draw);
    draw();

    var earth = planetsByName["Earth"];
    if (earth) {
      var ref = el('<div class="panel"><h3>Reachability from Earth</h3></div>');
      ref.appendChild(el('<p class="page-sub">One-way Hohmann cruise time, launch-window spacing, and cruise delta-v from Earth to each planet.</p>'));
      var rows = DATA.planets.filter(function (p) { return p.name !== "Earth" && p.semi_major_au; }).map(function (p) {
        var t = TripMath.transfer(earth.semi_major_au, p.semi_major_au);
        return { name: p.name, dv: t.dv_total_kms, days: t.transfer_days, syn: t.synodic_days };
      });
      makeTable(ref, {
        rows: rows, placeholder: "Filter…", search: ["name"], initialSort: "dv",
        cols: [
          { key: "name", label: "Destination", cls: "namecell" },
          { key: "dv", label: "Δv (km/s)", num: true, html: function (r) { return num(r.dv, 2); } },
          { key: "days", label: "Cruise (days)", num: true, html: function (r) { return fmtInt(r.days); } },
          { key: "syn", label: "Window (days)", num: true, html: function (r) { return isFinite(r.syn) ? fmtInt(r.syn) : "—"; } }
        ]
      });
      mount.appendChild(ref);
    }

    // ---- gravity-assist routes (button-triggered; the scan takes a few seconds) ----
    if (window.GravityAssist) {
      var gaPanel = el('<div class="panel"><h3>Gravity-assist routes</h3></div>');
      gaPanel.appendChild(el('<p class="page-sub">Find a flyby planet that lowers the energy (v∞) to reach the destination versus a direct shot — uses the From / To / date above. Best-case ranking: it shows which body helps most, not a flyable Δv.</p>'));
      var gaCtr = el('<div class="controls"></div>');
      var gaBtn = el('<button class="btn">Find flyby routes</button>');
      var gaStatus = el('<span class="muted"></span>');
      gaCtr.appendChild(gaBtn); gaCtr.appendChild(gaStatus);
      gaPanel.appendChild(gaCtr);
      var gaOut = el("<div></div>"); gaPanel.appendChild(gaOut);
      mount.appendChild(gaPanel);
      gaBtn.addEventListener("click", function () {
        gaOut.innerHTML = "";
        function gaBody(spec) {
          if (!spec) return null;
          var a = TripMath.heliocentricAxisAU(spec.body, spec.kind, planetsByName), lon = bodyLongitudeDeg(spec);
          if (a == null || lon == null) return null;
          return { name: spec.kind === "moon" ? spec.body.parent : spec.body.name, a: a, longitude: lon };
        }
        var oB = gaBody(resolve(fromSel.value)), tB = gaBody(resolve(toSel.value));
        if (!oB || !tB) { gaOut.appendChild(el('<div class="callout">Gravity-assist routing needs an orbital longitude on record for both bodies — not available for this pair.</div>')); return; }
        if (oB.name === tB.name) { gaOut.appendChild(el('<div class="callout">Origin and destination share an orbit.</div>')); return; }
        var byName = {};
        DATA.planets.forEach(function (p) { if (window.BODY_LONGITUDES[p.name] != null) byName[p.name] = { name: p.name, a: p.semi_major_au, longitude: window.BODY_LONGITUDES[p.name] }; });
        byName["Sun"] = { name: "Sun", a: 0, longitude: 0 };
        byName[oB.name] = oB; byName[tB.name] = tB;
        var bodies = Object.keys(byName).map(function (k) { return byName[k]; });
        gaBtn.disabled = true; gaStatus.textContent = "Calculating…";
        setTimeout(function () {
          var gaStart = Date.parse((dateInput.value || todayISO) + "T00:00:00Z");
          if (!isFinite(gaStart)) gaStart = Date.parse(todayISO + "T00:00:00Z");
          var res;
          try { res = window.GravityAssist.rankFlybys(oB.name, tB.name, bodies, gaStart, { windowYears: 12, maxStepsPerDim: 45 }); }
          catch (e) { res = { error: e.message }; }
          gaBtn.disabled = false; gaStatus.textContent = "";
          gaOut.innerHTML = "";
          if (!res || res.error) { gaOut.appendChild(el('<div class="callout">' + esc((res && res.error) || "No result.") + "</div>")); return; }
          var d = res.direct || {};
          gaOut.appendChild(el("<p>Direct (no flyby): <b>" + num(d.total_cost_kms, 2) + " km/s</b> total v∞.</p>"));
          var cands = (res.candidates || []).filter(function (c) { return c.flybyBody !== oB.name && c.flybyBody !== tB.name; });
          if (!cands.length) { gaOut.appendChild(el('<p class="muted">No flyby beats the direct route here.</p>')); return; }
          var box = el("<div></div>"); gaOut.appendChild(box);
          makeTable(box, {
            rows: cands, placeholder: "Filter flyby…", search: ["flybyBody"], initialSort: "saved_kms", initialAsc: false,
            cols: [
              { key: "flybyBody", label: "Flyby", cls: "namecell" },
              { key: "launch_vinf_kms", label: "v∞ launch", num: true, html: function (r) { return num(r.launch_vinf_kms, 2); } },
              { key: "total_cost_kms", label: "Total v∞", num: true, html: function (r) { return num(r.total_cost_kms, 2); } },
              { key: "saved_kms", label: "Saved vs direct", num: true, html: function (r) { var c = r.saved_kms > 0 ? "var(--good)" : "var(--bad)"; return '<span style="color:' + c + '">' + (r.saved_kms >= 0 ? "+" : "") + num(r.saved_kms, 2) + "</span>"; } },
              { key: "transfer1_days", label: "Legs (days)", num: true, html: function (r) { return (isFinite(r.transfer1_days) ? fmtInt(r.transfer1_days) : "—") + " + " + (isFinite(r.transfer2_days) ? fmtInt(r.transfer2_days) : "—"); } }
            ]
          });
          box.appendChild(el('<p class="muted" style="font-size:12px;margin:8px 0 0">Best-case free-rotation proxy; heliocentric, circular/coplanar, single flyby. Planets + Sun only.</p>'));
        }, 30);
      });
    }
  }

  // =========================================================================
  // EXPANSION PLANNER — MERGED into Build & Cost (Phase 2) and removed.
  // #/expansion now routes to viewBuild, which carries every capability the old
  // planner had: an optional destination selector, save-aware Need/Have/Short
  // columns, the missing-research warning, and the fleet-trips/waves logistics.
  // Its old se-exp store is migrated into se-build on boot (see migrateBuildState).
  // =========================================================================

  // ---- utils ---------------------------------------------------------------
  function uniq(a) { return Array.from(new Set(a)); }

  // =========================================================================
  // SHARED: unlock-token resolver + cross-tab "jump & flash" (search + x-links)
  // =========================================================================
  var pendingSearchJump = null;
  function resolveUnlockToken(tok) {
    if (!tok || tok === "—") return null;
    if (tok.indexOf("facility-") === 0) {
      var fid = "build_" + tok.slice(9).replace(/-/g, "_");
      var f = IDX.facilities[fid];
      return f ? { cat: "facilities", id: fid, name: f.name, tab: "facilities" } : null;
    }
    if (tok.indexOf("spacecraft-") === 0) {
      var s = IDX.spacecraftById[tok];
      return s ? { cat: "spacecraft", id: tok, name: s.name, tab: "spacecraft" } : null;
    }
    if (tok.indexOf("lv-") === 0) {
      var rest = tok.slice(3);
      if (rest.indexOf("lv-") === 0) rest = rest.slice(3);
      var lv = IDX.launchVehicles && IDX.launchVehicles[rest];
      return lv ? { cat: "launch_vehicles", id: rest, name: lv.name, tab: "launchvehicles" } : null;
    }
    return null;
  }
  function applySearchJump(tblWrap, tabKey) {
    if (!pendingSearchJump || pendingSearchJump.tab !== tabKey) return;
    var want = pendingSearchJump.name; pendingSearchJump = null;
    var cells = tblWrap.querySelectorAll("td.namecell, td:first-child");
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].textContent.trim().indexOf(want) === 0) {
        var tr = cells[i].closest("tr");
        tr.classList.add("row-flash");
        tr.scrollIntoView({ block: "center", behavior: "smooth" });
        (function (row) { setTimeout(function () { row.classList.remove("row-flash"); }, 1600); })(tr);
        break;
      }
    }
  }
  function wireXLinks(w) {
    w.querySelectorAll(".xlink").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        pendingSearchJump = { tab: a.getAttribute("data-tab"), name: a.getAttribute("data-name"), cat: a.getAttribute("data-cat") };
        if (currentTab() === pendingSearchJump.tab) render(); else location.hash = "#/" + pendingSearchJump.tab;
      });
    });
  }

  // =========================================================================
  // GLOBAL SEARCH (flat index built once at boot; linear scan per keystroke)
  // =========================================================================
  var SEARCH_IDX = [];
  function buildSearchIndex() {
    var ix = [];
    function push(name, tab, cat, catLabel, sub, extra) {
      if (!name) return;
      ix.push({ id: ix.length, name: name, tab: tab, cat: cat, catLabel: catLabel, sub: sub || "",
        hay: (name + " " + (sub || "") + " " + (extra || "")).toLowerCase() });
    }
    DATA.research.forEach(function (r) { push(r.name, "research", "research", "Research", r.branch + (r.released ? "" : " · unreleased"), r.description); });
    DATA.facilities.forEach(function (f) { push(f.name, "facilities", "facility", "Facility", f.category); });
    DATA.spacecraft.forEach(function (s) { push(s.name, "spacecraft", "ship", "Spacecraft", s.propulsion, s.description); });
    DATA.launch_vehicles.forEach(function (v) { push(v.name, "launchvehicles", "lv", "Launch vehicle", v.reusable && v.reusable !== "No" ? "reusable" : "", v.description); });
    DATA.space_modules.forEach(function (m) { push(m.name, "modules", "module", "Module", m.category); });
    (DATA.crew_transports || []).forEach(function (m) { push(m.name, "modules", "crew", "Crew transport", m.capacity + " seats"); });
    DATA.resources.forEach(function (r) { push(r.name, "resources", "resource", "Resource", r.type); });
    DATA.planets.forEach(function (p) { push(p.name, "bodies", "body", "Planet", "Planet"); });
    DATA.moons.forEach(function (m) { push(m.name, "bodies", "body", "Moon", "Moon of " + m.parent); });
    DATA.asteroids.forEach(function (a) { push(a.name, "bodies", "body", "Asteroid", a.region); });
    (DATA.comets || []).forEach(function (c) { push(c.name, "bodies", "body", "Comet", "Comet"); });
    (DATA.exoplanets || []).forEach(function (e) { push(e.name, "bodies", "body", "Exoplanet", e.system + " · " + e.type); });
    DATA.contracts.forEach(function (c) { push(c.name, "progression", "contract", "Contract", "Contract #" + c.order, c.premise); });
    SEARCH_IDX = ix;
  }
  function searchAll(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    var out = [];
    for (var i = 0; i < SEARCH_IDX.length; i++) {
      var r = SEARCH_IDX[i], nm = r.name.toLowerCase(), score;
      if (nm === q) score = 0;
      else if (nm.indexOf(q) === 0) score = 1;
      else if (nm.indexOf(" " + q) !== -1) score = 2;
      else if (nm.indexOf(q) !== -1) score = 3;
      else if (r.hay.indexOf(q) !== -1) score = 4;
      else continue;
      out.push({ r: r, score: score });
    }
    out.sort(function (a, b) { return a.score - b.score || a.r.name.localeCompare(b.r.name); });
    return out.slice(0, 12).map(function (o) { return o.r; });
  }
  function setupGlobalSearch() {
    var header = document.querySelector(".topbar");
    var box = el(
      '<div class="omni">' +
        '<span class="omni-ic" aria-hidden="true">🔍</span>' +
        '<input type="search" id="omni-input" placeholder="Search everything…  (press /)" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="omni-results">' +
        '<div class="omni-results" id="omni-results" role="listbox" hidden></div>' +
      "</div>");
    header.appendChild(box);
    var input = box.querySelector("#omni-input");
    var panel = box.querySelector("#omni-results");
    var results = [], active = -1;
    function close() { panel.hidden = true; panel.innerHTML = ""; input.setAttribute("aria-expanded", "false"); active = -1; }
    function go(r) {
      close(); input.value = ""; input.blur();
      pendingSearchJump = { tab: r.tab, name: r.name, cat: r.cat };
      if (currentTab() === r.tab) render(); else location.hash = "#/" + r.tab;
    }
    function draw() {
      if (!results.length) { panel.innerHTML = '<div class="omni-empty">No matches</div>'; panel.hidden = false; return; }
      panel.innerHTML = results.map(function (r, i) {
        return '<div class="omni-row' + (i === active ? " active" : "") + '" role="option" data-i="' + i + '">' +
          '<span class="omni-cat omni-cat-' + esc(r.cat) + '">' + esc(r.catLabel) + "</span>" +
          '<span class="omni-name">' + esc(r.name) + "</span>" +
          (r.sub ? '<span class="omni-sub">' + esc(r.sub) + "</span>" : "") + "</div>";
      }).join("");
      panel.hidden = false; input.setAttribute("aria-expanded", "true");
      panel.querySelectorAll(".omni-row").forEach(function (row) {
        row.addEventListener("mousedown", function (e) { e.preventDefault(); go(results[+row.getAttribute("data-i")]); });
      });
    }
    function refresh() { results = searchAll(input.value); active = -1; if (input.value.trim().length < 2) close(); else draw(); }
    input.addEventListener("input", refresh);
    input.addEventListener("focus", function () { if (results.length) draw(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (results.length) { active = (active + 1) % results.length; draw(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (results.length) { active = (active - 1 + results.length) % results.length; draw(); } }
      else if (e.key === "Enter") { if (active >= 0 && results[active]) { e.preventDefault(); go(results[active]); } else if (results[0]) { e.preventDefault(); go(results[0]); } }
      else if (e.key === "Escape") { close(); input.value = ""; input.blur(); }
    });
    document.addEventListener("mousedown", function (e) { if (!box.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
      e.preventDefault(); input.focus();
    });
  }

  // =========================================================================
  // HOME DASHBOARD (save-aware): summary + smart next-step suggestions
  // =========================================================================
  function fleetSize() { return Object.keys(SAVE.fleet || {}).reduce(function (s, k) { return s + SAVE.fleet[k]; }, 0); }
  function fleetCargoTotal() {
    var total = 0, lines = [];
    Object.keys(SAVE.fleet || {}).forEach(function (sid) {
      var info = IDX.shipBySaveId[sid], cnt = SAVE.fleet[sid];
      var cargo = info ? (info.cargo || 0) : 0;
      total += cargo * cnt;
      lines.push(cnt + "× " + (info ? info.name : sid) + " (" + fmtInt(cargo) + " t)");
    });
    return { total: total, lines: lines };
  }
  function nextSteps() {
    var out = [];
    var ready = DATA.research.filter(function (r) {
      return r.released && !owned.has(r.id) && r.prereqs.every(function (p) { return owned.has(p.id); });
    }).sort(function (a, b) { return (a.cost_hours || 0) - (b.cost_hours || 0); });
    if (ready.length) {
      var r = ready[0];
      out.push({ icon: "🔬", title: "Cheapest tech you can start now",
        body: "<b>" + esc(r.name) + "</b> <span class='muted'>(" + esc(r.branch) + ")</span><br>" + fmtHours(r.cost_hours) + " work-hours · no missing prerequisites.",
        action: { href: "#/planner", label: "Plan it", onClick: function () { plannerTarget = { kind: "research", id: r.id }; } } });
    }
    var cargo = fleetCargoTotal();
    if (cargo.total > 0) {
      out.push({ icon: "🚀", title: "Your fleet carries " + fmtInt(cargo.total) + " t per trip",
        body: cargo.lines.map(esc).join(" · ") + "<br><span class='muted'>Open Build &amp; Cost, pick a destination, and see how many trips a build-out needs.</span>",
        action: { href: "#/build", label: "Plan a build-out" } });
    }
    var lockedFacs = DATA.facilities.filter(function (f) {
      return f.unlocked_by && f.unlocked_by.length && !f.unlocked_by.some(function (u) { return owned.has(u.id); });
    }).map(function (f) {
      var cheapest = f.unlocked_by.map(function (u) { return IDX.research[u.id]; }).filter(Boolean).sort(function (a, b) { return (a.cost_hours || 0) - (b.cost_hours || 0); })[0];
      return cheapest ? { fac: f, tech: cheapest } : null;
    }).filter(Boolean).sort(function (a, b) { return (a.tech.cost_hours || 0) - (b.tech.cost_hours || 0); });
    if (lockedFacs.length) {
      var lf = lockedFacs[0];
      out.push({ icon: "🏗️", title: "Unlock a new facility",
        body: "<b>" + esc(lf.fac.name) + "</b> needs <b>" + esc(lf.tech.name) + "</b> <span class='muted'>(" + fmtHours(lf.tech.cost_hours) + " h)</span>.",
        action: { href: "#/planner", label: "Plan the unlock", onClick: function () { plannerTarget = { kind: "research", id: lf.tech.id }; } } });
    }
    if (SAVE.money > 1e6) {
      out.push({ icon: "💰", title: "Treasury looks healthy",
        body: "$" + fmtInt(SAVE.money) + " banked — consider committing it to a build-out or the next launch-vehicle tier.",
        action: { href: "#/build", label: "Open Build &amp; Cost" } });
    }
    return out.slice(0, 4);
  }
  function homeDashboard(mount) {
    if (!SAVE) return;
    var card = el('<div class="panel dash"></div>');
    card.appendChild(el('<h3>Your colony <span class="muted" style="font-weight:400;font-size:12px">— from imported save</span></h3>'));
    var row = el('<div class="dash-stats"></div>');
    [["🏢 " + esc(SAVE.company), "company"], ["$" + fmtInt(SAVE.money), "treasury"], [fmtInt(SAVE.population), "population"],
     [SAVE.researchCount + " / " + DATA.research.length, "techs researched"], [fmtInt(fleetSize()), "ships in fleet"]
    ].forEach(function (s) { row.appendChild(el('<div class="stat"><div class="big">' + s[0] + '</div><div class="lbl">' + s[1] + "</div></div>")); });
    card.appendChild(row);
    var sug = el('<div class="dash-suggest"></div>');
    nextSteps().forEach(function (s) {
      var c = el('<div class="suggest-card"></div>');
      c.innerHTML = '<div class="suggest-h">' + s.icon + " " + esc(s.title) + '</div>' + '<div class="suggest-b">' + s.body + "</div>";
      if (s.action) {
        var a = el('<a class="suggest-go" href="' + s.action.href + '">' + esc(s.action.label) + " →</a>");
        if (s.action.onClick) a.addEventListener("click", s.action.onClick);
        c.appendChild(a);
      }
      sug.appendChild(c);
    });
    card.appendChild(sug);
    mount.appendChild(card);
  }

  // =========================================================================
  // Boot
  // =========================================================================
  function buildIndexes() {
    IDX.research = {}; DATA.research.forEach(function (r) { IDX.research[r.id] = r; });
    IDX.facilities = {}; DATA.facilities.forEach(function (f) { IDX.facilities[f.id] = f; });
    IDX.spacecraftById = {}; DATA.spacecraft.forEach(function (s) { IDX.spacecraftById[s.id] = s; });
    IDX.resName = {}; DATA.resources.forEach(function (r) { IDX.resName[r.id] = r.name; });
    IDX.launchVehicles = {}; (DATA.launch_vehicles || []).forEach(function (v) { IDX.launchVehicles[v.id] = v; });
    // map save ship type id (underscore) -> {name,cargo} for fleet logistics
    IDX.shipBySaveId = {};
    DATA.spacecraft.forEach(function (s) {
      var saveId = (s.id || "").replace(/^spacecraft-/, "").replace(/-/g, "_");
      IDX.shipBySaveId[saveId] = { name: s.name, cargo: s.cargo_t };
    });
    // merge cargo from spacecraft_cargo into spacecraft list (ensure cargo_t present)
    var cargoById = {}; (DATA.spacecraft_cargo || []).forEach(function (s) { cargoById[s.id] = s.cargo_capacity; });
    DATA.spacecraft.forEach(function (s) { if (s.cargo_t == null && cargoById[s.id] != null) s.cargo_t = cargoById[s.id]; });
  }

  fetch("data/gamedata.json", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (d) {
      DATA = d; buildIndexes();
      document.getElementById("meta-footer").innerHTML =
        "Data: Solar Expanse v" + esc(d.meta.game_version) + " · extracted from game files via the " +
        '<a href="' + d.meta.sources.wiki + '" target="_blank" rel="noopener">Solar Expanse Wiki</a> pipeline. ' +
        "Fan-made; not affiliated with SpaceOps.";
      window.addEventListener("hashchange", render);
      buildNav();
      setupImportBar();
      buildSearchIndex();
      setupGlobalSearch();
      render();
    })
    .catch(function (err) {
      view.innerHTML = '<div class="panel"><h3>Could not load game data</h3><p class="muted">' + esc(err.message) +
        " — make sure <code>data/gamedata.json</code> is present (run <code>python build_data.py</code>).</p></div>";
    });
})();
