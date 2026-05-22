import { createServer } from "node:http";
import http from "node:http";
import https from "node:https";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(globalThis.process?.env?.PORT || 3000);
const CACHE_MS = 10 * 60 * 1000;

const SOURCES = {
  gulfCurrent: "https://gulfnews.com/gold-forex",
  gulfHistory: "https://gulfnews.com/gold-forex/historical-gold-rates",
  upstoxBanswara: "https://upstox.com/gold-rates/gold-rates-in-banswara/"
};

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

let cachedRates = null;
let cacheExpiresAt = 0;

export async function buildRatesData(fetchImpl = fetch) {
  const [gulfCurrentHtml, gulfHistoryHtml, upstoxHtml] = await Promise.all([
    fetchText(SOURCES.gulfCurrent, fetchImpl),
    fetchText(SOURCES.gulfHistory, fetchImpl),
    fetchText(SOURCES.upstoxBanswara, fetchImpl)
  ]);

  const dubaiCurrent = parseDubaiCurrent(gulfCurrentHtml);
  const dubaiHistory = parseDubaiHistory(gulfHistoryHtml);
  const banswara = parseBanswara(upstoxHtml);

  if (!dubaiCurrent.rates.length && dubaiHistory.daily.length) {
    const latest = dubaiHistory.daily[0];
    dubaiCurrent.rates = [
      { purity: "24K", current: latest.rates["24K"] },
      { purity: "22K", current: latest.rates["22K"] },
      { purity: "21K", current: latest.rates["21K"] },
      { purity: "18K", current: latest.rates["18K"] }
    ].filter((rate) => Number.isFinite(rate.current));
    dubaiCurrent.dateLabel = latest.dateLabel;
  }

  return {
    generatedAt: new Date().toISOString(),
    snapshot: false,
    markets: [
      {
        id: "dubai",
        name: "Dubai",
        subtitle: "Gulf News, Dubai Gold and Jewellery Group",
        sourceName: "Gulf News",
        sourceUrl: SOURCES.gulfCurrent,
        historyUrl: SOURCES.gulfHistory,
        currency: "AED",
        locale: "en-AE",
        dailyUnit: "per gram",
        monthlyUnit: "AED/g",
        dateLabel: dubaiCurrent.dateLabel || dubaiHistory.dateLabel || "",
        updatedLabel: dubaiCurrent.updatedLabel || dubaiHistory.updatedLabel || "",
        rates: dubaiCurrent.rates,
        monthly: dubaiHistory.monthly,
        daily: dubaiHistory.daily.slice(0, 10)
      },
      banswara
    ]
  };
}

export function parseDubaiCurrent(html) {
  const block = between(html, 'id="gold-rate"', "Gold rates today by OGold") || html;
  const dateLabel = cleanText(matchFirst(block, /<div class="Xjj85"><span>([\s\S]*?)<\/span>/));
  const updatedLabel = cleanText(matchFirst(block, /<span class="vo-rt">([\s\S]*?)<\/span>/));
  const rowPattern = /<tr><td>(\d+)\s*Carat<\/td><td>(?:<span>)?([^<]+)(?:<\/span>)?<\/td><td>(?:<span>)?([^<]+)(?:<\/span>)?<\/td><td>(?:<span>)?([^<]+)(?:<\/span>)?<\/td><td>(?:<span>)?([^<]+)(?:<\/span>)?<\/td><\/tr>/g;
  const rates = [];

  for (const row of block.matchAll(rowPattern)) {
    const purity = `${row[1]}K`;
    const morning = parseNumber(row[2]);
    const afternoon = parseNumber(row[3]);
    const evening = parseNumber(row[4]);
    const yesterday = parseNumber(row[5]);
    const current = [morning, afternoon, evening].filter(Number.isFinite).at(-1);

    if (Number.isFinite(current)) {
      rates.push({
        purity,
        current,
        perTen: current * 10,
        yesterday: Number.isFinite(yesterday) ? yesterday : null
      });
    }
  }

  return { dateLabel, updatedLabel, rates };
}

