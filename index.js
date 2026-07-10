import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const KAZAN_DISTRICTS = [
  "Авиастроительный", "Вахитовский", "Кировский", "Московский",
  "Ново-Савиновский", "Приволжский", "Советский",
  "Лаишевский", "Высокогорский", "Пестречинский",
  "Зеленодольский", "Верхнеуслонский"
];

const KNOWN_DEVELOPERS = [
  "Унистрой", "Ак Барс Дом", "Суварстроит", "Новастрой",
  "ПИК", "Самолет", "Самолёт", "СМУ-88", "ГК ЖИК",
  "Талан", "Брусника", "КамаСтройИнвест", "Комосстрой"
];

const DISTRICT_HINTS = [
  { district: "Советский", words: ["советский", "ершова", "новаторов", "курынова", "мамадышский тракт", "art city", "арт сити", "nova", "лето"] },
  { district: "Приволжский", words: ["приволжский", "кулагина", "ачинская", "средний кабан", "кабан", "детский проезд", "станция спортивная", "отражение", "времена года"] },
  { district: "Вахитовский", words: ["вахитовский", "центр казани", "пушкина", "карла маркса", "баумана", "бутлерова"] },
  { district: "Ново-Савиновский", words: ["ново-савиновский", "новосавиновский", "чистопольская", "сибгата хакима", "амирхана"] },
  { district: "Московский", words: ["московский", "декабристов", "восстания", "серова", "ибрагимова"] },
  { district: "Кировский", words: ["кировский", "адмиралтейская", "клары цеткин", "залесный"] },
  { district: "Авиастроительный", words: ["авиастроительный", "авиастрой", "ленинградская", "копылова"] },
  { district: "Лаишевский", words: ["лаишевский", "усады", "южный парк", "уютная"] },
  { district: "Высокогорский", words: ["высокогорский", "высокая гора", "атмосфера"] },
  { district: "Пестречинский", words: ["пестречинский", "царево", "царёво", "tsarevo"] },
  { district: "Зеленодольский", words: ["зеленодольский", "зеленодольск"] },
  { district: "Верхнеуслонский", words: ["верхнеуслонский", "верхний услон"] }
];

function cleanText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.—–-]+|[\s:;,.—–-]+$/g, "")
    .trim();
}

function normalize(value = "") {
  return cleanText(value).toLowerCase().replaceAll("ё", "е");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function unique(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = cleanText(item);
    const key = normalize(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function absoluteUrl(url, baseUrl) {
  if (!url) return "";
  try { return new URL(url, baseUrl).toString(); } catch { return ""; }
}

function safeUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || "").trim()); }
  catch { throw new Error("Некорректная ссылка"); }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Поддерживаются только http и https ссылки");
  }

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
    host.startsWith("10.") || host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error("Эту ссылку нельзя парсить");
  }

  return url;
}

function getMeta($, name) {
  return cleanText(
    $(`meta[property="${name}"]`).attr("content") ||
    $(`meta[name="${name}"]`).attr("content") ||
    ""
  );
}

function flattenJsonLd(value) {
  const result = [];

  function walk(item) {
    if (!item) return;
    if (Array.isArray(item)) return item.forEach(walk);
    if (typeof item !== "object") return;

    result.push(item);
    if (Array.isArray(item["@graph"])) item["@graph"].forEach(walk);
    if (item.mainEntity) walk(item.mainEntity);
    if (item.itemListElement) walk(item.itemListElement);
    if (item.offers) walk(item.offers);
    if (item.address) walk(item.address);
  }

  walk(value);
  return result;
}

function extractJsonLd($) {
  const nodes = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;

    try {
      nodes.push(...flattenJsonLd(JSON.parse(raw)));
    } catch {
      // Некоторые сайты кладут невалидный JSON-LD. Просто пропускаем.
    }
  });

  return nodes;
}

