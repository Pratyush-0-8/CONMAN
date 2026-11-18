export interface PopulationBin { from: number; to: number; count: number }

export function strictlyBelowPercent(count: number, below: number | undefined) {
  if (count<2 || typeof below!=='number' || !Number.isInteger(below) || below<0 || below>count) return null
  return Math.round(100*below/count)
}

export const scorePosition = (score: number) => 38+Math.max(0,Math.min(250,score))/250*624

// Smooth the actual histogram weights with a one-bucket Gaussian kernel.
// Reflections at 0/250 correct edge clipping; no synthetic scores/counts are added.
export function populationCurve(bins: PopulationBin[], count: number) {
  if (count<2 || bins.reduce((sum,bin) => sum+bin.count,0)<2) return null
  const samples=Array.from({ length:101 },(_,i) => {
    const score=i*2.5
    const kernel=(distance: number) => Math.exp(-0.5*(distance/35)**2)
    const density=bins.reduce((sum,bin) => {
      const center=(bin.from+bin.to)/2
      return sum+bin.count*(kernel(score-center)+kernel(score+center)+kernel(score-(500-center)))
    },0)/count
    return { score,density }
  })
  const maximum=Math.max(...samples.map((sample) => sample.density))
  if (!(maximum>0)) return null
  const points=samples.map(({ score,density }) => ({ x:scorePosition(score),y:184-density/maximum*140 }))
  const point=(x: number,y: number) => `${x.toFixed(2)},${Math.min(184,Math.max(44,y)).toFixed(2)}`
  let line=`M${point(points[0].x,points[0].y)}`
  for (let i=0;i<points.length-1;i++) {
    const before=points[Math.max(0,i-1)],a=points[i],b=points[i+1],after=points[Math.min(points.length-1,i+2)]
    line+=` C${point(a.x+(b.x-before.x)/6,a.y+(b.y-before.y)/6)} ${point(b.x-(after.x-a.x)/6,b.y-(after.y-a.y)/6)} ${point(b.x,b.y)}`
  }
  return { line,area:`${line} L662,184 L38,184 Z`,samples }
}