export function parseDubaiHistory(html) {
  const block = between(html, 'id="historical-gold-rate-table"', "</tbody>") || html;
  const dateLabel = cleanText(matchFirst(html, /<h3>Historical Gold Rates<\/h3>[\s\S]*?<span>([\s\S]*?)<\/span>/));
  const updatedLabel = cleanText(matchFirst(html, /<h3>Historical Gold Rates<\/h3>[\s\S]*?<span class="vo-rt">([\s\S]*?)<\/span>/));
  const rowPattern = /<tr><td>([^<]+)<\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td><\/tr>/g;
  const daily = [];

  for (const row of block.matchAll(rowPattern)) {
    const parsedDate = parseGulfDate(row[1]);
    daily.push({
      dateLabel: cleanText(row[1]),
      timestamp: parsedDate ? parsedDate.toISOString() : null,
      rates: {
        "24K": parseNumber(row[2]),
        "22K": parseNumber(row[3]),
        "21K": parseNumber(row[4]),
        "18K": parseNumber(row[5])
      }
    });
  }

  return {
    dateLabel,
    updatedLabel,
    daily,
    monthly: summarizeDubaiMonths(daily)
  };
}

export function parseBanswara(html) {
  const updatedDate = cleanText(matchFirst(html, /Last updated on\s*([^<]+)/));
  const updatedLabel = updatedDate ? `Last updated on ${updatedDate}` : "";
  const daily24 = parseUpstoxDailyTable(html, "24K Gold Rate in Banswara", "22K Gold Rate in Banswara");
  const daily22 = parseUpstoxDailyTable(html, "22K Gold Rate in Banswara", "Gold Investment in Banswara");

  return {
    id: "banswara",
    name: "Banswara",
    subtitle: "Upstox gold rates, Rajasthan",
    sourceName: "Upstox",
    sourceUrl: SOURCES.upstoxBanswara,
    currency: "INR",
    locale: "en-IN",
    dailyUnit: "per gram",
    monthlyUnit: "INR/10g",
    dateLabel: updatedDate,
    updatedLabel,
    rates: [
      buildBanswaraRate("24K", daily24),
      buildBanswaraRate("22K", daily22)
    ].filter((rate) => Number.isFinite(rate.current)),
    monthly: parseUpstoxMonthly(html),
    daily: parseUpstoxRecentDays(html)
  };
}

function buildBanswaraRate(purity, rows) {
  const oneGram = rows.find((row) => row.grams === 1);
  const tenGram = rows.find((row) => row.grams === 10);
  return {
    purity,
    current: oneGram?.today,
    perTen: tenGram?.today || (oneGram?.today ? oneGram.today * 10 : null),
    yesterday: oneGram?.yesterday
  };
}

function parseUpstoxDailyTable(html, heading, nextHeading) {
  const block = sectionBetween(html, heading, nextHeading);
  const money = "\\u20B9[\\d,]+(?:\\.\\d+)?";
  const rowPattern = new RegExp(`<td[^>]*>(\\d+)\\s*Gram<\\/td><td[^>]*>(${money})[\\s\\S]*?<\\/td><td[^>]*>(${money})`, "g");
  const rows = [];

  for (const row of block.matchAll(rowPattern)) {
    rows.push({
      grams: Number(row[1]),
      today: parseMoney(row[2]),
      yesterday: parseMoney(row[3])
    });
  }

  return rows;
}

function parseUpstoxMonthly(html) {
  const block = sectionBetween(html, "Month Wise Gold Rate", "Gold Rates Over Last 10 Days");
  const tablePattern = /<h3>Gold Price in Banswara,\s*([^<]+)<\/h3>[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/g;
  const rowPattern = /<td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td>/g;
  const months = [];

  for (const table of block.matchAll(tablePattern)) {
    const entries = [];
    for (const row of table[2].matchAll(rowPattern)) {
      entries.push({ label: cleanText(row[1]), value: cleanText(row[2]) });
    }

    const priceEntries = entries.filter((entry) => /^([A-Za-z]{3})\s+\d+$/i.test(entry.label));
    const high = entries.find((entry) => /^Highest/i.test(entry.label));
    const low = entries.find((entry) => /^Lowest/i.test(entry.label));
    const performance = entries.find((entry) => /^Overall performance/i.test(entry.label));

    months.push({
      month: cleanText(table[1]),
      startLabel: priceEntries[0]?.label || "Start",
      start: parseMoney(priceEntries[0]?.value),
      endLabel: priceEntries[1]?.label || "Latest",
      end: parseMoney(priceEntries[1]?.value),
      high: parseMoney(high?.value),
      low: parseMoney(low?.value),
      performance: performance?.value || ""
    });
  }

  return months;
}

function parseUpstoxRecentDays(html) {
  const block = sectionBetween(html, "Gold Rates Over Last 10 Days", "Gold Rates in Major Cities");
  const money = "\\u20B9[\\d,]+(?:\\.\\d+)?";
  const rowPattern = new RegExp(`(\\d{1,2}\\s+[A-Za-z]{3}\\s+\\d{4})(${money})[\\s\\S]*?(${money})`, "g");
  const days = [];

  for (const row of block.matchAll(rowPattern)) {
    days.push({
      dateLabel: row[1],
      rates: {
        "24K": parseMoney(row[2]),
        "22K": parseMoney(row[3])
      }
    });
  }

  return days;
}

function summarizeDubaiMonths(daily) {
  const groups = new Map();

  for (const day of daily) {
    if (!day.timestamp || !Number.isFinite(day.rates["24K"])) continue;
    const date = new Date(day.timestamp);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...day, date });
  }

  return [...groups.values()].map((items) => {
    const ascending = [...items].sort((a, b) => a.date - b.date);
    const start = ascending[0];
    const end = ascending[ascending.length - 1];
    const values = ascending.map((item) => item.rates["24K"]).filter(Number.isFinite);
    const high = Math.max(...values);
    const low = Math.min(...values);

    return {
      month: formatMonth(start.date),
      startLabel: formatMonthDay(start.date),
      start: start.rates["24K"],
      endLabel: formatMonthDay(end.date),
      end: end.rates["24K"],
      high,
      low,
      performance: end.rates["24K"] >= start.rates["24K"] ? "Rising" : "Falling"
    };
  });
}