function extractNextData($) {
  const raw = $("#__NEXT_DATA__").text();
  if (!raw) return "";

  try { return cleanText(JSON.stringify(JSON.parse(raw))); }
  catch { return cleanText(raw); }
}

function firstString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const found = firstString(...value);
      if (found) return found;
    } else if (typeof value === "string" && cleanText(value)) {
      return cleanText(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    } else if (value && typeof value === "object") {
      const found = firstString(
        value.name, value.headline, value.description,
        value.streetAddress, value.addressLocality, value.addressRegion,
        value.price, value.lowPrice, value.url
      );
      if (found) return found;
    }
  }

  return "";
}

function jsonLdValue(nodes, keys) {
  for (const node of nodes) {
    for (const key of keys) {
      const value = firstString(node[key]);
      if (value) return value;
    }
  }

  return "";
}

function collectChunks($) {
  const chunks = [];

  $("h1,h2,h3,h4,p,li,dt,dd,span,div,a").each((_, el) => {
    const text = cleanText($(el).text());
    if (!text || text.length < 2 || text.length > 900) return;
    if (/^(меню|позвонить|заказать звонок|избранное|сравнение|политика|cookie|войти|регистрация)$/i.test(text)) return;
    chunks.push(text);
  });

  return unique(chunks);
}

function findNearbyValue(chunks, labels, maxLen = 150) {
  const labelsNorm = labels.map(normalize);

  for (let i = 0; i < chunks.length; i += 1) {
    const current = chunks[i];
    const currentNorm = normalize(current);

    for (const label of labelsNorm) {
      if (currentNorm === label || currentNorm.startsWith(label + " ") || currentNorm.startsWith(label + ":")) {
        const sameLine = cleanText(current.replace(new RegExp(`^${label}[\\s:—–-]*`, "i"), ""));
        if (sameLine && sameLine.length <= maxLen && normalize(sameLine) !== label) return sameLine;

        const next = cleanText(chunks[i + 1] || "");
        if (next && next.length <= maxLen) return next;
      }
    }
  }

  return "";
}

function cleanTitle(value) {
  return cleanText(value)
    .replace(/\s*[|].*$/g, "")
    .replace(/\s+в\s+казани.*$/i, "")
    .replace(/\s+от\s+застройщика.*$/i, "")
    .replace(/\s+официальный.*$/i, "")
    .replace(/\s+купить.*$/i, "")
    .slice(0, 90);
}

function findTitle($, nodes, chunks, fullText, url) {
  const urlPart = decodeURIComponent(new URL(url).pathname).replace(/[\/_-]+/g, " ");

  const candidates = unique([
    $("h1").first().text(),
    jsonLdValue(nodes, ["name", "headline"]),
    getMeta($, "og:title"),
    $("title").first().text(),
    urlPart,
    ...chunks.filter((item) => /^(жк|жилой комплекс|квартал|резиденция)\b/i.test(item)).slice(0, 8)
  ]);

  for (const raw of candidates) {
    const prepared = cleanTitle(raw);
    const match = prepared.match(/(?:ЖК|жилой комплекс)\s+[«"]?([^»"|—–,-]{2,80})/i);

    if (match) return cleanTitle("ЖК " + match[1]);

    if (/^(art city|аквамарин|атмосфера|царево|уникум|q на кулагина|отражение|времена года|nova)$/i.test(prepared)) {
      return cleanTitle("ЖК " + prepared);
    }

    if (/^(жк|квартал|резиденция)\b/i.test(prepared) && prepared.length <= 80) {
      return cleanTitle(prepared);
    }
  }

  const fromText = fullText.match(/(?:ЖК|жилой комплекс)\s+[«"]?([^»"|—–,-]{2,80})/i);
  return fromText ? cleanTitle("ЖК " + fromText[1]) : "";
}

