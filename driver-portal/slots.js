// Créneaux d'entretien. La Tunisie est en UTC+1 toute l'année (pas d'heure d'été depuis 2009).
const TUNIS_OFFSET_MIN = 60;

const cfg = () => ({
  days: Number(process.env.SLOT_DAYS || 7),
  startHour: Number(process.env.SLOT_START_HOUR || 9),
  endHour: Number(process.env.SLOT_END_HOUR || 17),
  stepMin: Number(process.env.SLOT_MINUTES || 30),
  noticeMin: Number(process.env.SLOT_NOTICE_MINUTES || 120),
});

const pad = (n) => String(n).padStart(2, "0");

/** Liste les créneaux libres des prochains jours (dimanche fermé). `taken` = Set d'ISO déjà réservés. */
export function listSlots(taken = new Set(), now = new Date()) {
  const { days, startHour, endHour, stepMin, noticeMin } = cfg();
  const tunisNow = new Date(now.getTime() + TUNIS_OFFSET_MIN * 60000);
  const earliest = now.getTime() + noticeMin * 60000;
  const out = [];
  for (let d = 0; d <= days; d++) {
    const day = new Date(Date.UTC(tunisNow.getUTCFullYear(), tunisNow.getUTCMonth(), tunisNow.getUTCDate() + d));
    if (day.getUTCDay() === 0) continue;
    const dateStr = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    for (let m = startHour * 60; m + stepMin <= endHour * 60; m += stepMin) {
      const iso = `${dateStr}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00+01:00`;
      if (new Date(iso).getTime() < earliest || taken.has(iso)) continue;
      out.push(iso);
    }
  }
  return out;
}
