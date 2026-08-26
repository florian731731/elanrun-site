/* ===========================================================
   Elanrun — Worker principal
   Sert le site statique (via ASSETS) et gère l'intégration Strava
   (connexion OAuth, rafraîchissement de token, analyse d'activités).
   =========================================================== */

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function exchangeCodeForToken(code, env) {
  const body = new URLSearchParams();
  body.set('client_id', env.STRAVA_CLIENT_ID);
  body.set('client_secret', env.STRAVA_CLIENT_SECRET);
  body.set('code', code);
  body.set('grant_type', 'authorization_code');

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  return res.json();
}

async function refreshToken(refresh_token, env) {
  const body = new URLSearchParams();
  body.set('client_id', env.STRAVA_CLIENT_ID);
  body.set('client_secret', env.STRAVA_CLIENT_SECRET);
  body.set('refresh_token', refresh_token);
  body.set('grant_type', 'refresh_token');

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  return res.json();
}

async function getValidAccessToken(sessionId, env) {
  const row = await env.DB.prepare(
    'SELECT * FROM strava_users WHERE session_id = ?'
  ).bind(sessionId).first();

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at > now + 60) {
    return row;
  }

  const refreshed = await refreshToken(row.refresh_token, env);
  if (!refreshed.access_token) return null;

  await env.DB.prepare(
    `UPDATE strava_users SET access_token = ?, refresh_token = ?, expires_at = ? WHERE session_id = ?`
  ).bind(refreshed.access_token, refreshed.refresh_token, refreshed.expires_at, sessionId).run();

  return { ...row, access_token: refreshed.access_token, expires_at: refreshed.expires_at };
}

