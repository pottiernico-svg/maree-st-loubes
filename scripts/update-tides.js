process.env.TZ = "Europe/Paris";

const fs = require("fs");

const URL = "https://maree.info/161";
const OFFSET_MINUTES = 20;

const HISTORY_HOURS = 48;
const FUTURE_DAYS = 7;

/* =========================================================
   OUTILS
========================================================= */

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&minus;/gi, "-")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\u00a0/g, " ");
}

function cleanHtml(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(tr|td|th|div|p|li|h1|h2|h3)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseHeight(value) {
  const result = Number(
    String(value)
      .replace(",", ".")
      .replace(/\s/g, "")
  );

  return Number.isFinite(result) ? result : null;
}

function isValidDate(date) {
  return (
    date instanceof Date &&
    !Number.isNaN(date.getTime())
  );
}

function eventKey(event) {
  return `${event.timeLocal}|${event.type}`;
}

/* =========================================================
   DATE DE LA PAGE
========================================================= */

function getPageDate(text) {
  const match = text.match(
    /(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche)\s+(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/i
  );

  if (!match) {
    throw new Error(
      "Impossible de trouver la date de la page maree.info"
    );
  }

  const monthName = match[3]
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const months = {
    janvier: 0,
    fevrier: 1,
    mars: 2,
    avril: 3,
    mai: 4,
    juin: 5,
    juillet: 6,
    aout: 7,
    septembre: 8,
    octobre: 9,
    novembre: 10,
    decembre: 11
  };

  if (months[monthName] === undefined) {
    throw new Error(`Mois inconnu : ${match[3]}`);
  }

  return {
    day: Number(match[2]),
    month: months[monthName],
    year: Number(match[4])
  };
}

/* =========================================================
   EXTRACTION DU TABLEAU
========================================================= */

function getTideTable(text) {
  const startMarker =
    "Date Heure Hauteur Coeff.";

  const endMarker =
    "PM : Pleine Mer";

  const startIndex = text.indexOf(startMarker);
  const endIndex = text.indexOf(endMarker);

  if (
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex <= startIndex
  ) {
    throw new Error(
      "Tableau principal des marées introuvable"
    );
  }

  return text.slice(
    startIndex + startMarker.length,
    endIndex
  );
}

/* =========================================================
   DÉCOUPAGE EN JOURNÉES
========================================================= */

function splitIntoDays(tableText) {
  const dayRegex =
    /(Lun\.|Mar\.|Mer\.|Jeu\.|Ven\.|Sam\.|Dim\.)\s+(\d{1,2})\b/g;

  const markers = [];

  let match;

  while ((match = dayRegex.exec(tableText)) !== null) {
    markers.push({
      weekday: match[1],
      day: Number(match[2]),
      start: match.index,
      contentStart: dayRegex.lastIndex
    });
  }

  if (!markers.length) {
    throw new Error(
      "Aucune journée trouvée dans le tableau"
    );
  }

  return markers.map((marker, index) => {
    const next = markers[index + 1];

    return {
      weekday: marker.weekday,
      day: marker.day,
      content: tableText
        .slice(
          marker.contentStart,
          next ? next.start : tableText.length
        )
        .trim()
    };
  });
}

/* =========================================================
   ANALYSE D’UNE JOURNÉE

   Une journée peut contenir :
   - 3 marées ;
   - ou 4 marées.

   Maree.info place :
   1. les horaires ;
   2. les hauteurs ;
   3. les coefficients.
========================================================= */

function parseDay(dayBlock) {
  const timeRegex =
    /\b([01]?\d|2[0-3])h([0-5]\d)\b/g;

  const heightRegex =
    /(-?\d+(?:,\d+)?)\s*m\b/gi;

  const times = [
    ...dayBlock.content.matchAll(timeRegex)
  ].map(match => ({
    hour: Number(match[1]),
    minute: Number(match[2])
  }));

  const heights = [
    ...dayBlock.content.matchAll(heightRegex)
  ].map(match => parseHeight(match[1]));

  const count = Math.min(
    times.length,
    heights.length
  );

  if (count < 3) {
    console.warn(
      `Journée ignorée : ${dayBlock.weekday} ${dayBlock.day}`,
      dayBlock.content
    );

    return null;
  }

  /*
    On retire les horaires et les hauteurs.
    Les nombres restants compris entre 20 et 120
    correspondent aux coefficients.
  */
  const remainingText = dayBlock.content
    .replace(timeRegex, " ")
    .replace(heightRegex, " ");

  const coefficients = [
    ...remainingText.matchAll(/\b(\d{2,3})\b/g)
  ]
    .map(match => Number(match[1]))
    .filter(value =>
      Number.isFinite(value) &&
      value >= 20 &&
      value <= 120
    );

  const events = [];

  for (let index = 0; index < count; index++) {
    const height = heights[index];

    if (!Number.isFinite(height)) {
      continue;
    }

    events.push({
      hour: times[index].hour,
      minute: times[index].minute,
      height,

      /*
        À Bordeaux les BM sont proches de 0 m
        et les PM proches de 4 à 5 m.
      */
      type: height >= 2
        ? "high"
        : "low",

      coeff: null
    });
  }

  /*
    Les coefficients sont associés aux PM
    dans leur ordre d’apparition.
  */
  let coefficientIndex = 0;

  for (const event of events) {
    if (
      event.type === "high" &&
      coefficientIndex < coefficients.length
    ) {
      event.coeff =
        coefficients[coefficientIndex];

      coefficientIndex++;
    }
  }

  return {
    day: dayBlock.day,
    events
  };
}

/* =========================================================
   CONSTRUCTION DES DATES
========================================================= */

function buildEvents(parsedDays, pageDate) {
  const result = [];

  let year = pageDate.year;
  let month = pageDate.month;
  let previousDay = null;

  for (const parsedDay of parsedDays) {
    if (!parsedDay) {
      continue;
    }

    /*
      Passage à un nouveau mois :
      30 → 1
      31 → 1
      28 → 1
    */
    if (
      previousDay !== null &&
      parsedDay.day < previousDay
    ) {
      month++;

      if (month > 11) {
        month = 0;
        year++;
      }
    }

    previousDay = parsedDay.day;

    for (const event of parsedDay.events) {
      const bordeauxDate = new Date(
        year,
        month,
        parsedDay.day,
        event.hour,
        event.minute,
        0,
        0
      );

      if (!isValidDate(bordeauxDate)) {
        continue;
      }

      const localDate = addMinutes(
        bordeauxDate,
        OFFSET_MINUTES
      );

      result.push({
        type: event.type,
        timeBordeaux:
          bordeauxDate.toISOString(),
        timeLocal:
          localDate.toISOString(),
        height: event.height,
        coeff: event.coeff
      });
    }
  }

  return result;
}

/* =========================================================
   NETTOYAGE
========================================================= */

function cleanEvents(events) {
  const unique = new Map();

  for (const event of events) {
    const date = new Date(event.timeLocal);
    const height = Number(event.height);

    const coeff =
      event.coeff === null ||
      event.coeff === undefined ||
      event.coeff === ""
        ? null
        : Number(event.coeff);

    if (
      !isValidDate(date) ||
      !Number.isFinite(height) ||
      !["high", "low"].includes(event.type)
    ) {
      continue;
    }

    const cleaned = {
      type: event.type,
      timeBordeaux:
        new Date(event.timeBordeaux).toISOString(),
      timeLocal:
        date.toISOString(),
      height,
      coeff:
        Number.isFinite(coeff)
          ? coeff
          : null
    };

    unique.set(
      eventKey(cleaned),
      cleaned
    );
  }

  return [...unique.values()].sort(
    (a, b) =>
      new Date(a.timeLocal) -
      new Date(b.timeLocal)
  );
}

/* =========================================================
   HISTORIQUE

   On conserve uniquement les événements antérieurs
   au premier événement fraîchement téléchargé.

   Cela permet :
   - d’avoir la marée précédente tôt le matin ;
   - de supprimer les anciennes données incorrectes
     sur les jours fraîchement récupérés.
========================================================= */

function readExistingEvents() {
  try {
    const data = JSON.parse(
      fs.readFileSync(
        "data/tides.json",
        "utf8"
      )
    );

    return Array.isArray(data.events)
      ? data.events
      : [];

  } catch (error) {
    return [];
  }
}

function mergeHistory(
  freshEvents,
  existingEvents
) {
  if (!freshEvents.length) {
    return [];
  }

  const firstFreshDate = new Date(
    freshEvents[0].timeLocal
  );

  const oldHistory = existingEvents.filter(
    event => {
      const date = new Date(event.timeLocal);

      return (
        isValidDate(date) &&
        date < firstFreshDate
      );
    }
  );

  return cleanEvents([
    ...oldHistory,
    ...freshEvents
  ]);
}

/* =========================================================
   COEFFICIENTS

   Chaque BM reçoit le coefficient de la PM
   la plus proche. Les PM conservent leur
   coefficient réel.
========================================================= */

function completeCoefficients(events) {
  const highWithCoefficient =
    events.filter(event =>
      event.type === "high" &&
      Number.isFinite(Number(event.coeff))
    );

  return events.map(event => {
    if (Number.isFinite(Number(event.coeff))) {
      return event;
    }

    let nearestHigh = null;
    let nearestDistance = Infinity;

    for (const high of highWithCoefficient) {
      const distance = Math.abs(
        new Date(event.timeLocal) -
        new Date(high.timeLocal)
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestHigh = high;
      }
    }

    return {
      ...event,
      coeff: nearestHigh
        ? Number(nearestHigh.coeff)
        : null
    };
  });
}

/* =========================================================
   VALIDATION
========================================================= */

function validateEvents(events) {
  if (events.length < 6) {
    throw new Error(
      `Seulement ${events.length} événements valides`
    );
  }

  let alternationProblems = 0;

  for (
    let index = 1;
    index < events.length;
    index++
  ) {
    const previous = events[index - 1];
    const current = events[index];

    if (previous.type === current.type) {
      alternationProblems++;

      console.warn(
        "Deux événements consécutifs du même type :",
        previous.timeLocal,
        current.timeLocal,
        previous.type
      );
    }
  }

  if (alternationProblems > 2) {
    throw new Error(
      "La succession PM/BM récupérée paraît incorrecte"
    );
  }
}

/* =========================================================
   PROGRAMME PRINCIPAL
========================================================= */

async function main() {
  const response = await fetch(URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; TideDashboard/3.0)",
      "Accept-Language":
        "fr-FR,fr;q=0.9"
    }
  });

  if (!response.ok) {
    throw new Error(
      `maree.info : erreur HTTP ${response.status}`
    );
  }

  const html = await response.text();
  const text = cleanHtml(html);

  const pageDate = getPageDate(text);
  const tableText = getTideTable(text);
  const dayBlocks = splitIntoDays(tableText);

  const parsedDays = dayBlocks
    .map(parseDay)
    .filter(Boolean);

  let freshEvents = buildEvents(
    parsedDays,
    pageDate
  );

  freshEvents = cleanEvents(freshEvents);

  if (freshEvents.length < 6) {
    throw new Error(
      `Extraction incomplète : ${freshEvents.length} événements`
    );
  }

  const existingEvents =
    readExistingEvents();

  let events = mergeHistory(
    freshEvents,
    existingEvents
  );

  const now = new Date();

  const keepFrom = new Date(
    now.getTime() -
    HISTORY_HOURS * 3600000
  );

  const keepUntil = new Date(
    now.getTime() +
    FUTURE_DAYS * 24 * 3600000
  );

  events = events.filter(event => {
    const date = new Date(event.timeLocal);

    return (
      date >= keepFrom &&
      date <= keepUntil
    );
  });

  events = completeCoefficients(events);
  events = cleanEvents(events);

  validateEvents(events);

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

  fs.mkdirSync(
    "data",
    { recursive: true }
  );

  fs.writeFileSync(
    "data/tides.json",
    JSON.stringify(data, null, 2)
  );

  const highCount = events.filter(
    event => event.type === "high"
  ).length;

  const lowCount = events.filter(
    event => event.type === "low"
  ).length;

  console.log(
    `OK - ${events.length} événements - ${highCount} PM - ${lowCount} BM`
  );

  /*
    Affichage des premiers événements dans Actions
    pour pouvoir vérifier immédiatement le résultat.
  */
  console.log(
    events
      .slice(0, 10)
      .map(event => ({
        type: event.type,
        timeLocal: event.timeLocal,
        height: event.height,
        coeff: event.coeff
      }))
  );
}

main().catch(error => {
  console.error(
    "ERREUR UPDATE-TIDES :",
    error
  );

  process.exit(1);
});
