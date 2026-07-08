import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const KAZAN_DISTRICTS = [
  "Вахитовский",
  "Авиастроительный",
  "Кировский",
  "Московский",
  "Ново-Савиновский",
  "Приволжский",
  "Советский"
];

const KNOWN_DEVELOPERS = [
  "Унистрой",
  "Ак Барс Дом",
  "Суварстроит",
  "ПИК",
  "Самолет",
  "Самолёт",
  "СМУ-88",
  "ГК ЖИК",
  "Талан",
  "Брусника",
  "КамаСтройИнвест",
  "Комосстрой"
];

function cleanText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value = "") {
  return cleanText(value).toLowerCase().replaceAll("ё", "е");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function absoluteUrl(url, baseUrl) {
  if (!url) return "";

  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return "";
  }
}

function getMeta($, name) {
  return cleanText(
    $(`meta[property="${name}"]`).attr("content") ||
    $(`meta[name="${name}"]`).attr("content") ||
    ""
  );
}

function safeUrl(rawUrl) {
  let url;

  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("Некорректная ссылка");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Поддерживаются только http и https ссылки");
  }

  const host = url.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error("Эту ссылку нельзя парсить");
  }

  return url;
}

function flattenJsonLd(value) {
  const result = [];

  function walk(item) {
    if (!item) return;

    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }

    if (typeof item === "object") {
      result.push(item);
      if (Array.isArray(item["@graph"])) item["@graph"].forEach(walk);
      if (item.mainEntity) walk(item.mainEntity);
      if (item.itemListElement) walk(item.itemListElement);
    }
  }

  walk(value);
  return result;
}

function extractJsonLd($) {
  const nodes = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = cleanText($(el).text());
    if (!raw) return;

    try {
      nodes.push(...flattenJsonLd(JSON.parse(raw)));
    } catch {
      // Сайты часто кладут невалидный JSON-LD. Просто пропускаем.
    }
  });

  return nodes;
}

