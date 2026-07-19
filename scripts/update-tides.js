process.env.TZ = "Europe/Paris";

const fs = require("fs");

const URL = "https://maree.info/161";
const OFFSET_MINUTES = 20;

const KEEP_HISTORY_HOURS = 72;
const KEEP_FUTURE_DAYS = 7;

const MONTHS = {
  janvier: 0,
  février: 1,
  fevrier: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  août: 7,
  aout: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  décembre: 11,
  decembre: 11
};

const DAY_PATTERN =
  /(Lun\.|Mar\.|Mer\.|Jeu\.|Ven\.|Sam\.|Dim\.)\s+(\d{1,2})\b/g;

/* =========================================================
   OUTILS
========================================================= */

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function normalizeText(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&minus;/gi, "-")
    .replace(/&deg;/gi, "°")
    .replace(/&amp;/gi, "&")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(html) {
  return normalizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(tr|td|th|div|p|li|h1|h2|h3)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function parseNumber(value) {
  if (typeof value !== "string") {
    return null;
  }

  const number = Number(
    value
      .replace(",", ".")
      .replace(/\s/g, "")
  );

  return Number.isFinite(number) ? number : null;
}

function validDate(date) {
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

function extractPageDate(text) {
  const match = text.match(
    /(?:Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche)\s+(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/i
  );

  if (!match) {
    throw new Error(
      "Impossible de déterminer le mois et l’année de la page maree.info"
    );
  }

  const monthName = match[2]
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const month = MONTHS[monthName];

  if (month === undefined) {
    throw new Error(
      `Mois maree.info inconnu : ${match[2]}`
    );
  }

  return {
    day: Number(match[1]),
    month,
    year: Number(match[3])
  };
}

/* =========================================================
   EXTRACTION DU TABLEAU PRINCIPAL
========================================================= */

function extractMainTableText(html) {
  const startMatch = html.match(
    /Tableau horaire[\s\S]*?marée basse/i
  );

  if (!startMatch || startMatch.index === undefined) {
    throw new Error(
      "Début du tableau des marées introuvable"
    );
  }

  const startIndex = startMatch.index;

  const remainingHtml = html.slice(startIndex);

  const endMatch = remainingHtml.match(
    /PM\s*:\s*Pleine Mer/i
  );

  if (!endMatch || endMatch.index === undefined) {
    throw new Error(
      "Fin du tableau des marées introuvable"
    );
  }

  const tableHtml = remainingHtml.slice(
    0,
    endMatch.index
  );

  return htmlToText(tableHtml);
}

/* =========================================================
   DÉCOUPAGE PAR JOUR
========================================================= */

function splitDayBlocks(tableText) {
  const markers = [];

  DAY_PATTERN.lastIndex = 0;

  let match;

  while ((match = DAY_PATTERN.exec(tableText)) !== null) {
    markers.push({
      weekday: match[1],
      day: Number(match[2]),
      start: match.index,
      contentStart: DAY_PATTERN.lastIndex
    });
  }

  if (!markers.length) {
    throw new Error(
      "Aucune journée trouvée dans le tableau"
    );
  }

  return markers.map((marker, index) => {
    const nextMarker = markers[index + 1];

    return {
      weekday: marker.weekday,
      day: marker.day,
      content: tableText
        .slice(
          marker.contentStart,
          nextMarker ? nextMarker.start : tableText.length
        )
        .trim()
    };
  });
}

/* =========================================================
   ANALYSE D’UNE JOURNÉE

   Le tableau peut contenir 3 ou 4 marées selon le jour.
   Les horaires et les hauteurs sont associés dans leur ordre.
========================================================= */

function parseDayBlock(block) {
  const timeMatches = [
    ...block.content.matchAll(
      /\b([01]?\d|2[0-3])h([0-5]\d)\b/g
    )
  ];

  const heightMatches = [
    ...block.content.matchAll(
      /(-?\d+(?:,\d+)?)\s*m\b/gi
    )
  ];

  if (!timeMatches.length || !heightMatches.length) {
    return null;
  }

  const eventCount = Math.min(
    timeMatches.length,
    heightMatches.length
  );

  /*
    On retire horaires et hauteurs pour ne conserver
    que les éventuels coefficients.
  */
  const remainingText = block.content
    .replace(
      /\b([01]?\d|2[0-3])h([0-5]\d)\b/g,
      " "
    )
    .replace(
      /-?\d+(?:,\d+)?\s*m\b/gi,
      " "
    );

  const coefficientMatches = [
    ...remainingText.matchAll(/\b(\d{2,3})\b/g)
  ];

  const coefficients = coefficientMatches
    .map(match => Number(match[1]))
    .filter(value =>
      Number.isFinite(value) &&
      value >= 20 &&
      value <= 120
    );

  const rawEvents = [];

  for (let index = 0; index < eventCount; index++) {
    const hour = Number(timeMatches[index][1]);
    const minute = Number(timeMatches[index][2]);
    const height = parseNumber(heightMatches[index][1]);

    if (
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      !Number.isFinite(height)
    ) {
      continue;
    }

    /*
      À Bordeaux, les PM sont nettement au-dessus
      des BM. Le seuil est volontairement placé à 2 m.
    */
    const type = height >= 2 ? "high" : "low";

    rawEvents.push({
      hour,
      minute,
      height,
      type,
      coeff: null
    });
  }

  /*
    Les coefficients sont associés uniquement
    aux pleines mers, dans leur ordre d’apparition.
  */
  let coefficientIndex = 0;

  for (const event of rawEvents) {
    if (
      event.type === "high" &&
      coefficientIndex < coefficients.length
    ) {
      event.coeff = coefficients[coefficientIndex];
      coefficientIndex++;
    }
  }

  return {
    ...block,
    events: rawEvents
  };
}

/* =========================================================
   CONSTRUCTION DES DATES

   Gestion automatique des passages :
   - fin de mois ;
   - fin d’année.
========================================================= */

function buildDatedEvents(parsedDays, pageDate) {
  const events = [];

  let currentMonth = pageDate.month;
  let currentYear = pageDate.year;
  let previousDay = null;

  for (const parsedDay of parsedDays) {
    if (!parsedDay || !parsedDay.events.length) {
      continue;
    }

    if (
      previousDay !== null &&
      parsedDay.day < previousDay
    ) {
      currentMonth++;

      if (currentMonth > 11) {
        currentMonth = 0;
        currentYear++;
      }
    }

    previousDay = parsedDay.day;

    for (const rawEvent of parsedDay.events) {
      const bordeauxDate = new Date(
        currentYear,
        currentMonth,
        parsedDay.day,
        rawEvent.hour,
        rawEvent.minute,
        0,
        0
      );

      if (!validDate(bordeauxDate)) {
        continue;
      }

      const localDate = addMinutes(
        bordeauxDate,
        OFFSET_MINUTES
      );

      events.push({
        type: rawEvent.type,
        timeBordeaux: bordeauxDate.toISOString(),
        timeLocal: localDate.toISOString(),
        height: rawEvent.height,
        coeff: rawEvent.coeff
      });
    }
  }

  return events;
}

/* =========================================================
   VALIDATION ET NETTOYAGE
========================================================= */

function sanitizeEvents(events) {
  const uniqueEvents = new Map();

  for (const event of events) {
    const localDate = new Date(event.timeLocal);
    const height = Number(event.height);
    const coefficient =
      event.coeff === null ||
      event.coeff === undefined ||
      event.coeff === ""
        ? null
        : Number(event.coeff);

    if (
      !validDate(localDate) ||
      !Number.isFinite(height) ||
      !["high", "low"].includes(event.type)
    ) {
      continue;
    }

    const cleanedEvent = {
      type: event.type,
      timeBordeaux: event.timeBordeaux,
      timeLocal: localDate.toISOString(),
      height,
      coeff: Number.isFinite(coefficient)
        ? coefficient
        : null
    };

    uniqueEvents.set(
      eventKey(cleanedEvent),
      cleanedEvent
    );
  }

  return [...uniqueEvents.values()].sort(
    (a, b) =>
      new Date(a.timeLocal) -
      new Date(b.timeLocal)
  );
}

/* =========================================================
   COEFFICIENTS

   Les PM gardent leur coefficient propre.
   Pour les BM, on reprend le coefficient le plus proche,
   uniquement pour rendre le JSON plus complet.
========================================================= */

function propagateCoefficients(events) {
  const coefficientEvents = events.filter(event =>
    Number.isFinite(Number(event.coeff))
  );

  if (!coefficientEvents.length) {
    return events;
  }

  return events.map(event => {
    if (Number.isFinite(Number(event.coeff))) {
      return event;
    }

    let nearest = null;
    let nearestDistance = Infinity;

    for (const coefficientEvent of coefficientEvents) {
      const distance = Math.abs(
        new Date(coefficientEvent.timeLocal) -
        new Date(event.timeLocal)
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = coefficientEvent;
      }
    }

    return {
      ...event,
      coeff: nearest
        ? Number(nearest.coeff)
        : null
    };
  });
}

/* =========================================================
   ANCIEN FICHIER

   On conserve seulement les événements antérieurs
   au premier événement fraîchement récupéré.

   Tous les événements récents et futurs viennent donc
   exclusivement du nouveau parsing, ce qui supprime
   les anciennes données incorrectes.
========================================================= */

function readExistingEvents() {
  try {
    const existing = JSON.parse(
      fs.readFileSync("data/tides.json", "utf8")
    );

    return Array.isArray(existing.events)
      ? existing.events
      : [];
  } catch (error) {
    return [];
  }
}

function mergeWithHistory(freshEvents, existingEvents) {
  if (!freshEvents.length) {
    return sanitizeEvents(existingEvents);
  }

  const firstFreshDate = new Date(
    freshEvents[0].timeLocal
  );

  const historicalEvents = existingEvents.filter(event => {
    const date = new Date(event.timeLocal);

    return (
      validDate(date) &&
      date < firstFreshDate
    );
  });

  return sanitizeEvents([
    ...historicalEvents,
    ...freshEvents
  ]);
}

/* =========================================================
   CONTRÔLES DE COHÉRENCE
========================================================= */

function validateSequence(events) {
  if (events.length < 4) {
    throw new Error(
      `Seulement ${events.length} événements valides trouvés`
    );
  }

  for (let index = 1; index < events.length; index++) {
    const previous = events[index - 1];
    const current = events[index];

    const previousDate = new Date(previous.timeLocal);
    const currentDate = new Date(current.timeLocal);

    if (currentDate <= previousDate) {
      throw new Error(
        "Les événements ne sont pas dans l’ordre chronologique"
      );
    }

    const differenceHours =
      (currentDate - previousDate) / 3600000;

    /*
      Une marée à Bordeaux se produit normalement
      plusieurs heures après la précédente.

      Ces limites servent seulement à détecter
      un parsing manifestement erroné.
    */
    if (
      differenceHours < 2 ||
      differenceHours > 10
    ) {
      console.warn(
        `Intervalle inhabituel de ${differenceHours.toFixed(1)} h`,
        previous.timeLocal,
        current.timeLocal
      );
    }

    if (previous.type === current.type) {
      console.warn(
        "Deux événements consécutifs du même type :",
        previous.type,
        previous.timeLocal,
        current.timeLocal
      );
    }
  }
}

/* =========================================================
   PROGRAMME PRINCIPAL
========================================================= */

async function main() {
  const response = await fetch(URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; TideDashboard/2.0)",
      "Accept-Language": "fr-FR,fr;q=0.9"
    }
  });

  if (!response.ok) {
    throw new Error(
      `maree.info répond avec le statut ${response.status}`
    );
  }

  const html = await response.text();
  const fullText = htmlToText(html);

  const pageDate = extractPageDate(fullText);
  const tableText = extractMainTableText(html);

  const dayBlocks = splitDayBlocks(tableText);

  const parsedDays = dayBlocks
    .map(parseDayBlock)
    .filter(Boolean);

  let freshEvents = buildDatedEvents(
    parsedDays,
    pageDate
  );

  freshEvents = sanitizeEvents(freshEvents);

  if (freshEvents.length < 4) {
    throw new Error(
      `Parsing incomplet : seulement ${freshEvents.length} marées récupérées`
    );
  }

  const existingEvents = readExistingEvents();

  let mergedEvents = mergeWithHistory(
    freshEvents,
    existingEvents
  );

  const now = new Date();

  const keepFrom = new Date(
    now.getTime() -
    KEEP_HISTORY_HOURS * 3600000
  );

  const keepUntil = new Date(
    now.getTime() +
    KEEP_FUTURE_DAYS * 24 * 3600000
  );

  mergedEvents = mergedEvents.filter(event => {
    const date = new Date(event.timeLocal);

    return (
      date >= keepFrom &&
      date <= keepUntil
    );
  });

  mergedEvents = propagateCoefficients(
    mergedEvents
  );

  validateSequence(mergedEvents);

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

  fs.mkdirSync("data", {
    recursive: true
  });

  fs.writeFileSync(
    "data/tides.json",
    JSON.stringify(data, null, 2)
  );

  const highCount = mergedEvents.filter(
    event => event.type === "high"
  ).length;

  const lowCount = mergedEvents.filter(
    event => event.type === "low"
  ).length;

  console.log(
    [
      "OK",
      `${freshEvents.length} événements récupérés`,
      `${mergedEvents.length} événements conservés`,
      `${highCount} PM`,
      `${lowCount} BM`
    ].join(" - ")
  );
}

main().catch(error => {
  console.error("ERREUR :", error);
  process.exit(1);
});
