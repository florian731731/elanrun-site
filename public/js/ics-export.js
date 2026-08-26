/* ===========================================================
   Export du plan vers un fichier .ics (Google Calendar, Apple
   Calendar, Outlook...). Généré 100% côté client.
   =========================================================== */

function icsEscape(str){
  return String(str).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
}

function icsDate(dateStr){
  // "2026-09-01" -> "20260901"
  return dateStr.replace(/-/g, '');
}

function buildICS(plan){
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Elanrun//Plan entrainement//FR',
    'CALSCALE:GREGORIAN'
  ];

  const now = new Date().toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';

  plan.weeks.forEach(week => {
    week.sessions.forEach((s, idx) => {
      if (s.type === 'repos') return;
      const uid = `elanrun-${week.number}-${idx}-${s.date}@elanrun.com`;
      const summary = `${s.label} — ${s.duration} min${s.pace ? ' · ' + s.pace + '/km' : ''}`;
      const description = s.desc + (s.pace ? ` Allure cible : ${s.pace}/km.` : '');

      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${icsDate(s.date)}`,
        `SUMMARY:${icsEscape(summary)}`,
        `DESCRIPTION:${icsEscape(description)}`,
        'END:VEVENT'
      );
    });
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function downloadICS(plan){
  const content = buildICS(plan);
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mon-plan-elanrun.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
