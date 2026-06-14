/* Solar Expanse Hub — single-page app over gamedata.json.
   No framework, no build step. All events via addEventListener (CSP-safe). */
(function () {
  "use strict";

  var DATA = null;
  var IDX = {};            // lookup indexes built after load
  var view = document.getElementById("view");

  // ---- persistent state ----------------------------------------------------
  var owned = loadSet("se-owned");          // research ids the player has completed
  var build = loadJSON("se-build", { placed: {}, ship: null });
  var exp = loadJSON("se-exp", { placed: {}, dest: null });
  var SAVE = loadJSON("se-save", null);     // imported save summary (stockpile/fleet/money)
  var plannerTarget = null;                 // pending planner selection

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
    home: viewHome, planner: viewPlanner, build: viewBuild, expansion: viewExpansion,
    research: viewResearch, facilities: viewFacilities, spacecraft: viewSpacecraft,
    launchvehicles: viewLaunchVehicles, modules: viewModules, bodies: viewBodies,
    terraform: viewTerraform, resources: viewResources, progression: viewProgression
  };
  function currentTab() {
    var h = (location.hash || "#/home").replace(/^#\//, "");
    return ROUTES[h] ? h : "home";
  }
  function render() {
    var tab = currentTab();
    document.querySelectorAll("#tabs a").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-tab") === tab);
    });
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
      '<div class="card"><h4>🏗️ Build Calculator</h4><p>Add facilities &amp; modules, apply your completed research discounts automatically, and see total resources, tonnage, ship trips, workers and power.</p>' +
      '<a href="#/build">Open calculator →</a></div>'));
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
              return r.prereqs.length ? r.prereqs.map(function (p) { return esc(p.name); }).join(", ") : '<span class="muted">—</span>'; }, cls: "desccell" },
          { key: "unlocks", label: "Unlocks", get: function (r) { return r.unlocks.join(" "); }, html: function (r) {
              return r.unlocks.length ? esc(r.unlocks.join(" · ")) : '<span class="muted">—</span>'; }, cls: "desccell" },
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
  // BUILD CALCULATOR (optimizer)
  // =========================================================================
  function placeables() {
    var items = [];
    DATA.facilities.forEach(function (f) { items.push({ id: f.id, name: f.name, cat: f.category, kind: "fac", ref: f }); });
    DATA.space_modules.forEach(function (m) { items.push({ id: m.id, name: m.name, cat: "Module: " + m.category, kind: "mod", ref: m }); });
    DATA.crew_transports.forEach(function (c) { items.push({ id: c.id, name: c.name, cat: "Crew Transport", kind: "crew", ref: c }); });
    return items;
  }

  function viewBuild(mount) {
    pageHeader(mount, "Build Calculator",
      "Add what you want to build; discounts from research you've ticked apply automatically (additive, exactly like the game).");

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

    function add(id, d) { build.placed[id] = Math.max(0, (build.placed[id] || 0) + d); if (!build.placed[id]) delete build.placed[id]; saveJSON("se-build", build); drawPlaced(); drawTotals(); drawPicker(); }
    function setCount(id, v) { build.placed[id] = Math.max(0, Math.floor(v || 0)); if (!build.placed[id]) delete build.placed[id]; saveJSON("se-build", build); drawPlaced(); drawTotals(); }

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
      var html = '<table class="totals">';
      html += "<tbody>";
      resIds.sort(function (a, b) { return resName(a).localeCompare(resName(b)); }).forEach(function (rid) {
        html += "<tr><td>" + resPip(rid, resTotals[rid]) + " " + esc(resName(rid)) + "</td><td class='num'>" + fmtInt(resTotals[rid]) + "</td></tr>";
      });
      html += "<tr class='grand'><td>Total tonnage</td><td class='num'>" + fmtInt(totalTons) + " t</td></tr>";
      var ship = IDX.spacecraftById[shipSel.value];
      if (ship && ship.cargo_t > 0 && totalTons > 0) {
        html += "<tr><td>" + esc(ship.name) + " trips <span class='muted'>(" + fmtInt(ship.cargo_t) + " t)</span></td><td class='num'>" + Math.ceil(totalTons / ship.cargo_t).toLocaleString() + "</td></tr>";
      }
      html += "</tbody><tbody>";
      if (workers > 0) html += "<tr><td>" + resPip("human", Math.round(workers)) + " Workers needed</td><td class='num'>" + fmtInt(workers) + "</td></tr>";
      if (Math.round(powerNet) !== 0) html += "<tr><td>Net power " + (powerNet > 0 ? "<span style='color:var(--bad)'>(deficit)</span>" : "<span style='color:var(--good)'>(surplus)</span>") + "</td><td class='num'>" + fmtInt(powerNet) + "</td></tr>";
      if (days > 0) html += "<tr><td>Build days <span class='muted'>(serial)</span></td><td class='num'>" + fmtInt(days) + "</td></tr>";
      html += "</tbody></table>";
      totalsBox.innerHTML = html;
    }

    pf.addEventListener("input", drawPicker);
    shipSel.addEventListener("change", function () { build.ship = shipSel.value; saveJSON("se-build", build); drawTotals(); });
    placedPanel.querySelector("#clr").addEventListener("click", function () { build.placed = {}; saveJSON("se-build", build); drawPlaced(); drawTotals(); drawPicker(); });
    redGrid.querySelectorAll(".red-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var id = cb.getAttribute("data-id");
        if (cb.checked) owned.add(id); else owned.delete(id);
        saveSet("se-owned", owned);
        drawPicker(); drawTotals();
      });
    });

    if (!build.ship && shipSel.options.length) { build.ship = shipSel.value; }
    drawPicker(); drawPlaced(); drawTotals();
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
      afterDraw: wirePlanLinks
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
        afterDraw: wirePlanLinks
      });
    }
    build2();
  }

  // =========================================================================
  // MODULES (reference)
  // =========================================================================
  function viewModules(mount) {
    pageHeader(mount, "Modules &amp; crew transports", "Spacecraft payload — shipped pre-assembled, so you pay their mass in cargo.");
    var p1 = el('<div class="panel"><h3>Space modules</h3></div>'); mount.appendChild(p1);
    makeTable(p1, {
      rows: DATA.space_modules, placeholder: "Filter modules…", search: ["name", "category"], initialSort: "name",
      cols: [
        { key: "name", label: "Module", cls: "namecell", html: function (m) { return esc(m.name) + lockBadge(m.is_locked); } },
        { key: "category", label: "Category", html: function (m) { return '<span class="badge cat">' + esc(m.category) + "</span>"; } },
        { key: "mass", label: "Mass (t)", num: true, html: function (m) { return fmtInt(m.mass); } }
      ]
    });
    var p2 = el('<div class="panel"><h3>Crew transports</h3></div>'); mount.appendChild(p2);
    makeTable(p2, {
      rows: DATA.crew_transports, placeholder: "Filter…", search: ["name"], initialSort: "capacity",
      cols: [
        { key: "name", label: "Transport", cls: "namecell", html: function (m) { return esc(m.name) + lockBadge(m.is_locked); } },
        { key: "capacity", label: "Seats", num: true },
        { key: "mass", label: "Mass empty (t)", num: true, html: function (m) { return fmtInt(m.mass); } }
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
    pageHeader(mount, "Terraforming", "Per-resource thermal constants and the habitability scoring the game uses.");

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
  // RESOURCES (reference)
  // =========================================================================
  function viewResources(mount) {
    pageHeader(mount, "Resources",
      "Every resource — market price, Earth export license, and which facilities produce or consume it. Thermal/phase data is on the Terraforming tab.");
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
      ]
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
  // EXPANSION PLANNER (save-aware): destination + need/have/short + fleet trips
  // =========================================================================
  function viewExpansion(mount) {
    pageHeader(mount, "Expansion Planner",
      "Plan a build-out at a destination. With a save imported, it shows what you already have, what's short, and how many trips your fleet needs.");

    if (!SAVE) mount.appendChild(el('<div class="callout">Click <b>📁 Import save</b> (top-right) — or just <b>drag your save file onto this page</b> — to load your research, stockpile and fleet, then this shows exactly what you still need and how to ship it. You can also plan without a save (it just shows totals).</div>'));

    var items = placeables(); var byId = {}; items.forEach(function (i) { byId[i.id] = i; });

    var panel = el('<div class="panel"></div>');
    panel.appendChild(el("<h3>Destination &amp; build list</h3>"));
    var ctr = el('<div class="controls"></div>');
    var bodies = DATA.planets.map(function (p) { return p.name; })
      .concat(DATA.moons.map(function (m) { return m.name + " (" + m.parent + ")"; }));
    var destSel = el('<select style="min-width:200px"><option value="">— destination —</option>' +
      bodies.map(function (b) { return '<option' + (exp.dest === b ? " selected" : "") + ">" + esc(b) + "</option>"; }).join("") + "</select>");
    var addSel = el('<select style="min-width:220px"></select>');
    items.slice().sort(function (a, b) { return a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name); })
      .forEach(function (it) { addSel.appendChild(el('<option value="' + esc(it.id) + '">' + esc(it.name) + " — " + esc(it.cat) + "</option>")); });
    var addBtn = el('<button class="btn">+ Add</button>');
    ctr.appendChild(el('<label class="check">To:</label>')); ctr.appendChild(destSel);
    ctr.appendChild(addSel); ctr.appendChild(addBtn);
    panel.appendChild(ctr);
    var placedBox = el("<div></div>"); panel.appendChild(placedBox);
    mount.appendChild(panel);
    var resBox = el('<div class="panel"></div>'); mount.appendChild(resBox);

    function add(id, d) { exp.placed[id] = Math.max(0, (exp.placed[id] || 0) + d); if (!exp.placed[id]) delete exp.placed[id]; saveJSON("se-exp", exp); drawPlaced(); drawResults(); }

    function drawPlaced() {
      var ids = Object.keys(exp.placed);
      if (!ids.length) { placedBox.innerHTML = '<p class="empty">Add facilities/modules to build at the destination.</p>'; return; }
      placedBox.innerHTML = "";
      ids.sort(function (a, b) { return byId[a].name.localeCompare(byId[b].name); }).forEach(function (id) {
        var row = el('<div class="placed-row"><span class="pname">' + esc(byId[id].name) + "</span></div>");
        var counter = el('<span class="counter"></span>');
        var dec = el("<button>−</button>"), inc = el("<button>+</button>"), inp = el('<input type="number" min="0" value="' + exp.placed[id] + '">');
        dec.addEventListener("click", function () { add(id, -1); });
        inc.addEventListener("click", function () { add(id, 1); });
        inp.addEventListener("change", function () { exp.placed[id] = Math.max(0, parseInt(inp.value, 10) || 0); if (!exp.placed[id]) delete exp.placed[id]; saveJSON("se-exp", exp); drawPlaced(); drawResults(); });
        counter.appendChild(dec); counter.appendChild(inp); counter.appendChild(inc);
        row.appendChild(counter);
        var rm = el('<button class="chip">✕</button>'); rm.addEventListener("click", function () { delete exp.placed[id]; saveJSON("se-exp", exp); drawPlaced(); drawResults(); });
        row.appendChild(rm); placedBox.appendChild(row);
      });
    }

    function drawResults() {
      var ids = Object.keys(exp.placed);
      if (!ids.length) { resBox.innerHTML = "<h3>Requirements</h3><p class='empty'>Nothing planned yet.</p>"; return; }
      var reds = activeReductions();
      var need = {}, tons = 0, workers = 0, power = 0, days = 0, missing = [];
      ids.forEach(function (id) {
        var it = byId[id], c = exp.placed[id];
        if (it.kind === "fac") {
          var f = it.ref, m = buildCostMult(f, reds);
          (f.build_cost || []).forEach(function (b) { var a = Math.round(b.amount * m) * c; need[b.resource] = (need[b.resource] || 0) + a; tons += a; });
          workers += (f.workers_required || 0) * crewMult(f, reds) * c;
          power += ((f.energy_consumption || 0) - (f.power_production || 0) * powerMult(f, reds)) * c;
          days += (f.build_time_days || 0) * c;
          if (f.unlocked_by && f.unlocked_by.length && !f.unlocked_by.some(function (u) { return owned.has(u.id); }))
            missing.push({ fac: f.name, res: f.unlocked_by });
        } else { tons += (it.ref.mass || 0) * c; }
      });

      var html = "<h3>Requirements" + (exp.dest ? ' <span class="muted" style="font-weight:400">→ ' + esc(exp.dest) + "</span>" : "") + "</h3>";
      if (missing.length) {
        html += '<div class="callout" style="border-color:var(--bad)">⚠ Missing research: ' +
          missing.map(function (x) { return "<b>" + esc(x.fac) + "</b> needs " + x.res.map(function (u) { return '<a href="#/planner" class="goto-plan" data-id="' + esc(u.id) + '">' + esc(u.name) + "</a>"; }).join(" or "); }).join("; ") + "</div>";
      }
      html += '<table class="totals"><thead><tr><th>Resource</th><th class="num">Need</th>' +
        (SAVE ? '<th class="num">Have</th><th class="num">Short</th>' : "") + "</tr></thead><tbody>";
      Object.keys(need).sort(function (a, b) { return resName(a).localeCompare(resName(b)); }).forEach(function (rid) {
        var have = SAVE ? Math.round(SAVE.stockpile[rid] || 0) : null;
        var short = have != null ? Math.max(0, need[rid] - have) : null;
        html += "<tr><td>" + resPip(rid, need[rid]) + " " + esc(resName(rid)) + "</td><td class='num'>" + fmtInt(need[rid]) + "</td>" +
          (SAVE ? "<td class='num muted'>" + fmtInt(have) + "</td><td class='num'" + (short > 0 ? " style='color:var(--bad)'" : " style='color:var(--good)'") + ">" + (short > 0 ? fmtInt(short) : "✓") + "</td>" : "") + "</tr>";
      });
      html += "<tr class='grand'><td>Total tonnage</td><td class='num'>" + fmtInt(tons) + " t</td>" + (SAVE ? "<td colspan='2'></td>" : "") + "</tbody></table>";
      resBox.innerHTML = html;

      // logistics: trips with your fleet
      var log = "<h4 style='margin:14px 0 6px'>Logistics</h4>";
      if (SAVE && Object.keys(SAVE.fleet).length) {
        var fleetCargo = 0, lines = [];
        Object.keys(SAVE.fleet).forEach(function (sid) {
          var info = IDX.shipBySaveId[sid]; var cargo = info ? info.cargo : 0; var cnt = SAVE.fleet[sid];
          fleetCargo += cargo * cnt;
          lines.push(cnt + "× " + (info ? info.name : sid) + " (" + fmtInt(cargo) + "t)");
        });
        var waves = fleetCargo > 0 ? Math.ceil(tons / fleetCargo) : "—";
        log += "<p>Your fleet: " + esc(lines.join(", ")) + " = <b>" + fmtInt(fleetCargo) + " t</b> per wave → <b>" + waves + "</b> full wave(s) to move " + fmtInt(tons) + " t.</p>";
      } else {
        var big = DATA.spacecraft.filter(function (s) { return s.cargo_t; }).sort(function (a, b) { return b.cargo_t - a.cargo_t; })[0];
        if (big) log += "<p class='muted'>No fleet imported. Reference: a " + esc(big.name) + " carries " + fmtInt(big.cargo_t) + " t → " + Math.ceil(tons / big.cargo_t) + " trips.</p>";
      }
      log += "<table class='totals'><tbody>";
      if (workers > 0) log += "<tr><td>" + resPip("human", Math.round(workers)) + " Workers needed</td><td class='num'>" + fmtInt(workers) + (SAVE ? " / " + fmtInt(SAVE.population) + " pop" : "") + "</td></tr>";
      if (Math.round(power) !== 0) log += "<tr><td>Net power</td><td class='num'>" + fmtInt(power) + "</td></tr>";
      if (days > 0) log += "<tr><td>Build days (serial)</td><td class='num'>" + fmtInt(days) + "</td></tr>";
      log += "</tbody></table>";
      resBox.innerHTML += log;
      resBox.querySelectorAll(".goto-plan").forEach(function (a) { a.addEventListener("click", function () { plannerTarget = { kind: "research", id: a.getAttribute("data-id") }; }); });
    }

    addBtn.addEventListener("click", function () { if (addSel.value) add(addSel.value, 1); });
    destSel.addEventListener("change", function () { exp.dest = destSel.value; saveJSON("se-exp", exp); drawResults(); });
    drawPlaced(); drawResults();
  }

  // ---- utils ---------------------------------------------------------------
  function uniq(a) { return Array.from(new Set(a)); }

  // =========================================================================
  // Boot
  // =========================================================================
  function buildIndexes() {
    IDX.research = {}; DATA.research.forEach(function (r) { IDX.research[r.id] = r; });
    IDX.facilities = {}; DATA.facilities.forEach(function (f) { IDX.facilities[f.id] = f; });
    IDX.spacecraftById = {}; DATA.spacecraft.forEach(function (s) { IDX.spacecraftById[s.id] = s; });
    IDX.resName = {}; DATA.resources.forEach(function (r) { IDX.resName[r.id] = r.name; });
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
      setupImportBar();
      render();
    })
    .catch(function (err) {
      view.innerHTML = '<div class="panel"><h3>Could not load game data</h3><p class="muted">' + esc(err.message) +
        " — make sure <code>data/gamedata.json</code> is present (run <code>python build_data.py</code>).</p></div>";
    });
})();