function weekKey(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function analyzeActivities(activities, age, maxHr) {
  const runs = activities.filter(a => a.type === 'Run');

  const weeks = {};
  runs.forEach(r => {
    const wk = weekKey(r.start_date_local);
    if (!weeks[wk]) weeks[wk] = { distance: 0, count: 0, hrSum: 0, hrCount: 0 };
    weeks[wk].distance += r.distance / 1000;
    weeks[wk].count += 1;
    if (r.average_heartrate) {
      weeks[wk].hrSum += r.average_heartrate;
      weeks[wk].hrCount += 1;
    }
  });

  const sortedWeeks = Object.keys(weeks).sort();
  const weeklyData = sortedWeeks.map(wk => ({
    week: wk,
    distanceKm: Math.round(weeks[wk].distance * 10) / 10,
    runs: weeks[wk].count,
    avgHr: weeks[wk].hrCount ? Math.round(weeks[wk].hrSum / weeks[wk].hrCount) : null
  }));

  let volumeAlert = null;
  if (weeklyData.length >= 2) {
    const last = weeklyData[weeklyData.length - 1];
    const prev = weeklyData[weeklyData.length - 2];
    if (prev.distanceKm > 0) {
      const change = ((last.distanceKm - prev.distanceKm) / prev.distanceKm) * 100;
      if (change > 15) {
        volumeAlert = `Ton volume a augmenté de ${Math.round(change)}% par rapport à la semaine précédente — au-delà de la règle des 10%. Attention au risque de blessure, pense à ralentir la progression.`;
      } else if (change < -40 && prev.distanceKm > 5) {
        volumeAlert = `Ton volume a fortement baissé cette semaine (${Math.round(change)}%). Si c'est une semaine de repos volontaire, tout va bien ; sinon, essaie de reprendre progressivement.`;
      }
    }
  }

  let zone2Insight = null;
  const estimatedMax = maxHr || (age ? Math.round(208 - 0.7 * age) : null);
  if (estimatedMax) {
    const z2Low = Math.round(0.6 * estimatedMax);
    const z2High = Math.round(0.7 * estimatedMax);
    const runsWithHr = runs.filter(r => r.average_heartrate);
    if (runsWithHr.length >= 3) {
      const tooFast = runsWithHr.filter(r => r.average_heartrate > z2High).length;
      const ratio = Math.round((tooFast / runsWithHr.length) * 100);
      if (ratio > 60) {
        zone2Insight = `Sur tes ${runsWithHr.length} dernières sorties avec cardio, ${ratio}% dépassent ta zone 2 estimée (${z2Low}-${z2High} bpm). Beaucoup de tes sorties "faciles" sont probablement trop rapides.`;
      } else {
        zone2Insight = `Sur tes ${runsWithHr.length} dernières sorties avec cardio, ${100 - ratio}% restent dans ou sous ta zone 2 estimée (${z2Low}-${z2High} bpm) — bonne répartition de l'effort.`;
      }
    }
  }

  return {
    totalRuns: runs.length,
    weeklyData: weeklyData.slice(-26),
    volumeAlert,
    zone2Insight
  };
}

async function handleConnect(env) {
  const redirectUri = env.STRAVA_REDIRECT_URI;
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${env.STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&approval_prompt=auto&scope=read,activity:read_all`;
  return Response.redirect(authUrl, 302);
}

async function handleCallback(url, env) {
  try {
    const code = url.searchParams.get('code');
    if (!code) return Response.redirect(url.origin + '/strava.html?error=1', 302);

    const tokenData = await exchangeCodeForToken(code, env);
    if (!tokenData.access_token) return Response.redirect(url.origin + '/strava.html?error=1', 302);

    const sessionId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO strava_users (session_id, athlete_id, access_token, refresh_token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      sessionId,
      tokenData.athlete?.id || 0,
      tokenData.access_token,
      tokenData.refresh_token,
      tokenData.expires_at,
      Math.floor(Date.now() / 1000)
    ).run();

    const headers = new Headers();
    headers.set('Location', url.origin + '/strava.html?connected=1');
    headers.append('Set-Cookie', `elanrun_session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7776000`);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    return new Response('Erreur callback Strava: ' + (err && err.message ? err.message : String(err)), { status: 500 });
  }
}

function comparePlanToActivities(plan, activities) {
  const runDates = new Set();
  activities
    .filter(a => a.type === 'Run')
    .forEach(a => runDates.add(String(a.start_date_local).slice(0, 10)));

  const today = new Date().toISOString().slice(0, 10);
  let doneCount = 0;
  let missedCount = 0;

  const weeks = (plan.weeks || []).map(week => {
    const sessions = (week.sessions || [])
      .filter(s => s.type !== 'repos')
      .map(s => {
        let status;
        if (s.date > today) {
          status = 'upcoming';
        } else if (runDates.has(s.date)) {
          status = 'done';
          doneCount++;
        } else {
          status = 'missed';
          missedCount++;
        }
        return { ...s, status };
      });
    return { number: week.number, sessions };
  });

  const totalPast = doneCount + missedCount;
  const adherenceRate = totalPast > 0 ? Math.round((doneCount / totalPast) * 100) : null;

  return { weeks, adherenceRate, doneCount, missedCount };
}

async function handlePlanSave(request, env) {
  const sessionId = getCookie(request, 'elanrun_session');
  if (!sessionId) return jsonResponse({ ok: false }, 200);

  const plan = await request.json();
  await env.DB.prepare(
    'INSERT INTO user_plans (session_id, plan_json, created_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET plan_json = excluded.plan_json, created_at = excluded.created_at'
  ).bind(sessionId, JSON.stringify(plan), Math.floor(Date.now() / 1000)).run();

  return jsonResponse({ ok: true });
}

async function fetchAllActivities(accessToken) {
  let all = [];
  const perPage = 100;
  for (let page = 1; page <= 6; page++) {
    const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}&page=${page}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) break;
    const batch = await res.json();
    all = all.concat(batch);
    if (batch.length < perPage) break;
  }
  return all;
}

function commentForActivity(a, estimatedMax, maxDistanceSoFar) {
  const parts = [];

  if (maxDistanceSoFar > 0 && a.distanceKm >= maxDistanceSoFar) {
    parts.push("Ta sortie la plus longue de la période ! 👏");
  }

  if (estimatedMax && a.avgHr) {
    const z2High = Math.round(0.7 * estimatedMax);
    const tempoHigh = Math.round(0.88 * estimatedMax);
    if (a.avgHr <= z2High) {
      parts.push("Séance bien maîtrisée en endurance fondamentale.");
    } else if (a.avgHr <= tempoHigh) {
      parts.push("Effort soutenu, plutôt de l'ordre du tempo.");
    } else {
      parts.push("Grosse intensité sur cette sortie, proche de tes limites.");
    }
  }

  if (a.elevationGain && a.distanceKm > 0) {
    const dPlusPerKm = a.elevationGain / a.distanceKm;
    if (dPlusPerKm > 15) parts.push("Un profil bien vallonné, du beau travail en côtes.");
  }

  if (a.movingMinutes && a.distanceKm > 0) {
    const paceMinPerKm = a.movingMinutes / a.distanceKm;
    const paceMin = Math.floor(paceMinPerKm);
    const paceSec = Math.round((paceMinPerKm - paceMin) * 60);
    parts.push(`Allure moyenne : ${paceMin}:${String(paceSec).padStart(2, '0')}/km.`);
  }

  return parts.join(' ');
}

async function handleDashboard(request, env) {
  const sessionId = getCookie(request, 'elanrun_session');
  if (!sessionId) return jsonResponse({ connected: false }, 200);

  const tokenRow = await getValidAccessToken(sessionId, env);
  if (!tokenRow) return jsonResponse({ connected: false }, 200);

  const activities = await fetchAllActivities(tokenRow.access_token);
  const analysis = analyzeActivities(activities, tokenRow.age, tokenRow.max_hr);

  const allRuns = activities.filter(a => a.type === 'Run');
  const maxDistanceSoFar = allRuns.length ? Math.max(...allRuns.map(a => a.distance / 1000)) : 0;
  const estimatedMax = tokenRow.max_hr || (tokenRow.age ? Math.round(208 - 0.7 * tokenRow.age) : null);

  const recentActivities = allRuns
    .slice(0, 10)
    .map(a => {
      const item = {
        id: a.id,
        name: a.name,
        date: String(a.start_date_local).slice(0, 10),
        distanceKm: Math.round((a.distance / 1000) * 10) / 10,
        movingMinutes: Math.round(a.moving_time / 60),
        elevationGain: Math.round(a.total_elevation_gain || 0),
        avgHr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
        polyline: a.map && a.map.summary_polyline ? a.map.summary_polyline : null
      };
      item.comment = commentForActivity(item, estimatedMax, maxDistanceSoFar);
      return item;
    });

  const planRow = await env.DB.prepare(
    'SELECT plan_json FROM user_plans WHERE session_id = ?'
  ).bind(sessionId).first();

  let planComparison = null;
  if (planRow) {
    const plan = JSON.parse(planRow.plan_json);
    planComparison = comparePlanToActivities(plan, activities);
  }

  return jsonResponse({ connected: true, age: tokenRow.age || null, maxHr: tokenRow.max_hr || null, planComparison, recentActivities, ...analysis });
}

async function geocodeAddress(address, orsKey) {
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${orsKey}&text=${encodeURIComponent(address)}&size=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const feat = data.features && data.features[0];
  if (!feat) return null;
  const [lng, lat] = feat.geometry.coordinates;
  return { lat, lng, label: feat.properties.label };
}

async function generateLoopRoute(lat, lng, distanceKm, orsKey) {
  const url = `https://api.openrouteservice.org/v2/directions/foot-walking/geojson`;
  const body = {
    coordinates: [[lng, lat]],
    options: {
      round_trip: {
        length: Math.round(distanceKm * 1000),
        points: 4,
        seed: Math.floor(Math.random() * 10000)
      }
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': orsKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) return null;
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature) return null;
  const coords = feature.geometry.coordinates.map(c => [c[1], c[0]]);
  const summary = feature.properties.summary;
  return {
    coords,
    distanceKm: Math.round((summary.distance / 1000) * 10) / 10,
    durationMin: Math.round(summary.duration / 60)
  };
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findFountainsNearRoute(coords) {
  if (!coords.length) return [];
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  coords.forEach(([lat, lng]) => {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  });
  const pad = 0.003;
  const bbox = `${minLat - pad},${minLng - pad},${maxLat + pad},${maxLng + pad}`;
  const query = `[out:json][timeout:15];node["amenity"="drinking_water"](${bbox});out body;`;

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const elements = data.elements || [];
    const sampled = coords.filter((_, i) => i % 5 === 0);
    return elements
      .filter(el => sampled.some(([lat, lng]) => haversine(lat, lng, el.lat, el.lon) < 150))
      .map(el => ({ lat: el.lat, lng: el.lon, name: (el.tags && el.tags.name) || 'Fontaine à eau' }));
  } catch (e) {
    return [];
  }
}

async function handleRouteGenerate(request, env) {
  try {
    const body = await request.json();
    let lat = body.lat, lng = body.lng;

    if ((!lat || !lng) && body.address) {
      const geo = await geocodeAddress(body.address, env.ORS_API_KEY);
      if (!geo) return jsonResponse({ ok: false, error: 'Adresse introuvable.' }, 200);
      lat = geo.lat; lng = geo.lng;
    }

    if (!lat || !lng) return jsonResponse({ ok: false, error: 'Aucun point de départ fourni.' }, 200);

    const distanceKm = Math.min(Math.max(parseFloat(body.distanceKm) || 10, 2), 30);

    const route = await generateLoopRoute(lat, lng, distanceKm, env.ORS_API_KEY);
    if (!route) return jsonResponse({ ok: false, error: "Impossible de générer un parcours à cet endroit. Essaie une distance différente ou un autre point de départ." }, 200);

    const fountains = await findFountainsNearRoute(route.coords);

    return jsonResponse({ ok: true, ...route, fountains, start: { lat, lng } });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Erreur serveur: ' + (err && err.message ? err.message : String(err)) }, 200);
  }
}

async function handleSetAge(request, env) {
  const sessionId = getCookie(request, 'elanrun_session');
  if (!sessionId) return jsonResponse({ ok: false }, 401);

  const body = await request.json();
  const age = parseInt(body.age, 10);
  const maxHr = body.maxHr ? parseInt(body.maxHr, 10) : null;
  if (!age || age < 10 || age > 100) return jsonResponse({ ok: false }, 400);

  await env.DB.prepare('UPDATE strava_users SET age = ?, max_hr = ? WHERE session_id = ?').bind(age, maxHr, sessionId).run();
  return jsonResponse({ ok: true });
}

async function handleDisconnect(request, env) {
  const sessionId = getCookie(request, 'elanrun_session');
  if (sessionId) {
    await env.DB.prepare('DELETE FROM strava_users WHERE session_id = ?').bind(sessionId).run();
  }
  const headers = new Headers();
  headers.set('Location', '/strava.html');
  headers.append('Set-Cookie', 'elanrun_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  return new Response(null, { status: 302, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/auth/strava/connect') return handleConnect(env);
    if (url.pathname === '/auth/strava/callback') return handleCallback(url, env);
    if (url.pathname === '/auth/strava/disconnect') return handleDisconnect(request, env);
    if (url.pathname === '/api/strava/dashboard') return handleDashboard(request, env);
    if (url.pathname === '/api/strava/set-age' && request.method === 'POST') return handleSetAge(request, env);
    if (url.pathname === '/api/plan/save' && request.method === 'POST') return handlePlanSave(request, env);
    if (url.pathname === '/api/route/generate' && request.method === 'POST') return handleRouteGenerate(request, env);

    return env.ASSETS.fetch(request);
  }
};