function parseGulfDate(value) {
  const match = cleanText(value).match(/^(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!Number.isInteger(month)) return null;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
}

function formatMonth(date) {
  return `${shortMonth(date)} ${date.getUTCFullYear()}`;
}

function formatMonthDay(date) {
  return `${shortMonth(date)} ${date.getUTCDate()}`;
}

function shortMonth(date) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()];
}

function sectionBetween(html, startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  if (start < 0) return "";
  const end = endNeedle ? html.indexOf(endNeedle, start + startNeedle.length) : -1;
  return html.slice(start, end > start ? end : undefined);
}

function between(html, startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  if (start < 0) return "";
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  return html.slice(start, end > start ? end : undefined);
}

function matchFirst(text, pattern) {
  return text.match(pattern)?.[1] || "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  const cleaned = String(value || "").replace(/,/g, "").trim();
  if (cleaned === "-" || cleaned === "") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function parseMoney(value) {
  const cleaned = String(value || "").replace(/[^0-9.-]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

async function fetchText(url, fetchImpl) {
  const headers = {
    "accept": "text/html,application/xhtml+xml",
    "accept-encoding": "identity",
    "user-agent": "Mozilla/5.0 gold-rate-dashboard/1.0"
  };

  try {
    const response = await fetchImpl(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    return response.text();
  } catch (error) {
    if (!String(error?.cause || error?.message || "").includes("certificate")) {
      throw error;
    }

    return requestText(url, headers);
  }
}

function requestText(url, headers, redirectsLeft = 4) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, {
      headers,
      rejectUnauthorized: false
    }, (response) => {
      const location = response.headers.location;

      if (response.statusCode >= 300 && response.statusCode < 400 && location && redirectsLeft > 0) {
        response.resume();
        resolvePromise(requestText(new URL(location, target).href, headers, redirectsLeft - 1));
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        rejectPromise(new Error(`Failed to fetch ${url}: ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    });

    request.setTimeout(30000, () => request.destroy(new Error(`Timed out fetching ${url}`)));
    request.on("error", rejectPromise);
    request.end();
  });
}

async function getRatesData() {
  if (cachedRates && Date.now() < cacheExpiresAt) {
    return cachedRates;
  }

  cachedRates = await buildRatesData();
  cacheExpiresAt = Date.now() + CACHE_MS;
  return cachedRates;
}

export function startServer(port = PORT) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (url.pathname === "/api/rates") {
        const data = await getRatesData();
        send(response, 200, JSON.stringify(data), "application/json; charset=utf-8", {
          "cache-control": "no-store"
        });
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      console.error(error);
      send(response, 500, JSON.stringify({ error: "Unable to load gold rates." }), "application/json; charset=utf-8");
    }
  });

  server.listen(port, () => {
    console.log(`Gold rates website running at http://localhost:${port}`);
  });

  return server;
}

async function serveStatic(pathname, response) {
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = resolve(ROOT_DIR, `.${requestedPath}`);

  if (!filePath.startsWith(ROOT_DIR)) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    send(response, 200, body, mimeFor(filePath));
  } catch (error) {
    const fallback = await readFile(join(ROOT_DIR, "index.html"));
    send(response, 200, fallback, "text/html; charset=utf-8");
  }
}

function send(response, statusCode, body, contentType, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    ...extraHeaders
  });
  response.end(body);
}

function mimeFor(filePath) {
  const extension = extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  }[extension] || "application/octet-stream";
}

if (globalThis.process?.argv?.[1] && resolve(globalThis.process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
