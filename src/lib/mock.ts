import { type MatchRecord, type Opponent, type Outcome, genScores } from './game'

export const QUESTIONS = [
  { q: 'Why might bringing shampoo to a job interview be a good idea?', mine: "It shows you plan for the unexpected. If it rains or I get nervous and sweat, I can freshen up before meeting anyone. It also becomes a conversation starter, and it signals that I take first impressions seriously.", theirs: "Because it demonstrates preparation. A candidate who anticipates a small problem like a messy morning is likely to anticipate bigger problems at work. It is also a memorable detail." },
  { q: 'You can only keep one season forever. Which one would help a city thrive most, and why?', mine: "Autumn. Temperatures are mild so people stay outside, farms keep producing a harvest, and there is enough cold to prevent pests. Cities spend less on heating and cooling, which frees money for other things.", theirs: "Spring, because growth is built into it. Everything renews, there is constant optimism, and the weather supports farming and travel without the extremes of summer or winter." },
  { q: 'A library decides to charge people for returning books early. What problem could that possibly solve?', mine: "Hoarded demand. If early returns cost money, people hold books and the shelf looks full. Wait, that is the opposite. More likely, it prevents returns piling up at the desk all at once and overwhelming staff.", theirs: "It could discourage rushed, unread returns, and reduce the staffing burden of constant processing. It also nudges people to actually finish what they borrow." },
  { q: 'Why would a restaurant intentionally remove all of its clocks?', mine: "To make guests feel unhurried so they order more courses and stay longer. Without clocks, there is no pressure to leave, and staff can also run the evening by feel rather than by deadlines.", theirs: "Time pressure spoils a meal. Removing clocks lets diners focus on conversation and food, which increases satisfaction and repeat visits, and probably average spend as well." },
  { q: 'What is the strongest argument for making every meeting standing-room only?', mine: "Discomfort creates focus. People get to the point faster, decisions happen sooner, and nobody drifts into a laptop. The meeting ends when the legs get tired, which is a natural, honest timer.", theirs: "Standing keeps energy high and meetings short. People are less likely to ramble, and a shorter meeting means more time to actually do the work that was discussed." },
  { q: 'If birds could send invoices, what would they bill humans for first?', mine: "Seed dispersal and pest control. Birds eat insects that damage crops and spread plants across landscapes. That is measurable value, so it would be a fair first line item before anything cosmetic like songs.", theirs: "Rent. Humans have taken their trees and ledges, so land use comes first. Then maybe a surcharge for window collisions, which is clearly a design flaw on our side." },
]

const NAMES = ['quietfalcon', 'MarginNote', 'ada_probst', 'null_pointer', 'sable.thinks', 'otterlogic', 'KiraVale', 'brisk_ember', 'lumen_17', 'north_axiom', 'tobiasm', 'paradoxpete', 'vesper.k', 'halfaglass']

export function makeOpponent(elo: number): Opponent {
  const name = NAMES[Math.floor(Math.random() * NAMES.length)]
  const e = Math.max(100, elo + Math.round((Math.random() - 0.5) * 120))
  const games = 8 + Math.floor(Math.random() * 40)
  const wins = Math.round(games * (0.4 + Math.random() * 0.25))
  return { name, elo: e, wins, losses: games - wins, simulated: true }
}

export const LEADERBOARD = [
  ['Aurelian', 1874, 212, 61], ['sophia.logic', 1791, 188, 70], ['Mx_Occam', 1742, 240, 102], ['kestrel_88', 1688, 154, 66],
  ['deductive_dani', 1630, 143, 71], ['PaulaPrism', 1577, 129, 64], ['wrenfield', 1521, 118, 66], ['epistemic', 1466, 133, 85],
  ['tangent_tom', 1402, 97, 61], ['lowkeylemma', 1355, 104, 72], ['bayesian_bee', 1310, 91, 68], ['Orla_N', 1268, 88, 70],
  ['ninefold', 1207, 76, 63], ['sorites', 1161, 82, 71], ['maple_syllogism', 1098, 69, 62], ['Quill', 1043, 64, 60],
  ['hexagonal', 987, 58, 57], ['rubberduck', 931, 51, 55], ['mellow_modus', 884, 47, 49], ['jun_k', 826, 41, 46],
  ['cloudcover', 771, 36, 43], ['firstprinciple', 705, 30, 41], ['tidepool', 648, 27, 40], ['zeno_runs', 596, 22, 35], ['barnaby', 541, 17, 31],
].map(([name, elo, wins, losses]) => ({ name: name as string, elo: elo as number, wins: wins as number, losses: losses as number }))

const seeds: { o: string; e: number; out: Outcome; d: number; q: number; ago: number }[] = [
  { o: 'otterlogic', e: 761, out: 'win', d: 18, q: 0, ago: 2 },
  { o: 'KiraVale', e: 802, out: 'loss', d: -14, q: 2, ago: 26 },
  { o: 'null_pointer', e: 689, out: 'win', d: 21, q: 1, ago: 52 },
  { o: 'brisk_ember', e: 664, out: 'win', d: 16, q: 3, ago: 78 },
  { o: 'ada_probst', e: 705, out: 'draw', d: 1, q: 4, ago: 120 },
  { o: 'lumen_17', e: 731, out: 'loss', d: -17, q: 5, ago: 168 },
  { o: 'sable.thinks', e: 640, out: 'win', d: 19, q: 2, ago: 220 },
  { o: 'vesper.k', e: 655, out: 'win', d: 15, q: 0, ago: 290 },
]

export function demoSeed() {
  const final = 742
  let elo = final - seeds.reduce((a, s) => a + s.d, 0)
  const asc = [...seeds].reverse().map((s) => {
    const g = genScores(s.out)
    const rec: MatchRecord = {
      id: `seed-${s.ago}`, opponent: s.o, opponentElo: s.e, outcome: s.out, delta: s.d,
      eloBefore: elo, eloAfter: elo + s.d, at: Date.now() - s.ago * 3600_000,
      question: QUESTIONS[s.q].q, myText: QUESTIONS[s.q].mine, oppText: QUESTIONS[s.q].theirs, ...g,
    }
    elo += s.d
    return rec
  })
  return { player: { name: '', elo: final, wins: 14, losses: 9, draws: 2 }, history: asc.reverse() }
}
