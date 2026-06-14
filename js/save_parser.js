/* Tolerant parser for Solar Expanse save files (custom Unity serializer).
 *
 * Saves are gzip'd "JSON" that isn't valid JSON: it uses
 *   - `"$type"` / `"$id"` metadata keys (string on first use, int ref after)
 *   - positional structs: { "$type": X, 1.7, -55.6 }  (Vectors, Nullables)
 *   - `$iref:N`     object back-references to an earlier "$id"
 *   - `$fstrref:"…"` interned string literals
 *   - collections as { "$rlength": N, "$rcontent": [ … ] }
 *   - dictionaries as $rcontent of { "$k": key, "$v": value } pairs
 *
 * parseSolarExpanseSave(text) -> plain JS object with all of that resolved:
 * structs become arrays, Nullables unwrap, collections become arrays,
 * dictionaries become {key:value}, and $iref are linked to their target.
 *
 * Works in the browser and under bun/node. Browser callers decompress with
 * DecompressionStream('gzip') first (see app.js).
 */
(function (root) {
  function parseSolarExpanseSave(text) {
    var i = 0, n = text.length;
    var idmap = {};

    function ws() {
      while (i < n) { var c = text.charCodeAt(i); if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break; }
    }
    function parseValue() {
      ws();
      var c = text[i];
      if (c === '{') return parseObject();
      if (c === '[') return parseArray();
      if (c === '"') return parseString();
      if (c === '$') return parseSpecial();
      if (c === 't') { i += 4; return true; }
      if (c === 'f') { i += 5; return false; }
      if (c === 'n') { i += 4; return null; }
      if (c === 'I') { i += 8; return Infinity; }            // Unity float Infinity
      if (c === 'N') { i += 3; return NaN; }                  // Unity float NaN
      if (c === '-' && text[i + 1] === 'I') { i += 9; return -Infinity; }
      var before = i;
      var num = parseNumber();
      if (i === before) throw new Error('unexpected token at ' + i + ': ' + JSON.stringify(text.slice(i, i + 30)));
      return num;
    }
    function parseSpecial() {
      if (text.startsWith('$iref:', i)) {
        i += 6; var s = i;
        while (i < n) { var c = text.charCodeAt(i); if (c >= 48 && c <= 57) i++; else break; }
        return { __ref: parseInt(text.slice(s, i), 10) };
      }
      if (text.startsWith('$fstrref:', i)) { i += 9; ws(); return parseString(); }
      throw new Error('unknown $token at ' + i + ': ' + text.slice(i, i + 24));
    }
    function parseString() {
      i++; var s = '';
      while (i < n) {
        var c = text[i++];
        if (c === '\\') {
          var e = text[i++];
          if (e === 'n') s += '\n'; else if (e === 't') s += '\t'; else if (e === 'r') s += '\r';
          else if (e === 'u') { s += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4; }
          else s += e;
        } else if (c === '"') break;
        else s += c;
      }
      return s;
    }
    function parseNumber() {
      var s = i;
      if (text[i] === '-') i++;
      while (i < n) { var c = text[i]; if ((c >= '0' && c <= '9') || c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-') i++; else break; }
      return parseFloat(text.slice(s, i));
    }
    function parseArray() {
      i++; var arr = []; ws();
      if (text[i] === ']') { i++; return arr; }
      while (i < n) {
        arr.push(parseValue()); ws();
        var d = text[i];
        if (d === ',') { i++; ws(); if (text[i] === ']') { i++; break; } continue; }
        if (d === ']') { i++; break; }
        i++; // tolerate stray
      }
      return arr;
    }
    function parseObject() {
      i++; var props = {}, pos = [], id = null, hasId = false; ws();
      if (text[i] === '}') { i++; return {}; }
      while (i < n) {
        ws();
        if (text[i] === '}') { i++; break; }
        if (text[i] === '"') {
          var key = parseString(); ws();
          if (text[i] === ':') {
            i++; var val = parseValue();
            if (key === '$id') { id = val; hasId = true; }
            else props[key] = val;
          } else { pos.push(key); }
        } else {
          pos.push(parseValue());
        }
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
      }
      var result;
      if (pos.length > 0) {
        result = pos.length === 1 ? pos[0] : pos;   // Nullable unwraps; Vector stays array
      } else if ('$rcontent' in props) {
        result = props['$rcontent'];
        if (Array.isArray(result) && result.length &&
            result.every(function (e) { return e && typeof e === 'object' && !Array.isArray(e) && ('$k' in e) && ('$v' in e); })) {
          var m = {}; result.forEach(function (e) { m[e['$k']] = e['$v']; }); result = m;
        }
      } else {
        delete props['$type']; delete props['$rlength'];
        result = props;
      }
      if (hasId) idmap[id] = result;
      return result;
    }

    var out = parseValue();

    // link $iref markers to their target instances (one level; cycle-safe)
    var seen = typeof Set !== 'undefined' ? new Set() : null;
    function resolve(o) {
      if (!o || typeof o !== 'object') return;
      if (seen) { if (seen.has(o)) return; seen.add(o); }
      var keys = Array.isArray(o) ? o.map(function (_, k) { return k; }) : Object.keys(o);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k], v = o[key];
        if (v && typeof v === 'object' && v.__ref !== undefined) o[key] = idmap[v.__ref];
        else resolve(v);
      }
    }
    resolve(out);
    return out;
  }

  root.parseSolarExpanseSave = parseSolarExpanseSave;
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseSolarExpanseSave: parseSolarExpanseSave };
})(typeof globalThis !== 'undefined' ? globalThis : this);
