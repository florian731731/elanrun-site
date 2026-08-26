/* ===========================================================
   ELANRUN — Générateur de plan d'entraînement
   100% côté client, aucune donnée envoyée à un serveur.
   =========================================================== */

const DISTANCE_LABELS = {
  '5k': '5 km',
  '10k': '10 km',
  'semi': 'Semi-marathon (21,1 km)',
  'marathon': 'Marathon (42,2 km)'
};

const DISTANCE_KM = { '5k': 5, '10k': 10, 'semi': 21.1, 'marathon': 42.2 };

const LEVEL_LABELS = {
  'debutant': 'Débutant total',
  'reprise': 'Reprise après pause',
  'regulier': 'Coureur régulier',
  'confirme': 'Confirmé'
};

// Allure de base par défaut (min/km) si aucune performance récente fournie
const DEFAULT_BASE_PACE = {
  'debutant': 7.5,
  'reprise': 7.0,
  'regulier': 6.0,
  'confirme': 5.15 // sera converti proprement
};

function paceToDecimal(str){
  // "7:30" -> 7.5
  if (typeof str !== 'string') return str;
  const [m, s] = str.split(':').map(Number);
  return m + (s || 0) / 60;
}

function decimalToPace(dec){
  const m = Math.floor(dec);
  const s = Math.round((dec - m) * 60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function estimateBasePace(data){
  if (data.recentPerfDist && data.recentPerfTime){
    const km = parseFloat(data.recentPerfDist);
    const totalMin = paceToDecimal(data.recentPerfTime);
    if (km > 0) return totalMin / km;
  }
  return DEFAULT_BASE_PACE[data.level] || 6.5;
}

function buildPaces(basePace){
  return {
    recuperation: basePace * 1.35,
    facile:       basePace * 1.20,
    sortieLongue: basePace * 1.15,
    tempo:        basePace * 1.05,
    fractionne:   basePace * 0.90
  };
}

function computeWeeks(raceDate){
  if (!raceDate) return { weeks: 8, tight: false, free: true };
  const today = new Date();
  today.setHours(0,0,0,0);
  const race = new Date(raceDate);
  const diffDays = Math.ceil((race - today) / (1000*60*60*24));
  let weeks = Math.floor(diffDays / 7);
  const tight = weeks < 4;
  weeks = Math.max(3, Math.min(weeks, 18));
  return { weeks, tight, free: false };
}

function sessionTemplate(count, debutantEarly){
  const templates = {
    2: ['facile','fractionne'],
    3: ['facile','fractionne','sortieLongue'],
    4: ['facile','fractionne','tempo','sortieLongue'],
    5: ['facile','fractionne','tempo','facile','sortieLongue'],
    6: ['facile','fractionne','tempo','facile','recuperation','sortieLongue']
  };
  let list = templates[count] || templates[3];
  if (debutantEarly){
    list = list.map(s => s === 'fractionne' ? 'marcheCourse' : s);
  }
  return list;
}

const SESSION_META = {
  facile:       { label: 'Sortie facile', desc: "Allure de conversation, tu dois pouvoir parler sans être essoufflé." },
  fractionne:   { label: 'Fractionné', desc: "Alternance d'efforts rapides et de récupération, pour améliorer ta vitesse." },
  tempo:        { label: 'Tempo', desc: "Allure soutenue mais tenable, juste sous ton seuil." },
  sortieLongue: { label: 'Sortie longue', desc: "La séance clé de la semaine : construit ton endurance de fond." },
  recuperation: { label: 'Récupération', desc: "Très facile, sert à évacuer la fatigue des séances précédentes." },
  marcheCourse: { label: 'Marche / Course', desc: "Alterne marche et course pour construire ta base en douceur, sans te blesser." },
  repos:        { label: 'Repos', desc: "Jour sans course. Aussi important que les séances elles-mêmes." }
};

function phasesFor(weeks){
  const taper = weeks >= 10 ? 2 : (weeks >= 6 ? 1 : 0);
  const remaining = weeks - taper;
  const base = Math.max(1, Math.round(remaining * 0.45));
  const build = Math.max(0, remaining - base);
  return { base, build, taper };
}

function phaseForWeek(weekIndex, phases){
  if (weekIndex <= phases.base) return 'base';
  if (weekIndex <= phases.base + phases.build) return 'build';
  return 'taper';
}

function durationForSession(type, phase, sessionMinutes, isDeload){
  let factor = 1;
  if (phase === 'base') factor = 0.75;
  if (phase === 'build') factor = 1.0;
  if (phase === 'taper') factor = 0.6;
  if (type === 'sortieLongue') factor *= 1.35;
  if (type === 'recuperation' || type === 'marcheCourse') factor *= 0.8;
  if (isDeload) factor *= 0.7;
  return Math.max(15, Math.round(sessionMinutes * factor / 5) * 5);
}

function nextMonday(){
  const d = new Date();
  d.setHours(0,0,0,0);
  const day = d.getDay(); // 0=dimanche, 1=lundi...
  const diff = (day === 1) ? 7 : ((8 - day) % 7 || 7);
  d.setDate(d.getDate() + diff);
  return d;
}

// Répartit les séances de la semaine sur des jours espacés (0=lundi ... 6=dimanche)
function dayOffsetsFor(n){
  const offsets = [];
  for (let i = 0; i < n; i++){
    offsets.push(Math.round(i * 7 / n));
  }
  return offsets;
}

function addDays(date, n){
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function generatePlan(data){
  const { weeks, tight, free } = computeWeeks(data.raceDate);
  const phases = phasesFor(weeks);
  const basePace = estimateBasePace(data);
  const paces = buildPaces(basePace);
  const sessionsPerWeek = parseInt(data.sessionsPerWeek, 10);
  const debutantTotal = data.level === 'debutant';
  const planStart = nextMonday();
  const offsets = dayOffsetsFor(sessionsPerWeek);

  const weeksOut = [];
  for (let w = 1; w <= weeks; w++){
    const phase = phaseForWeek(w, phases);
    const isDeload = (w % 4 === 0) && phase !== 'taper' && w !== weeks;
    const debutantEarly = debutantTotal && phase === 'base' && w <= Math.ceil(phases.base/2);
    const template = sessionTemplate(sessionsPerWeek, debutantEarly);

    const sessions = template.map((type, i) => {
      const date = addDays(planStart, (w - 1) * 7 + offsets[i]);
      return {
        type,
        label: SESSION_META[type].label,
        desc: SESSION_META[type].desc,
        duration: durationForSession(type, phase, parseInt(data.sessionMinutes,10), isDeload),
        pace: type === 'repos' ? null : decimalToPace(paces[type] ?? paces.facile),
        date: date.toISOString().slice(0,10)
      };
    });

    weeksOut.push({
      number: w,
      phase,
      isDeload,
      isRaceWeek: (!free && w === weeks),
      sessions
    });
  }

  return {
    meta: {
      distance: DISTANCE_LABELS[data.distance],
      level: LEVEL_LABELS[data.level],
      weeks, tight, free,
      sessionsPerWeek,
      raceDate: data.raceDate || null,
      planStart: planStart.toISOString().slice(0,10),
      injuries: data.injuries || []
    },
    weeks: weeksOut
  };
}

const PHASE_LABELS = {
  base: 'Bloc endurance',
  build: 'Bloc progression',
  taper: 'Affûtage'
};