function findDeveloper(fullText, url) {
  const value = normalize(`${fullText} ${url}`);

  for (const developer of KNOWN_DEVELOPERS) {
    if (value.includes(normalize(developer))) return developer;
  }

  const host = new URL(url).hostname.toLowerCase();
  if (host.includes("unistro")) return "Унистрой";
  if (host.includes("suvar")) return "Суварстроит";
  if (host.includes("akbars")) return "Ак Барс Дом";
  if (host.includes("novastroy")) return "Новастрой";

  const match = fullText.match(/(?:застройщик|девелопер|строительная компания)[:\s—–-]+([А-Яа-яA-Za-z0-9\s\-«»"'.#]{2,70})/i);
  if (!match) return "";

  return cleanText(match[1])
    .replace(/[.,;:].*$/, "")
    .replace(/\s+(предлагает|реализует|строит).*$/i, "")
    .slice(0, 70);
}

function findCity(fullText, url) {
  const value = normalize(`${fullText} ${url}`);
  if (value.includes("казань") || value.includes("казани") || value.includes("kazan") || value.includes("kzn")) return "Казань";
  return "Казань";
}

function cleanAddress(value) {
  return cleanText(value)
    .replace(/^(адрес|расположение|локация|местоположение)[:\s—–-]+/i, "")
    .replace(/\s+(цены|квартиры|планировки|выбрать|ипотека|ход строительства|срок).*$/i, "")
    .replace(/,\s*Казань\s*$/i, "")
    .slice(0, 120);
}

function findAddress(nodes, chunks, fullText) {
  const streetWords = "(?:ул\\.?|улица|проспект|пр-т|пр\\.|шоссе|тракт|бульвар|бул\\.?|пер\\.?|переулок|проезд|наб\\.?|набережная)";

  const jsonAddress = jsonLdValue(nodes, ["address", "streetAddress"]);
  if (jsonAddress && new RegExp(streetWords, "i").test(jsonAddress)) return cleanAddress(jsonAddress);

  const nearby = findNearbyValue(chunks, ["адрес", "расположение", "локация", "местоположение"], 150);
  if (nearby && (new RegExp(streetWords, "i").test(nearby) || /район|с\.|поселок|посёлок|деревня/i.test(nearby))) {
    return cleanAddress(nearby);
  }

  const patterns = [
    new RegExp(`((?:${streetWords})\\s+[А-Яа-яA-Za-z0-9ёЁ\\s\\-.,/№]+?)(?=\\s+(?:цены|квартиры|планировки|от\\s+\\d|срок|комнат|район|застройщик)|[.;]|$)`, "i"),
    /((?:с\.|поселок|посёлок|д\.|деревня)\s+[А-Яа-яA-Za-z0-9ёЁ\s\-.,/№]+?)(?=\s+(?:цены|квартиры|планировки|от\s+\d|срок|комнат|район|застройщик)|[.;]|$)/i,
    /(?:адрес|расположение|локация|местоположение)[:\s—–-]+([^.;]{8,150})/i
  ];

  for (const pattern of patterns) {
    const match = fullText.match(pattern);
    if (match) return cleanAddress(match[1]);
  }

  return "";
}

function findDistrict(fullText, address, url) {
  const value = normalize(`${fullText} ${address} ${url}`);

  for (const district of KAZAN_DISTRICTS) {
    const key = normalize(district).replace(" район", "");
    if (value.includes(key)) return district;
  }

  let best = { district: "", score: 0 };
  for (const item of DISTRICT_HINTS) {
    const score = item.words.reduce((sum, word) => sum + (value.includes(normalize(word)) ? 1 : 0), 0);
    if (score > best.score) best = { district: item.district, score };
  }

  return best.score ? best.district : "";
}

function parsePriceCandidate(rawNumber, unit = "") {
  const text = String(rawNumber || "")
    .replace(/\s/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "");

  if (!text) return 0;

  let parsed = Number(text);
  if (!Number.isFinite(parsed)) return 0;

  const unitValue = normalize(unit);
  if (unitValue.includes("млн") || unitValue.includes("миллион")) parsed *= 1000000;
  if (unitValue.includes("тыс")) parsed *= 1000;
  if (parsed < 100000 && /^\d{1,3}(\.\d+)?$/.test(text)) parsed *= 1000000;

  return parsed >= 1000000 && parsed <= 100000000 ? Math.round(parsed) : 0;
}

function findPrice(nodes, chunks, fullText) {
  const offerPrice = jsonLdValue(nodes, ["lowPrice", "price"]);
  const jsonPrice = parsePriceCandidate(offerPrice);
  if (jsonPrice) return jsonPrice;

  const zones = unique([
    findNearbyValue(chunks, ["цена от", "стоимость от", "квартиры от"], 120),
    ...chunks.filter((chunk) => /(?:цена|стоимость|квартир[аы]?\s+от|от\s*[\d\s,.]+\s*(?:₽|млн|миллион))/i.test(chunk)).slice(0, 30),
    fullText
  ]);

  const prices = [];
  const patterns = [
    /(?:цена|стоимость|квартиры|квартира)?[^\d]{0,35}от\s*([\d\s]+(?:[,.]\d+)?)\s*(млн|миллион(?:а|ов)?|₽|руб)/gi,
    /от\s*([\d\s]+(?:[,.]\d+)?)\s*(млн|миллион(?:а|ов)?|₽|руб)/gi,
    /([\d\s]{6,})\s*(₽|руб)/gi
  ];

  for (const zone of zones) {
    for (const pattern of patterns) {
      for (const match of zone.matchAll(pattern)) {
        const price = parsePriceCandidate(match[1], match[2] || "");
        if (price) prices.push(price);
      }
    }
  }

  return prices.length ? Math.min(...prices) : 0;
}

function findRooms(chunks, fullText) {
  const zones = unique([
    findNearbyValue(chunks, ["комнаты", "количество комнат", "планировки", "квартиры"], 160),
    ...chunks.filter((chunk) => /студи|комнат|евро|1\s*-|2\s*-|3\s*-|4\s*-/i.test(chunk)).slice(0, 40),
    fullText.slice(0, 7000)
  ]);

  const rooms = [];
  const add = (value) => { if (!rooms.includes(value)) rooms.push(value); };

  for (const rawZone of zones) {
    const value = normalize(rawZone);

    if (/студи|studio/.test(value)) add("студия");

    for (const match of value.matchAll(/(?:от\s*)?(1|2|3|4)\s*(?:-|–|—|до)\s*(1|2|3|4)\s*(?:комн|к|спальн|$)/gi)) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      for (let n = Math.min(start, end); n <= Math.max(start, end); n += 1) add(String(n));
    }

    if (/(^|[^\d])(1|одн|одно)[-\s]?(?:комн|к|спальн)/i.test(value) || /\b1\s*-\s*комнат/i.test(value)) add("1");
    if (/(^|[^\d])(2|двух|две|евро2)[-\s]?(?:комн|к|спальн)/i.test(value) || /\b2\s*-\s*комнат/i.test(value)) add("2");
    if (/(^|[^\d])(3|трех|трёх|три|евро3)[-\s]?(?:комн|к|спальн)/i.test(value) || /\b3\s*-\s*комнат/i.test(value)) add("3");
    if (/(^|[^\d])(4|четырех|четырёх|четыре|евро4)[-\s]?(?:комн|к|спальн)/i.test(value) || /\b4\s*-\s*комнат/i.test(value)) add("4");

    const listMatch = value.match(/(?:комнаты|квартиры|планировки)[^\d]{0,40}((?:студи[яи]|[1-4])(?:\s*,\s*(?:студи[яи]|[1-4])){1,5})/i);
    if (listMatch) {
      listMatch[1].split(/\s*,\s*/).forEach((item) => {
        if (item.includes("студи")) add("студия");
        if (/^[1-4]$/.test(item)) add(item);
      });
    }
  }

  return ["студия", "1", "2", "3", "4"].filter((item) => rooms.includes(item)).join(", ");
}

function findDeadline(chunks, fullText) {
  const zones = unique([
    findNearbyValue(chunks, ["срок сдачи", "сдача", "ввод в эксплуатацию", "срок ввода", "готовность"], 130),
    ...chunks.filter((chunk) => /срок|сдач|ввод|эксплуатац|квартал|очередь|дом сдан/i.test(chunk)).slice(0, 40),
    fullText.slice(0, 12000)
  ]);

  const years = [];
  for (const zone of zones) {
    const value = normalize(zone);
    const patterns = [
      /(?:срок\s*сдачи|сдача|сдается|сдаётся|ввод\s*в\s*эксплуатацию|срок\s*ввода|готовность)[^0-9]{0,80}(20\d{2})/gi,
      /([1-4]|i|ii|iii|iv)\s*(?:квартал|кв\.?)\s*(20\d{2})/gi,
      /(20\d{2})\s*(?:год|г\.|года|квартал|кв\.?)/gi
    ];

    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const year = [match[1], match[2]].find((item) => /20\d{2}/.test(String(item || "")));
        if (year) years.push(Number(year));
      }
    }
  }

  const filtered = years.filter((year) => year >= 2020 && year <= 2035);
  if (!filtered.length) return "";

  const currentYear = new Date().getFullYear();
  const future = filtered.filter((year) => year >= currentYear);
  return String(Math.min(...(future.length ? future : filtered)));
}

