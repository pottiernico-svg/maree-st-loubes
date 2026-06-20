process.env.TZ = "Europe/Paris";

const fs = require("fs");

const URL = "https://maree.info/161";
const OFFSET_MINUTES = 20;

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function clean(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const response = await fetch(URL, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const html = await response.text();
  const text = clean(html);

  const today = new Date();

  const section = text.match(
    /(Sam\.|Dim\.|Lun\.|Mar\.|Mer\.|Jeu\.|Ven\.)\s+13[\s\S]*?PM\s+:\s+Pleine Mer/
  );

  const events = [];

  const daysRegex =
    /(Sam\.|Dim\.|Lun\.|Mar\.|Mer\.|Jeu\.|Ven\.)\s+(\d{2})\s+(\d{2}h\d{2})\s+(\d{2}h\d{2})\s+(\d{2}h\d{2})\s+(\d{2}h\d{2})\s+(-?\d+,\d{2})m\s+(-?\d+,\d{2})m\s+(-?\d+,\d{2})m\s+(-?\d+,\d{2})m\s+(\d{2,3})?\s*(\d{2,3})?/g;

  let match;

  while ((match = daysRegex.exec(text)) !== null) {
    const day = Number(match[2]);
    const times = [match[3], match[4], match[5], match[6]];
    const heights = [match[7], match[8], match[9], match[10]];
    const coeffs = [match[11] || null, match[12] || null];

    times.forEach((time, index) => {
      const [hh, mm] = time.split("h").map(Number);

      const date = new Date();
      date.setFullYear(today.getFullYear());
      date.setMonth(today.getMonth());
      date.setDate(day);
      date.setHours(hh, mm, 0, 0);

      const height = Number(heights[index].replace(",", "."));

      events.push({
        type: height >= 2 ? "high" : "low",
        timeBordeaux: date.toISOString(),
        timeLocal: addMinutes(date, OFFSET_MINUTES).toISOString(),
        height,
        coeff: index === 1 ? Number(coeffs[0]) : index === 3 ? Number(coeffs[1]) : null
      });
    });
  }

events.sort((a, b) => new Date(a.timeLocal) - new Date(b.timeLocal));

let lastCoeff = null;

for(const event of events){
  if(event.coeff){
    lastCoeff = event.coeff;
  }else if(lastCoeff){
    event.coeff = lastCoeff;
  }
}
  
let nextCoeff = null;

for(let i = events.length - 1; i >= 0; i--){
  if(events[i].coeff){
    nextCoeff = events[i].coeff;
  }else if(nextCoeff){
    events[i].coeff = nextCoeff;
  }
}
  
const now = new Date();
const minDate = new Date(now.getTime() - 18 * 60 * 60 * 1000);
const maxDate = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

const filteredEvents = events.filter(e => {
  const d = new Date(e.timeLocal);
  return d >= minDate && d <= maxDate;
});  

let existingEvents = [];

try {
  const existing = JSON.parse(fs.readFileSync("data/tides.json", "utf8"));
  existingEvents = existing.events || [];
} catch (e) {
  existingEvents = [];
}

const allEventsMap = new Map();

[...existingEvents, ...filteredEvents].forEach(event => {
  allEventsMap.set(event.timeLocal, event);
});

const mergedEvents = [...allEventsMap.values()]
  .sort((a, b) => new Date(a.timeLocal) - new Date(b.timeLocal))
  .filter(e => {
    const d = new Date(e.timeLocal);
    const keepFrom = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const keepUntil = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
    return d >= keepFrom && d <= keepUntil;
  });
  
  const data = {
    updatedAt: new Date().toISOString(),
    source: "maree.info Bordeaux",
    offsetMinutes: OFFSET_MINUTES,
    spot: {
      name: "Ponton Saint-Loubès",
      lat: 44.934778,
      lon: -0.445861
    },
    events: mergedEvents
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/tides.json", JSON.stringify(data, null, 2));

  console.log(`OK - ${filteredEvents.length} nouveaux événements, ${mergedEvents.length} conservés`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
