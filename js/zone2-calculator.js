(function(){
  const form = document.getElementById('zone2Form');
  if (!form) return;

  form.addEventListener('submit', function(e){
    e.preventDefault();

    const age = parseInt(document.getElementById('z2age').value, 10);
    const restingHR = parseInt(document.getElementById('z2resting').value, 10) || null;
    const knownMax = parseInt(document.getElementById('z2max').value, 10) || null;

    if (!age || age < 10 || age > 100){
      alert("Indique un âge valide pour calculer ta zone 2.");
      return;
    }

    // Estimation de la FC max : Tanaka et al. (plus fiable que 220-âge), sauf si une FC max mesurée est fournie
    const estimatedMax = knownMax || Math.round(208 - 0.7 * age);

    // Méthode 1 : pourcentage direct de la FC max — la plus répandue (Garmin, Whoop, discours "zone 2" grand public)
    const simpleLow = Math.round(0.60 * estimatedMax);
    const simpleHigh = Math.round(0.70 * estimatedMax);

    document.getElementById('z2rangeValue').innerHTML = `${simpleLow}<span> – ${simpleHigh} bpm</span>`;

    let method = `Calculé à partir d'une FC max ${knownMax ? 'renseignée' : 'estimée (formule de Tanaka)'} de ${estimatedMax} bpm — méthode la plus courante (60-70% de la FC max).`;

    if (restingHR && restingHR > 30 && restingHR < 120){
      // Méthode 2 : Karvonen (réserve de fréquence cardiaque) — plus précise, mais donne des chiffres plus hauts si la FC repos est basse
      const reserve = estimatedMax - restingHR;
      const kLow = Math.round(restingHR + 0.60 * reserve);
      const kHigh = Math.round(restingHR + 0.70 * reserve);

      document.getElementById('z2altBlock').style.display = 'block';
      document.getElementById('z2altRange').textContent = `${kLow} – ${kHigh} bpm`;
      method += ` Avec ta FC de repos (${restingHR} bpm), la méthode de Karvonen — qui tient compte de ta marge cardiaque totale — donne une fourchette plus haute : ${kLow}-${kHigh} bpm. C'est normal, surtout si ta FC de repos est basse (signe d'un bon niveau d'entraînement) : les deux méthodes sont valables, mais la méthode simple ci-dessus reste la référence la plus utilisée pour la zone 2.`;
    } else {
      document.getElementById('z2altBlock').style.display = 'none';
    }

    document.getElementById('z2method').textContent = method;
    document.getElementById('z2result').classList.add('show');
  });
})();