function findPropertyClass(chunks, fullText) {
  const value = normalize(`${findNearbyValue(chunks, ["класс", "класс жилья", "формат"], 80)} ${fullText}`);
  if (value.includes("бизнес")) return "бизнес";
  if (value.includes("комфорт")) return "комфорт";
  if (value.includes("эконом")) return "эконом";
  return "комфорт";
}

function findMetroMinutes(chunks, fullText) {
  const zones = unique([
    findNearbyValue(chunks, ["до метро", "до остановки", "транспорт", "как добраться"], 130),
    ...chunks.filter((chunk) => /мин|метро|останов|транспорт|пешком|ходьбы/i.test(chunk)).slice(0, 40),
    fullText.slice(0, 8000)
  ]);

  const patterns = [
    /(\d{1,2})\s*(?:мин|минут)[^а-яa-z0-9]{0,40}(?:до\s*)?(?:метро|останов|транспорт)/i,
    /(?:метро|останов|транспорт)[^0-9]{0,50}(\d{1,2})\s*(?:мин|минут)/i,
    /(\d{1,2})\s*(?:мин|минут)\s*(?:пешком|ходьбы)/i
  ];

  for (const zone of zones) {
    const value = normalize(zone);
    for (const pattern of patterns) {
      const number = Number(value.match(pattern)?.[1]);
      if (Number.isFinite(number) && number > 0 && number < 90) return number;
    }
  }

  return 0;
}

