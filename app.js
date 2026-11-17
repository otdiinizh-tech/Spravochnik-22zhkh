/* Справочник 22ЖКХ — поиск по дому. Логика идентична ботам (MAX/Telegram/VK). */
(function (global) {
  "use strict";

  const MAX_SUGGESTIONS = 5;
  const FUZZY_THRESHOLD = 0.85;

  const ABBREV = {
    "ул": "улица", "улица": "улица", "у": "улица",
    "пр": "проспект", "прт": "проспект", "пр-т": "проспект",
    "просп": "проспект", "проспект": "проспект",
    "пер": "переулок", "переулок": "переулок",
    "наб": "набережная", "набережная": "набережная",
    "пл": "площадь", "плошадь": "площадь", "площадь": "площадь",
    "бр": "бульвар", "бульвар": "бульвар", "бульв": "бульвар", "б-р": "бульвар",
    "ш": "шоссе", "шос": "шоссе", "шоссе": "шоссе",
    "прд": "проезд", "проезд": "проезд",
    "ал": "аллея", "аллея": "аллея",
    "мкр": "микрорайон", "микр": "микрорайон", "микрорайон": "микрорайон",
    "п": "поселок", "пос": "поселок", "поселок": "поселок", "пгт": "поселок",
    "кп": "курортный поселок", "кур": "курортный поселок",
    "сл": "село", "с": "село", "село": "село",
    "тер": "территория", "территория": "территория",
    "жр": "жилой район", "жилой": "жилой",
    "д": "дом", "дом": "дом", "вл": "владение", "владение": "владение",
    "к": "корпус", "корп": "корпус", "кор": "корпус", "корпус": "корпус",
    "стр": "строение", "строение": "строение",
    "лит": "литера", "литера": "литера",
  };
  const STREET_TYPES = makeSet(["улица", "проспект", "переулок", "набережная", "площадь",
    "бульвар", "шоссе", "проезд", "аллея", "микрорайон", "квартал"]);
  const PLACE_TYPES = makeSet(["поселок", "курортный поселок", "село", "территория", "жилой район"]);
  const CORPUS_MARKERS = makeSet(["корпус", "строение", "литера"]);
  const SERVICE_MARKERS = makeSet(["дом", "владение", "г", "гор", "город", "рн", "обл", "область"]);
  const CITY_TOKENS = makeSet(["нижний", "новгород", "россия"]);
  const STOP_MARKERS = makeSet(["квартира", "кв", "офис", "помещение", "комната"]);

  const HOUSE_RE = /^(\d{1,4})([а-я]{0,2})(?:\s*\/\s*(\d{1,3}[а-я]{0,2}))?$/;
  const GLUED_HOUSE_RE = /^д(?:ом)?\s*(\d{1,4})([а-я]{0,2})(?:\s*\/\s*(\d{1,3}[а-я]{0,2}))?$/;
  const GLUED_CORPUS_RE = /^к\s*\.?\s*(\d{1,3})$/;
  const GLUED_HOUSE_CORPUS_RE = /^(\d{1,4})к(\d{1,3})$/;   // «4к1» = дом 4, корпус 1
  const VERBATIM_HOUSE_RE = /^[\d+\-\/а-я]{1,14}$/;        // «41-43», «50/40+50»

  function makeSet(arr) {
    const o = {};
    arr.forEach(function (x) { o[x] = true; });
    return o;
  }

  function normalizeText(s) {
    return String(s).toLowerCase().replace(/ё/g, "е")
      .replace(/[«»"']/g, " ")
      .replace(/[.,;:]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function dropCityAndDistrict(tokens) {
    const result = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (CITY_TOKENS[t] || SERVICE_MARKERS[t]) continue;
      if (t === "район") {
        if (result.length) result.pop();
        continue;
      }
      result.push(t);
    }
    return result;
  }

  function parseAddress(text) {
    const s = normalizeText(text);
    if (!s) return null;
    const tokens = dropCityAndDistrict(s.split(" ").map(function (t) { return ABBREV[t] || t; }));

    const streetTokens = [];
    let house = "";
    let corpus = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (STOP_MARKERS[t]) break;

      const g = t.match(GLUED_CORPUS_RE);
      if (g) {
        if (!corpus) corpus = g[1];
        continue;
      }
      if (CORPUS_MARKERS[t] && i + 1 < tokens.length && /^[0-9а-я]{1,4}$/.test(tokens[i + 1])) {
        corpus = tokens[i + 1];
        i++;
        continue;
      }
      const hc = t.match(GLUED_HOUSE_CORPUS_RE);
      if (hc && !house) {
        house = hc[1];
        if (!corpus) corpus = hc[2];
        continue;
      }
      const m = t.match(HOUSE_RE) || t.match(GLUED_HOUSE_RE);
      if (m && !house) {
        house = m[1] + (m[2] || "") + (m[3] ? "/" + m[3] : "");
        continue;
      }
      if (!house && VERBATIM_HOUSE_RE.test(t) && /\d/.test(t)) {
        house = t;   // диапазоны и составные номера: «41-43», «50/40+50»
        continue;
      }
      if (HOUSE_RE.test(t) && house && !corpus) {
        corpus = t.replace(/\s/g, "");
        continue;
      }
      streetTokens.push(t);
    }

    if (!house || !streetTokens.length) return null;
    return { streetTokens: streetTokens, house: house, corpus: corpus };
  }

  function sortedKey(tokens) {
    return tokens.slice().sort().join(" ");
  }

  function damerauLevenshtein(a, b) {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (!la) return lb;
    if (!lb) return la;
    const d = [];
    for (let i = 0; i <= la; i++) d.push([i].concat(new Array(lb).fill(0)));
    for (let j = 0; j <= lb; j++) d[0][j] = j;
    for (let i = 1; i <= la; i++) {
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
        }
      }
    }
    return d[la][lb];
  }

  function jaroWinkler(a, b) {
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    if (!la || !lb) return 0;
    const window = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
    const aMatch = new Array(la).fill(false);
    const bMatch = new Array(lb).fill(false);
    let matches = 0;
    for (let i = 0; i < la; i++) {
      const start = Math.max(0, i - window);
      const end = Math.min(i + window + 1, lb);
      for (let j = start; j < end; j++) {
        if (!bMatch[j] && a[i] === b[j]) {
          aMatch[i] = true; bMatch[j] = true; matches++;
          break;
        }
      }
    }
    if (!matches) return 0;
    let transp = 0, k = 0;
    for (let i = 0; i < la; i++) {
      if (aMatch[i]) {
        while (!bMatch[k]) k++;
        if (a[i] !== b[k]) transp++;
        k++;
      }
    }
    transp = Math.floor(transp / 2);
    const jaro = (matches / la + matches / lb + (matches - transp) / matches) / 3;
    let prefix = 0;
    for (let i = 0; i < Math.min(4, la, lb); i++) {
      if (a[i] === b[i]) prefix++; else break;
    }
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    const dl = 1 - damerauLevenshtein(a, b) / Math.max(a.length, b.length);
    return Math.max(dl, jaroWinkler(a, b));
  }

  function queryKey(query, kind) {
    if (kind === "full") return sortedKey(query.streetTokens);
    return sortedKey(query.streetTokens.filter(function (t) {
      return !STREET_TYPES[t] && !PLACE_TYPES[t];
    }));
  }

  function houseMatches(query, h) {
    const qh = query.house;
    const hh = h.house || "";
    let ok = false;
    if (hh.indexOf("+") >= 0) {
      // «50/40+50» — любая из частей
      ok = hh.split("+").some(function (part) { return part === qh; });
    } else if (hh.indexOf("-") >= 0) {
      // «41-43», «25-27/1» — номер внутри диапазона
      const range = hh.match(/^(\d{1,4})-(\d{1,4})/);
      const qn = qh.match(/^(\d{1,4})/);
      if (range && qn) {
        const q = parseInt(qn[1], 10);
        ok = q >= parseInt(range[1], 10) && q <= parseInt(range[2], 10);
      } else {
        ok = hh === qh;
      }
    } else {
      ok = hh === qh;
    }
    if (!ok) return false;
    if (query.corpus) return h.corpus === query.corpus;
    return true;
  }

  function streetExact(query, h) {
    if (queryKey(query, "full") === h.fullKey) return true;
    const qn = queryKey(query, "name");
    if (!qn) return false;
    if (qn === h.nameKey) return true;
    // часть названия: «пешкова» = «пешкова алеши», «изумрудная» = «культура изумрудная»
    const qt = qn.split(" "), ht = h.nameKey.split(" ");
    const subset = function (a, b) { return a.every(function (x) { return b.indexOf(x) >= 0; }); };
    return subset(qt, ht) || subset(ht, qt);
  }

  function search(houses, query) {
    const exact = houses.filter(function (h) {
      return streetExact(query, h) && houseMatches(query, h);
    });
    if (exact.length) return { status: "exact", houses: exact, note: "" };

    const fuzzy = [];
    houses.forEach(function (h) {
      if (!houseMatches(query, h)) return;
      const sim = Math.max(similarity(queryKey(query, "name"), h.nameKey),
                           similarity(queryKey(query, "full"), h.fullKey));
      if (sim >= FUZZY_THRESHOLD) fuzzy.push({ sim: sim, house: h });
    });
    if (fuzzy.length) {
      fuzzy.sort(function (a, b) { return b.sim - a.sim; });
      const best = fuzzy[0].sim;
      let top = fuzzy.filter(function (x) { return x.sim >= best - 0.05; }).map(function (x) { return x.house; });
      if (!top.length) top = fuzzy.slice(0, MAX_SUGGESTIONS).map(function (x) { return x.house; });
      let note = "";
      if (fuzzy[0].house.nameKey !== queryKey(query, "name")) {
        note = "Возможно, вы имели в виду: «" + fuzzy[0].house.address.trim() + "»";
      }
      return { status: "fuzzy", houses: top, note: note };
    }

    const candidates = [];
    houses.forEach(function (h) {
      const sim = Math.max(similarity(queryKey(query, "name"), h.nameKey),
                           similarity(queryKey(query, "full"), h.fullKey));
      const hs = h.house ? similarity(query.house, h.house) : 0;
      const score = sim * 0.75 + hs * 0.25;
      if (sim >= FUZZY_THRESHOLD - 0.1 || (hs >= 0.9 && sim >= 0.6)) {
        candidates.push({ score: score, house: h });
      }
    });
    candidates.sort(function (a, b) { return b.score - a.score; });
    const seen = {}, uniq = [];
    for (let i = 0; i < candidates.length; i++) {
      const addr = candidates[i].house.address;
      if (!seen[addr]) {
        seen[addr] = true;
        uniq.push(candidates[i].house);
      }
      if (uniq.length >= MAX_SUGGESTIONS) break;
    }
    if (uniq.length) return { status: "candidates", houses: uniq, note: "" };
    return { status: "none", houses: [], note: "" };
  }

  // -------------------------------------------------------------------------
  // Интерфейс
  // -------------------------------------------------------------------------
  const SKIP_VALUES = ["nan", "нет", "none", "0", "-"];

  // «19273.17» -> «19 273,17»
  function formatNum(v) {
    const s = String(v).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
    const neg = s[0] === "-";
    const parts = (neg ? s.slice(1) : s).split(".");
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return (neg ? "-" : "") + intPart + (parts[1] ? "," + parts[1] : "");
  }

  function fieldValue(house, name, fmt) {
    let v = house.data[name];
    if (v === undefined || v === null) return "";
    v = String(v).trim();
    if (!v || SKIP_VALUES.indexOf(v.toLowerCase()) >= 0) return "";
    return fmt ? formatNum(v) : v;
  }

  // Связный текст для вставки в справку
  function spravkaText(house) {
    const d = house.data || {};
    const sents = [];

    let addr = house.address.trim().replace(/\s+/g, " ");
    let district = fieldValue(house, "Район");
    if (district && district.indexOf("сельсовет") < 0 && district.indexOf("район") < 0) {
      district += " район";
    }
    sents.push("Многоквартирный дом, расположенный по адресу: " + addr +
               (district ? " (" + district + ")" : "") + ".");

    const chars = [];
    const year = fieldValue(house, "Год постройки");
    if (year) chars.push("год постройки — " + year);
    const floors = fieldValue(house, "Этажность");
    if (floors) chars.push("этажность — " + floors);
    const entrances = fieldValue(house, "Подъездов");
    if (entrances) chars.push("количество подъездов — " + entrances);
    const flats = fieldValue(house, "Квартир");
    if (flats) chars.push("количество квартир — " + flats);
    if (chars.length) sents.push("Характеристики МКД: " + chars.join(", ") + ".");

    const area = fieldValue(house, "Общая площадь, м²", true);
    const living = fieldValue(house, "Жилая площадь, м²", true);
    const municip = fieldValue(house, "Площадь в муниципальной собственности, м²", true);
    if (area) {
      let t = "Общая площадь помещений составляет " + area + " м²";
      if (living) t += ", в том числе жилых помещений — " + living + " м²";
      sents.push(t + ".");
    }
    if (municip) sents.push("Площадь помещений в муниципальной собственности — " + municip + " м².");

    const cat = fieldValue(house, "Категория благоустройства");
    if (cat) sents.push("Категория МКД по степени благоустройства — " + cat + ".");
    const way = fieldValue(house, "Способ управления");
    if (way) sents.push("Способ управления — " + way + ".");
    const uo = fieldValue(house, "Управляющая организация");
    if (uo) sents.push("Управляющая организация — " + uo + ".");
    const tszh = fieldValue(house, "ТСЖ/ЖСК/ТСН");
    if (tszh) sents.push("ТСЖ/ЖСК/ТСН — " + tszh + ".");
    const emergency = fieldValue(house, "Признание аварийным (реквизиты НПА)");
    if (emergency) sents.push("Признание аварийным (реквизиты НПА) — " + emergency + ".");
    const base = fieldValue(house, "Основание назначения");
    if (base) sents.push("Основание назначения — " + base + ".");
    const comment = fieldValue(house, "Комментарий");
    if (comment) sents.push("Комментарий: " + comment + ".");

    return sents.join(" ");
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // -------------------------------------------------------------------------
  // Каталог: фильтры, сетка карточек, детальный вид
  // -------------------------------------------------------------------------
  const PAGE = 60;
  const state = { list: [], shown: 0, mode: null, note: "" };

  const HOUSE_ICON = '<svg viewBox="0 0 24 24" class="hicon" aria-hidden="true"><path d="M12 3 2.5 11h2.6v9.5h5.4V15h3.2v5.5h5.4V11h2.6L12 3z"/></svg>';

  function currentFilters() {
    return {
      district: document.getElementById("fDistrict").value,
      uk: normalizeText(document.getElementById("fUk").value)
    };
  }

  function applyFilters(list) {
    const f = currentFilters();
    return list.filter(function (h) {
      if (f.district && (h.data["Район"] || "").trim() !== f.district) return false;
      if (f.uk) {
        const ukText = normalizeText((h.data["Управляющая организация"] || "") + " " +
                                     (h.data["ТСЖ/ЖСК/ТСН"] || ""));
        if (ukText.indexOf(f.uk) < 0) return false;
      }
      return true;
    });
  }

  function populateFilters() {
    const districts = {}, uks = {};
    global.HOUSES.forEach(function (h) {
      const d = (h.data["Район"] || "").trim();
      if (d) districts[d] = true;
      const u = (h.data["Управляющая организация"] || "").trim();
      if (u && SKIP_VALUES.indexOf(u.toLowerCase()) < 0) uks[u] = true;
    });
    const byRu = function (a, b) { return a.localeCompare(b, "ru"); };
    const sel = document.getElementById("fDistrict");
    Object.keys(districts).sort(byRu).forEach(function (d) {
      const o = document.createElement("option");
      o.value = d; o.textContent = d;
      sel.appendChild(o);
    });
    const dl = document.getElementById("ukList");
    Object.keys(uks).sort(byRu).forEach(function (u) {
      const o = document.createElement("option");
      o.value = u;
      dl.appendChild(o);
    });
  }

  function houseCard(h, i) {
    const district = (h.data["Район"] || "").trim();
    const uk = fieldValue(h, "Управляющая организация") || fieldValue(h, "ТСЖ/ЖСК/ТСН") || "";
    const year = fieldValue(h, "Год постройки");
    return '<button type="button" class="card-h" data-i="' + i + '">' + HOUSE_ICON +
      '<div style="min-width:0">' +
      '<div class="addr">' + esc(h.address.trim()) + '</div>' +
      '<div class="meta">' +
      (district ? 'Район: <b>' + esc(district) + '</b><br>' : '') +
      (uk ? 'УК: <b>' + esc(uk) + '</b>' : '') +
      '</div>' +
      (year ? '<span class="year">год постройки · ' + esc(year) + '</span>' : '') +
      '</div></button>';
  }

  function renderList() {
    const out = document.getElementById("results");
    const list = state.list;
    state.detailOf = null;
    if (!list.length) {
      out.innerHTML = '<div class="empty">Ничего не найдено. Попробуйте изменить запрос или фильтры.</div>';
      return;
    }
    let html = "";
    if (state.note) html += '<div class="note">' + esc(state.note) + '</div>';
    html += '<div class="count">Найдено: ' + list.length + (list.length === 1 ? " дом" : " домов") +
            (state.mode === "browse" ? " · по фильтрам" : "") + "</div>";
    html += '<div class="grid">' +
      list.slice(0, state.shown).map(function (h, i) { return houseCard(h, i); }).join("") + "</div>";
    if (state.shown < list.length) {
      const left = list.length - state.shown;
      html += '<button type="button" class="more-btn">Показать ещё ' + Math.min(PAGE, left) +
              " из " + left + "</button>";
    }
    out.innerHTML = html;
    out.querySelectorAll(".card-h").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showDetail(list[Number(btn.getAttribute("data-i"))]);
      });
    });
    const more = out.querySelector(".more-btn");
    if (more) {
      more.addEventListener("click", function () {
        state.shown += PAGE;
        renderList();
      });
    }
  }

  function detailCard(house) {
    const rows = [];
    Object.keys(house.data).forEach(function (field) {
      const value = String(house.data[field]).trim();
      if (value && SKIP_VALUES.indexOf(value.toLowerCase()) < 0) {
        rows.push('<div class="row"><div class="k">' + esc(field) + '</div><div class="v">' + esc(value) + '</div></div>');
      }
    });
    const text = spravkaText(house);
    return '<button type="button" class="back" id="backBtn">&#8592; Назад к списку</button>' +
      '<div class="detail">' +
      '<div class="addr">' + esc(house.address.trim()) + '</div>' +
      '<div class="rows">' + rows.join("") + '</div>' +
      '<div class="spravka-title">Текст для справки (можно скопировать)</div>' +
      '<textarea class="spravka" readonly>' + esc(text) + '</textarea>' +
      '<div class="btn-row"><button class="copy-btn" type="button">Скопировать текст</button></div>' +
      '<div class="map-box"><iframe id="mapframe" title="Карта: ' + esc(house.address.trim()) + '" allowfullscreen></iframe>' +
      '<div class="map-cap">Интерактивная карта — её можно двигать и приближать. Подгружается с Яндекса.</div></div>' +
      '</div>';
  }

  function showDetail(house) {
    const out = document.getElementById("results");
    out.innerHTML = detailCard(house);
    bindCopyButtons(out);
    document.getElementById("backBtn").addEventListener("click", function () {
      renderList();
      document.getElementById("poisk").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const frame = document.getElementById("mapframe");
    if (frame) {
      frame.src = "https://yandex.ru/map-widget/v1/?text=" + encodeURIComponent(house.address.trim()) + "&z=17";
    }
    out.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bindCopyButtons(root) {
    root.querySelectorAll(".copy-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const card = btn.closest(".detail");
        const ta = card ? card.querySelector(".spravka") : null;
        if (!ta) return;
        const done = function () {
          btn.textContent = "Скопировано!";
          setTimeout(function () { btn.textContent = "Скопировать текст"; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand("copy"); done(); });
        } else {
          ta.select(); document.execCommand("copy"); done();
        }
      });
    });
  }

  function runSearch(scroll) {
    const q = document.getElementById("q").value;
    const out = document.getElementById("results");
    const parsed = parseAddress(q);
    if (parsed) {
      const res = search(global.HOUSES, parsed);
      state.mode = "search";
      state.note = res.status === "candidates" ? "Точного совпадения нет. Похожие адреса:" : res.note;
      state.list = applyFilters(res.houses);
    } else if (!q.trim()) {
      const f = currentFilters();
      if (!f.district && !f.uk) {
        out.innerHTML = '<div class="empty">Введите улицу и номер дома — например, <b>минина 11</b>, — или выберите район / управляющую компанию выше.</div>';
        return;
      }
      state.mode = "browse";
      state.note = "";
      const all = global.HOUSES.slice().sort(function (a, b) { return a.address.localeCompare(b.address, "ru"); });
      state.list = applyFilters(all);
    } else {
      out.innerHTML = '<div class="empty">Не понял адрес. Напишите улицу и номер дома, например: <b>минина 11</b>, <b>верхне-волжская 9/1</b></div>';
      return;
    }
    state.shown = Math.min(PAGE, state.list.length);
    renderList();
    if (scroll) {
      document.getElementById("poisk").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function initUI() {
    populateFilters();
    document.getElementById("btn").addEventListener("click", function () { runSearch(true); });
    document.getElementById("q").addEventListener("keydown", function (e) {
      if (e.key === "Enter") runSearch(true);
    });
    document.getElementById("fDistrict").addEventListener("change", function () { runSearch(false); });
    let t = null;
    document.getElementById("fUk").addEventListener("input", function () {
      clearTimeout(t);
      t = setTimeout(function () { runSearch(false); }, 350);
    });
  }

  // Экспорт для тестов (Node) и для страницы
  const api = { parseAddress: parseAddress, search: search, similarity: similarity,
                normalizeText: normalizeText, sortedKey: sortedKey, makeSet: makeSet,
                spravkaText: spravkaText, formatNum: formatNum,
                STREET_TYPES: STREET_TYPES, PLACE_TYPES: PLACE_TYPES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ZhkhSearch = api;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initUI);
    } else {
      initUI();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