function firstString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const found = firstString(...value);
      if (found) return found;
    } else if (typeof value === "string" && cleanText(value)) {
      return cleanText(value);
    } else if (value && typeof value === "object") {
      const found = firstString(value.name, value.streetAddress, value.addressLocality, value.url);
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

function findTitle($, nodes, fullText) {
  const jsonTitle = jsonLdValue(nodes, ["name", "headline"]);
  const raw = cleanText(
    jsonTitle ||
    getMeta($, "og:title") ||
    $("h1").first().text() ||
    $("title").first().text()
  );

  if (!raw) return "";

  const direct = raw.match(/(?:ЖК|жилой комплекс)\s+[«\"]?([^»\"|—,-]{2,80})/i);
  if (direct) return cleanText("ЖК " + direct[1]).replace(/\s+в\s+казани.*$/i, "");

  const fromText = fullText.match(/(?:ЖК|жилой комплекс)\s+[«\"]?([^»\"|—,-]{2,80})/i);
  if (fromText) return cleanText("ЖК " + fromText[1]).replace(/\s+в\s+казани.*$/i, "");

  return raw
    .split("|")[0]
    .split("—")[0]
    .split(" - ")[0]
    .replace(/официальный сайт/i, "")
    .trim()
    .slice(0, 90);
}

function findDeveloper(fullText) {
  const value = normalize(fullText);

  for (const developer of KNOWN_DEVELOPERS) {
    if (value.includes(normalize(developer))) return developer;
  }

  const match = fullText.match(/(?:застройщик|девелопер)[:\s]+([А-Яа-яA-Za-z0-9\s\-«»\"'.]{2,70})/i);
  return match ? cleanText(match[1]).replace(/[.,;:].*$/, "").slice(0, 70) : "";
}

function findCity(fullText, url) {
  const value = normalize(`${fullText} ${url}`);
  return value.includes("казань") || value.includes("казани") || value.includes("kazan") || value.includes("kzn") ? "Казань" : "";
}

function findDistrict(fullText) {
  const value = normalize(fullText);

  for (const district of KAZAN_DISTRICTS) {
    const key = normalize(district).replace(" район", "");
    if (value.includes(key)) return district;
  }

  return "";
}

function findAddress(nodes, fullText) {
  const jsonAddress = jsonLdValue(nodes, ["address", "streetAddress"]);
  if (jsonAddress && /ул|улица|проспект|шоссе|пер|бульвар|тракт/i.test(jsonAddress)) {
    return jsonAddress.slice(0, 120);
  }

  const patterns = [
    /(?:адрес|расположение)[:\s]+([^\n\r.]{8,130})/i,
    /((?:ул\.|улица)\s+[А-Яа-яA-Za-z0-9\s\-.,/]{3,100})/i,
    /((?:проспект|пр-т|пр\.)\s+[А-Яа-яA-Za-z0-9\s\-.,/]{3,100})/i,
    /((?:шоссе|тракт|бульвар|пер\.|переулок)\s+[А-Яа-яA-Za-z0-9\s\-.,/]{3,100})/i
  ];

  for (const pattern of patterns) {
    const match = fullText.match(pattern);
    if (match) return cleanText(match[1]).replace(/\s+(цены|квартиры|планировки).*$/i, "").slice(0, 120);
  }

  return "";
}

function findPrice(fullText) {
  const value = normalize(fullText);
  const patterns = [
    /от\s*([\d\s,.]+)\s*(млн|миллион)/i,
    /цена\s*от\s*([\d\s,.]+)\s*₽/i,
    /от\s*([\d\s,.]+)\s*₽/i,
    /([\d\s]{6,})\s*₽/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;

    let number = String(match[1] || "").replace(/\s/g, "").replace(",", ".");
    let parsed = Number(number);
    if (!Number.isFinite(parsed)) continue;

    if (match[2] && match[2].includes("млн")) parsed *= 1000000;

    if (parsed >= 1000000 && parsed <= 100000000) return Math.round(parsed);
  }

  return 0;
}

function findRooms(fullText) {
  const value = normalize(fullText);
  const rooms = [];

  if (value.includes("студ")) rooms.push("студия");
  if (/(1|одн)[-\s]?(комн|к)/i.test(value) || value.includes("1-комнат")) rooms.push("1");
  if (/(2|двух|двухкомн|евро2)[-\s]?(комн|к)?/i.test(value) || value.includes("2-комнат")) rooms.push("2");
  if (/(3|трех|трехкомн|трёхкомн|евро3)[-\s]?(комн|к)?/i.test(value) || value.includes("3-комнат")) rooms.push("3");
  if (/(4|четырех|четырёх|евро4)[-\s]?(комн|к)?/i.test(value) || value.includes("4-комнат")) rooms.push("4");

  return Array.from(new Set(rooms)).join(", ");
}

function findDeadline(fullText) {
  const value = normalize(fullText);
  const patterns = [
    /(?:срок сдачи|сдача|срок ввода|ввод|сдается|сдаётся)[^0-9]{0,50}(20\d{2})/i,
    /([1-4]|i|ii|iii|iv)\s*(?:квартал|кв\.?)\s*(20\d{2})/i,
    /(20\d{2})\s*(?:год|г\.|года)/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;

    const year = [match[1], match[2], match[3]].find((item) => /20\d{2}/.test(String(item || "")));
    if (year) return String(year);
  }

  return "";
}

function findPropertyClass(fullText) {
  const value = normalize(fullText);
  if (value.includes("бизнес")) return "бизнес";
  if (value.includes("комфорт")) return "комфорт";
  if (value.includes("эконом")) return "эконом";
  return "";
}

function findMetroMinutes(fullText) {
  const value = normalize(fullText);
  const patterns = [
    /(\d{1,2})\s*(?:мин|минут)[^а-яa-z0-9]{0,25}(?:до\s*)?(?:метро|останов)/i,
    /(?:метро|останов)[^0-9]{0,35}(\d{1,2})\s*(?:мин|минут)/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    const number = Number(match?.[1]);
    if (Number.isFinite(number) && number > 0 && number < 90) return number;
  }

  return 0;
}

function findBoolean(fullText, words) {
  const value = normalize(fullText);
  return words.some((word) => value.includes(normalize(word)));
}

function findImage($, nodes, baseUrl) {
  const jsonImage = jsonLdValue(nodes, ["image", "photo"]);
  const candidates = [
    getMeta($, "og:image"),
    getMeta($, "twitter:image"),
    jsonImage,
    ...$("img")
      .map((_, el) => $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src") || "")
      .get()
      .filter(Boolean)
  ];

  for (const candidate of candidates) {
    const image = absoluteUrl(candidate, baseUrl);
    if (image && !image.includes("logo") && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(image)) return image;
  }

  return candidates[0] ? absoluteUrl(candidates[0], baseUrl) : "";
}

function buildDescription($, nodes, fullText) {
  const jsonDescription = jsonLdValue(nodes, ["description"]);
  const metaDescription = getMeta($, "description") || getMeta($, "og:description");
  const selected = cleanText(jsonDescription || metaDescription);

  if (selected.length > 40) return selected.slice(0, 700);

  const paragraphs = $("p")
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((p) => p.length > 45)
    .slice(0, 4)
    .join(" ");

  return cleanText(paragraphs || fullText).slice(0, 700);
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
  const known = KNOWN_DEVELOPERS.some((item) => normalize(item) === normalize(developer));
  return known ? 85 : 70;
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
    scores.price_score * 0.2 +
    scores.developer_score * 0.2 +
    scores.deadline_score * 0.1
  );
}

function buildMatchText(data) {
  const parts = [];

  if (data.district) parts.push(`Расположен в районе: ${data.district}.`);
  if (data.developer) parts.push(`Застройщик: ${data.developer}.`);
  if (data.price_from) parts.push(`Цена начинается от ${data.price_from.toLocaleString("ru-RU")} ₽.`);
  if (data.metro_minutes) parts.push(`До метро или остановки примерно ${data.metro_minutes} минут.`);
  if (data.schools_nearby || data.kindergarten_nearby || data.shops_nearby) {
    parts.push("Рядом есть важная инфраструктура для повседневной жизни.");
  }

  return parts.join(" ") || "ЖК подходит для сравнения по цене, району, инфраструктуре и рейтингу.";
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

  $("script, style, noscript, svg").remove();

  const bodyText = cleanText($("body").text());
  const headText = cleanText($("head").text());
  const fullText = cleanText(`${headText} ${bodyText}`);

  const title = findTitle($, jsonLdNodes, fullText);
  const developer = findDeveloper(fullText);
  const city = findCity(fullText, url);
  const district = findDistrict(fullText);
  const address = findAddress(jsonLdNodes, fullText);
  const price_from = findPrice(fullText);
  const rooms = findRooms(fullText);
  const deadline = findDeadline(fullText);
  const property_class = findPropertyClass(fullText);
  const metro_minutes = findMetroMinutes(fullText);
  const image = findImage($, jsonLdNodes, url);
  const description = buildDescription($, jsonLdNodes, fullText);

  const parking = findBoolean(fullText, ["парковка", "паркинг", "машиномест", "двор без машин"]);
  const schools_nearby = findBoolean(fullText, ["школа", "школы", "образовательный центр"]);
  const kindergarten_nearby = findBoolean(fullText, ["детский сад", "детские сады", "садик", "дошколь"]);
  const shops_nearby = findBoolean(fullText, ["магазин", "супермаркет", "торговый центр", "тц", "пятерочка", "пятёрочка", "магнит"]);

  const scores = {
    transport_score: scoreTransport(metro_minutes),
    infrastructure_score: scoreInfrastructure({ parking, schools: schools_nearby, kindergarten: kindergarten_nearby, shops: shops_nearby }),
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
      parse: "POST /parse-newbuilding"
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
