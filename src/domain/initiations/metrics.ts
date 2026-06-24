// North-star metric lines (Phase 5.6; design §0.2) — pure formatter. The owner-facing dashboard is
// two numbers: bookings this week (the margin proxy — push up) and the number of times the PA had
// to pull the owner in this week (involuntary OAU — push toward zero). Never shows the term "OAU" to
// the owner; the zero case is celebrated (that's the goal). Returns ready-to-append briefing lines.

export function northStarLines(bookingsThisWeek: number, involuntaryOauThisWeek: number, lang: 'he' | 'en'): string {
  if (lang === 'he') {
    const bookingsLine = `📊 השבוע: *${bookingsThisWeek}* הזמנות חדשות.`
    const oauLine = involuntaryOauThisWeek === 0
      ? '🙌 לא נדרשת התערבות שלך — הכל טופל אוטומטית.'
      : `🙋 הייתי צריך אותך *${involuntaryOauThisWeek}* פעמים השבוע.`
    return `${bookingsLine}\n${oauLine}`
  }
  const bookingsLine = `📊 This week: *${bookingsThisWeek}* new booking(s).`
  const oauLine = involuntaryOauThisWeek === 0
    ? '🙌 Nothing needed your attention — all handled automatically.'
    : `🙋 I needed your input *${involuntaryOauThisWeek}* time(s) this week.`
  return `${bookingsLine}\n${oauLine}`
}

// Owner-only autonomous digest (Phase 6.4; design §8.3) — surfaced in the daily briefing, no
// approval needed (owner-only). Two cheap, actionable signals: tomorrow's load and how many
// customers have lapsed (the win-back loop's input). The churn line is omitted when zero so a
// healthy business isn't nagged. Pure formatter; the briefing computes the counts.
export function ownerDigestLines(bookingsTomorrow: number, likelyChurns: number, lang: 'he' | 'en'): string {
  if (lang === 'he') {
    const tomorrowLine = `🗓️ מחר: *${bookingsTomorrow}* תורים.`
    const churnLine = likelyChurns > 0
      ? `\n⚠️ *${likelyChurns}* לקוחות לא חזרו מזמן — אולי כדאי לפנות אליהם.`
      : ''
    return `${tomorrowLine}${churnLine}`
  }
  const tomorrowLine = `🗓️ Tomorrow: *${bookingsTomorrow}* booking(s).`
  const churnLine = likelyChurns > 0
    ? `\n⚠️ *${likelyChurns}* customer(s) haven't been back in a while — might be worth reaching out.`
    : ''
  return `${tomorrowLine}${churnLine}`
}
