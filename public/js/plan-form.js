(function(){
  const form = document.getElementById('planForm');
  const steps = Array.from(document.querySelectorAll('.step'));
  const segs = Array.from(document.querySelectorAll('#progressRail .seg i'));
  const progressLabel = document.getElementById('progressLabel');
  const STEP_TITLES = ['Objectif','Niveau','Disponibilité','Contraintes'];

  const state = {
    distance: null,
    raceDate: '',
    level: null,
    recentPerfDist: '',
    recentPerfTime: '',
    sessionsPerWeek: null,
    sessionMinutes: '45',
    injuries: []
  };

  let current = 1;

  function updateProgress(){
    segs.forEach((s, i) => { s.style.width = (i < current) ? '100%' : '0%'; });
    progressLabel.textContent = `Étape ${current} / 4 — ${STEP_TITLES[current-1]}`;
  }

  function showStep(n){
    steps.forEach(s => s.classList.toggle('active', parseInt(s.dataset.step,10) === n));
    current = n;
    updateProgress();
    window.scrollTo({ top: form.offsetTop - 100, behavior: 'smooth' });
  }

  function validateStep(n){
    if (n === 1 && !state.distance){ alert('Choisis une distance pour continuer.'); return false; }
    if (n === 2 && !state.level){ alert('Choisis ton niveau pour continuer.'); return false; }
    if (n === 3 && !state.sessionsPerWeek){ alert('Choisis un nombre de séances par semaine.'); return false; }
    return true;
  }

  document.querySelectorAll('[data-next]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!validateStep(current)) return;
      if (current < 4) showStep(current + 1);
    });
  });
  document.querySelectorAll('[data-prev]').forEach(btn => {
    btn.addEventListener('click', () => { if (current > 1) showStep(current - 1); });
  });

  // Single-select option cards
  document.querySelectorAll('.option-grid[data-group]').forEach(group => {
    const key = group.dataset.group;
    group.querySelectorAll('.option-card').forEach(card => {
      card.addEventListener('click', () => {
        group.querySelectorAll('.option-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state[key] = card.dataset.value;
      });
    });
  });

  // Multi-select chips (injuries) with "aucune" exclusive
  const injuryGroup = document.querySelector('.chip-group[data-group="injuries"]');
  injuryGroup.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const val = chip.dataset.value;
      if (val === 'aucune'){
        injuryGroup.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        state.injuries = ['aucune'];
      } else {
        injuryGroup.querySelector('[data-value="aucune"]').classList.remove('selected');
        chip.classList.toggle('selected');
        state.injuries = Array.from(injuryGroup.querySelectorAll('.chip.selected')).map(c => c.dataset.value);
      }
    });
  });

  document.getElementById('raceDate').addEventListener('change', e => state.raceDate = e.target.value);
  document.getElementById('recentPerfDist').addEventListener('change', e => state.recentPerfDist = e.target.value);
  document.getElementById('recentPerfTime').addEventListener('input', e => state.recentPerfTime = e.target.value);
  document.getElementById('sessionMinutes').addEventListener('change', e => state.sessionMinutes = e.target.value);

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (!validateStep(4)) return;
    const plan = generatePlan(state);
    renderResults(plan);
    form.style.display = 'none';
    document.getElementById('results').classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.getElementById('restartBtn').addEventListener('click', () => {
    document.getElementById('results').classList.remove('active');
    form.style.display = 'block';
    showStep(1);
  });


  let currentPlan = null;
  document.getElementById('icsBtn').addEventListener('click', () => {
    if (!currentPlan) return;
    downloadICS(currentPlan);
    document.getElementById('icsToast').classList.add('show');
  });

  function fmtDate(d){
    return new Date(d).toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' });
  }

  function fmtShortDate(d){
    return new Date(d).toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' });
  }

  function renderResults(plan){
    currentPlan = plan;
    fetch("/api/plan/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan) }).catch(function(){});

    const subscribeBtn = document.getElementById('reminderSubscribeBtn');
    if (subscribeBtn && !subscribeBtn.dataset.bound){
      subscribeBtn.dataset.bound = '1';
      subscribeBtn.addEventListener('click', async function(){
        const emailInput = document.getElementById('reminderEmailInput');
        const errorEl = document.getElementById('reminderError');
        const toastEl = document.getElementById('reminderToast');
        errorEl.style.display = 'none';

        const email = emailInput.value.trim();
        if (!email){
          errorEl.textContent = 'Indique ton email.';
          errorEl.style.display = 'block';
          return;
        }

        subscribeBtn.disabled = true;
        try {
          const res = await fetch('/api/email/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, plan: currentPlan })
          });
          const data = await res.json();
          if (data.ok){
            toastEl.classList.add('show');
            emailInput.value = '';
          } else {
            errorEl.textContent = data.error || "Un souci est survenu, reessaie.";
            errorEl.style.display = 'block';
          }
        } catch (e){
          errorEl.textContent = "Erreur de connexion, reessaie.";
          errorEl.style.display = 'block';
        } finally {
          subscribeBtn.disabled = false;
        }
      });
    }

    const { meta } = plan;
    const introEl = document.getElementById('resultIntro');
    const subEl = document.getElementById('resultSub');

    if (meta.free){
      introEl.textContent = `Ton plan de progression ${meta.distance}`;
      subEl.textContent = `Aucune date de course renseignée — voici un plan de ${meta.weeks} semaines pour progresser à ton rythme, à partir du ${fmtDate(meta.planStart)}.`;
    } else {
      introEl.textContent = `Ton plan pour ton ${meta.distance} du ${fmtDate(meta.raceDate)}`;
      subEl.textContent = meta.tight
        ? `Le délai est court (moins de 4 semaines) : on privilégie le maintien de la forme plutôt que la progression rapide, pour arriver frais le jour J.`
        : `${meta.weeks} semaines pour bien te préparer, niveau ${meta.level.toLowerCase()}, à partir du ${fmtDate(meta.planStart)}.`;
    }

    const statsEl = document.getElementById('resultStats');
    statsEl.innerHTML = `
      <div><div class="n mono-stat">${meta.weeks}</div><div class="l">Semaines</div></div>
      <div><div class="n mono-stat">${meta.sessionsPerWeek}/sem</div><div class="l">Séances</div></div>
      <div><div class="n mono-stat">${meta.level}</div><div class="l">Niveau</div></div>
      <div><div class="n mono-stat">${meta.distance}</div><div class="l">Objectif</div></div>
    `;

    const container = document.getElementById('weeksContainer');
    container.innerHTML = '';
    plan.weeks.forEach(week => {
      const tag = week.isRaceWeek ? '<span class="phase-tag race">Semaine de course</span>'
                : week.isDeload ? '<span class="phase-tag deload">Semaine allégée</span>'
                : `<span class="phase-tag ${week.phase === 'taper' ? 'taper' : ''}">${PHASE_LABELS[week.phase]}</span>`;

      const sessionsHtml = week.sessions.map(s => `
        <div class="session-row">
          <div class="s-label">${s.label}<br><span style="font-family:var(--mono);font-size:0.75rem;color:var(--slate-light);font-weight:400;">${fmtShortDate(s.date)}</span></div>
          <div class="s-desc">${s.desc}</div>
          <div class="s-meta">${s.duration} min${s.pace ? ' · ' + s.pace + '/km' : ''}</div>
        </div>
      `).join('');

      const block = document.createElement('div');
      block.className = 'week-block';
      block.innerHTML = `
        <div class="week-head">
          <span class="wk">Semaine ${week.number}</span>
          ${tag}
        </div>
        <div class="week-sessions">${sessionsHtml}</div>
      `;
      container.appendChild(block);
    });
  }

  updateProgress();
})();