function findBoolean(fullText, words) {
  const value = normalize(fullText);
  return words.some((word) => value.includes(normalize(word)));
}

function findImage($, nodes, baseUrl) {
  const candidates = unique([
    getMeta($, "og:image"),
    getMeta($, "twitter:image"),
    jsonLdValue(nodes, ["image", "photo", "thumbnailUrl"]),
    ...$("img").map((_, el) =>
      $(el).attr("src") ||
      $(el).attr("data-src") ||
      $(el).attr("data-lazy-src") ||
      $(el).attr("data-original") ||
      $(el).attr("srcset")?.split(",").pop()?.trim()?.split(" ")[0] ||
      ""
    ).get().filter(Boolean)
  ]);

  const bad = /logo|icon|sprite|favicon|placeholder|map|qr|arrow|vk|telegram|whatsapp/i;
  const good = /\.(jpg|jpeg|png|webp)(\?|$)/i;

  for (const candidate of candidates) {
    const image = absoluteUrl(candidate, baseUrl);
    if (!image || bad.test(image)) continue;
    if (good.test(image) || /image|upload|storage|cdn/i.test(image)) return image;
  }

  return candidates[0] ? absoluteUrl(candidates[0], baseUrl) : "";
}

function buildDescription($, nodes, chunks, fullText, title, district, developer) {
  const candidates = unique([
    jsonLdValue(nodes, ["description"]),
    getMeta($, "description"),
    getMeta($, "og:description"),
    ...chunks.filter((chunk) =>
      chunk.length >= 70 &&
      chunk.length <= 550 &&
      !/cookie|ипотек|заявк|оставьте|телефон|политик|фильтр|соглас|звонок/i.test(chunk)
    )
  ]);

  const scored = candidates.map((text) => {
    const value = normalize(text);
    let score = 0;

    if (value.includes("жилой комплекс") || value.includes("жк")) score += 4;
    if (title && value.includes(normalize(title).replace(/^жк\s+/, ""))) score += 4;
    if (district && value.includes(normalize(district))) score += 2;
    if (developer && value.includes(normalize(developer))) score += 2;
    if (/двор|парк|школ|сад|паркинг|набереж|инфраструктур|транспорт|квартир|благоустрой/i.test(value)) score += 3;
    if (/скидк|акци|ипотек|рассроч|оставьте|звонок|подобрать/i.test(value)) score -= 4;

    return { text: cleanText(text), score };
  }).sort((a, b) => b.score - a.score);

  const best = scored.find((item) => item.score > 0)?.text || scored[0]?.text || "";
  const sentences = cleanText(best).split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length >= 35).slice(0, 3);

  return cleanText(sentences.length ? sentences.join(" ") : best).slice(0, 700);
}

