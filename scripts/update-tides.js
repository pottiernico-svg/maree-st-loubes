const fs = require("fs");

const URL = "https://maree.info/161";
const OFFSET_MINUTES = 20;

const MONTHS = {
  "Jan": 0, "Fév": 1, "Fev": 1, "Mar": 2, "Avr": 3,
  "Mai": 4, "Juin": 5, "Juil": 6, "Aoû": 7, "Aou": 7,
  "Sep": 8, "Oct": 9, "Nov": 10, "Déc": 11, "Dec": 11
};

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function clean(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const response = await fetch(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const html = await response.text();
  const text = clean(html);

  const yearMatch = text.match(/(\d{4})UTC/);
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();

  const events = [];

  const regex = /(Lun|Mar|Mer|Jeu|Ven|Sam|Dim)\.(\d{2})\s+((?:\d{2}h\d{2}\s*){2,4})\s+((?:\d+,\d{2}m\s*){2,4})\s*((?:\d{2,3}\s*){0,4})/g;

  let match;

  while ((match = regex.exec(text)) !== null) {
    const day = Number(match[2]);
    const times = match[3].trim().split(/\s+/);
    const heights = match[4].trim().split(/\s+/);
    const coeffs = match[5].trim().split(/\s+/);

    for (let i = 0; i < times.length; i++) {
      const [hh, mm] = times[i].split("h").map(Number);

      const date = new Date();
      date.setFullYear(year);
      date.setMonth(new Date().getMonth());
      date.setDate(day);
      date.setHours(hh, mm, 0, 0);

      const height = Number(
        heights[i]?.replace("m", "").replace(",", ".")
      );

      const type = height >= 2 ? "high" : "low";

      events.push({
        type,
        timeBordeaux: date.toISOString(),
        timeLocal: addMinutes(date, OFFSET_MINUTES).toISOString(),
        height,
        coeff: coeffs[i] ? Number(coeffs[i]) : null
      });
    }
  }

  const data = {
    updatedAt: new Date().toISOString(),
    source: "maree.info Bordeaux",
    offsetMinutes: OFFSET_MINUTES,
    spot: {
      name: "Ponton Saint-Loubès",
      lat: 44.934778,
      lon: -0.445861
    },
    events
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/tides.json", JSON.stringify(data, null, 2));
}

main();
