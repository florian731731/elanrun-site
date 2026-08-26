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

function analyzeActivities(activities, age) {
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
  if (age) {
    const estimatedMax = Math.round(208 - 0.7 * age);
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
    weeklyData: weeklyData.slice(-8),
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
    if (!tokenData.access_token) {
      const secretInfo = env.STRAVA_CLIENT_SECRET ? ('longueur=' + env.STRAVA_CLIENT_SECRET.length) : 'ABSENT';
      return new Response('DEBUG Strava response: ' + JSON.stringify(tokenData) + ' | client_id=' + env.STRAVA_CLIENT_ID + ' | secret=' + secretInfo, { status: 200 });
    }

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

async function handleDashboard(request, env) {
  const sessionId = getCookie(request, 'elanrun_session');
  if (!sessionId) return jsonResponse({ connected: false }, 200);

  const tokenRow = await getValidAccessToken(sessionId, env);
  if (!tokenRow) return jsonResponse({ connected: false }, 200);

  const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=60', {
    headers: { Authorization: `Bearer ${tokenRow.access_token}` }
  });

  if (!actRes.ok) return jsonResponse({ connected: true, error: 'strava_api_error' }, 200);

  const activities = await actRes.json();
  const analysis = analyzeActivities(activities, tokenRow.age);

  return jsonResponse({ connected: true, age: tokenRow.age || null, ...analysis });
}

async function handleSetAge(request, env) {
  const sessionId = getCookie(request, 'elanrun_session');
  if (!sessionId) return jsonResponse({ ok: false }, 401);

  const body = await request.json();
  const age = parseInt(body.age, 10);
  if (!age || age < 10 || age > 100) return jsonResponse({ ok: false }, 400);

  await env.DB.prepare('UPDATE strava_users SET age = ? WHERE session_id = ?').bind(age, sessionId).run();
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

    return env.ASSETS.fetch(request);
  }
};