function scoreTransport(metroMinutes) {
  if (!metroMinutes) return 60;
  if (metroMinutes <= 10) return 90;
  if (metroMinutes <= 20) return 78;
  if (metroMinutes <= 30) return 68;
  return 55;
}

function scoreInfrastructure({ parking, schools, kindergarten, shops }) {
  let score = 45;
  if (parking) score += 12;
  if (schools) score += 15;
  if (kindergarten) score += 15;
  if (shops) score += 13;
  return clamp(score, 0, 100);
}

function scorePrice(price) {
  if (!price) return 60;
  if (price <= 7000000) return 90;
  if (price <= 10000000) return 80;
  if (price <= 14000000) return 68;
  if (price <= 18000000) return 58;
  return 48;
}

function scoreDeveloper(developer) {
  if (!developer) return 60;
  return KNOWN_DEVELOPERS.some((item) => normalize(item) === normalize(developer)) ? 85 : 70;
}

function scoreDeadline(deadline) {
  const year = Number(String(deadline).match(/20\d{2}/)?.[0]);
  if (!year) return 60;

  const currentYear = new Date().getFullYear();
  if (year <= currentYear + 1) return 88;
  if (year <= currentYear + 2) return 78;
  if (year <= currentYear + 3) return 68;
  return 55;
}

function totalRating(scores) {
  return Math.round(
    scores.transport_score * 0.25 +
    scores.infrastructure_score * 0.25 +
    scores.price_score * 0.20 +
    scores.developer_score * 0.20 +
    scores.deadline_score * 0.10
  );
}

function buildMatchText(data) {
  const parts = [];

  if (data.property_class) parts.push(`Подходит тем, кто рассматривает жильё класса ${data.property_class}.`);
  if (data.district) parts.push(`Локация — ${data.district} район или ближайшая к нему территория.`);
  if (data.price_from) parts.push(`Цена начинается от ${data.price_from.toLocaleString("ru-RU")} ₽.`);
  if (data.developer) parts.push(`Проект от застройщика ${data.developer}.`);

  const infra = [];
  if (data.parking) infra.push("парковка");
  if (data.schools_nearby) infra.push("школы");
  if (data.kindergarten_nearby) infra.push("детские сады");
  if (data.shops_nearby) infra.push("магазины");

  if (infra.length) parts.push(`Рядом есть важная инфраструктура: ${infra.join(", ")}.`);
  if (data.metro_minutes) parts.push(`До метро или остановки примерно ${data.metro_minutes} минут.`);

  return parts.join(" ") || "Подходит для сравнения по цене, району, инфраструктуре и рейтингу.";
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8"
      }
    });

    if (!response.ok) {
      throw new Error(`Не удалось загрузить страницу. Статус: ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseHtml(html, url) {
  const $ = cheerio.load(html);
  const jsonLdNodes = extractJsonLd($);
  const nextDataText = extractNextData($);

  const metaTitle = getMeta($, "og:title") || $("title").first().text();
  const metaDescription = getMeta($, "description") || getMeta($, "og:description");

  $("script, style, noscript, svg, canvas").remove();

  const chunks = collectChunks($);
  const bodyText = cleanText($("body").text());
  const fullText = cleanText(`${metaTitle} ${metaDescription} ${bodyText} ${nextDataText}`);

  const title = findTitle($, jsonLdNodes, chunks, fullText, url);
  const developer = findDeveloper(fullText, url);
  const city = findCity(fullText, url);
  const address = findAddress(jsonLdNodes, chunks, fullText);
  const district = findDistrict(fullText, address, url);
  const price_from = findPrice(jsonLdNodes, chunks, fullText);
  const rooms = findRooms(chunks, fullText);
  const deadline = findDeadline(chunks, fullText);
  const property_class = findPropertyClass(chunks, fullText);
  const metro_minutes = findMetroMinutes(chunks, fullText);
  const image = findImage($, jsonLdNodes, url);

  const parking = findBoolean(fullText, ["парковка", "паркинг", "машиномест", "машино-мест", "двор без машин", "подземный паркинг"]);
  const schools_nearby = findBoolean(fullText, ["школа", "школы", "образовательный центр", "гимназия", "лицей"]);
  const kindergarten_nearby = findBoolean(fullText, ["детский сад", "детские сады", "садик", "дошколь", "детсады", "детсад"]);
  const shops_nearby = findBoolean(fullText, ["магазин", "магазины", "супермаркет", "торговый центр", "тц", "пятерочка", "пятёрочка", "магнит", "ритейл", "коммерческие помещения"]);

  const description = buildDescription($, jsonLdNodes, chunks, fullText, title, district, developer);

  const scores = {
    transport_score: scoreTransport(metro_minutes),
    infrastructure_score: scoreInfrastructure({
      parking,
      schools: schools_nearby,
      kindergarten: kindergarten_nearby,
      shops: shops_nearby
    }),
    price_score: scorePrice(price_from),
    developer_score: scoreDeveloper(developer),
    deadline_score: scoreDeadline(deadline)
  };

  const data = {
    title,
    developer,
    city,
    district,
    address,
    price_from,
    rooms,
    deadline,
    property_class,
    metro_minutes,
    status: "draft",
    image,
    parking,
    schools_nearby,
    kindergarten_nearby,
    shops_nearby,
    ...scores,
    total_rating: totalRating(scores),
    description,
    match_text: "",
    source_url: url
  };

  data.match_text = buildMatchText(data);
  return data;
}

async function parseNewbuilding(url) {
  const safe = safeUrl(url);
  const html = await fetchPage(safe.toString());
  return parseHtml(html, safe.toString());
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "HomeSense parser API",
    endpoints: {
      health: "GET /health",
      parseGet: "GET /parse-newbuilding?url=https://example.com",
      parsePost: "POST /parse-newbuilding"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/parse-newbuilding", async (req, res) => {
  try {
    const data = await parseNewbuilding(req.query.url);
    res.json({ ok: true, data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: error.message || "Ошибка парсинга" });
  }
});

app.post("/parse-newbuilding", async (req, res) => {
  try {
    const data = await parseNewbuilding(req.body?.url);
    res.json({ ok: true, data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: error.message || "Ошибка парсинга" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HomeSense parser API started on port ${PORT}`);
});
