// Dry-run output (LEVER_GEN_MODE=dry_run, the default): fixture candidates returned without calling the
// API. They go through the same validation and storage path as live output.
type FixtureCandidate = {
  name: string
  type: 'MEASUREMENT' | 'CATEGORY' | 'COMPATIBILITY_LIST' | 'BOOLEAN'
  unit: string | null
  explanation: string
  relatedNeeds: string[]
}

const STROLLERS: FixtureCandidate[] = [
  { name: 'Fold size', type: 'MEASUREMENT', unit: 'cu ft', explanation: 'Decides whether it fits your trunk, closet or an overhead bin.', relatedNeeds: ['air travel', 'small car', 'storage'] },
  { name: 'Weight', type: 'MEASUREMENT', unit: 'lb', explanation: 'You lift it into the car and up stairs many times a day.', relatedNeeds: ['stairs', 'public transport', 'air travel'] },
  { name: 'Car seat compatibility', type: 'COMPATIBILITY_LIST', unit: null, explanation: 'Lets a sleeping baby move from car to stroller without waking.', relatedNeeds: ['newborn', 'car travel'] },
  { name: 'Wheel material', type: 'CATEGORY', unit: null, explanation: 'Rubber and foam wheels handle rough paths; plastic is lighter but harsher.', relatedNeeds: ['rough terrain', 'city sidewalks'] },
  { name: 'Seat weight limit', type: 'MEASUREMENT', unit: 'lb', explanation: 'Sets how long the stroller lasts as your child grows.', relatedNeeds: ['long-term use', 'second child'] },
  { name: 'One-hand fold', type: 'BOOLEAN', unit: null, explanation: 'Folding while holding a baby is a daily reality.', relatedNeeds: ['solo parent', 'car travel'] },
  { name: 'Basket capacity', type: 'MEASUREMENT', unit: 'lb', explanation: 'Errands and diaper bags need somewhere to go.', relatedNeeds: ['errands', 'city living'] },
  { name: 'Recline positions', type: 'MEASUREMENT', unit: 'positions', explanation: 'Naps on the go need a seat that lies close to flat.', relatedNeeds: ['newborn', 'naps out'] },
  { name: 'Suspension', type: 'CATEGORY', unit: null, explanation: 'Absorbs bumps on cobbles, curbs and trails.', relatedNeeds: ['rough terrain', 'jogging'] },
  { name: 'Canopy coverage', type: 'CATEGORY', unit: null, explanation: 'Shade and weather protection for longer walks.', relatedNeeds: ['hot climate', 'long walks'] },
]

function generic(categoryName: string): FixtureCandidate[] {
  const n = categoryName.trim() || 'product'
  return [
    { name: 'Weight', type: 'MEASUREMENT', unit: 'lb', explanation: `How heavy the ${n} is to carry and move.`, relatedNeeds: ['portability'] },
    { name: 'Size', type: 'MEASUREMENT', unit: 'in', explanation: `Whether the ${n} fits the space you have.`, relatedNeeds: ['small home', 'storage'] },
    { name: 'Price tier', type: 'CATEGORY', unit: null, explanation: 'Where it sits between budget and premium options.', relatedNeeds: ['budget'] },
    { name: 'Main material', type: 'CATEGORY', unit: null, explanation: 'Material drives durability, weight and cleaning.', relatedNeeds: ['durability'] },
    { name: 'Warranty length', type: 'MEASUREMENT', unit: 'years', explanation: 'A longer warranty signals the maker expects it to last.', relatedNeeds: ['long-term use'] },
    { name: 'Easy to clean', type: 'BOOLEAN', unit: null, explanation: 'Daily use means regular cleaning.', relatedNeeds: ['children', 'pets'] },
    { name: 'Compatible accessories', type: 'COMPATIBILITY_LIST', unit: null, explanation: 'Accessories you already own or plan to buy.', relatedNeeds: ['existing gear'] },
    { name: 'Assembly required', type: 'BOOLEAN', unit: null, explanation: 'Some buyers want it ready to use out of the box.', relatedNeeds: ['time-poor'] },
    { name: 'Noise level', type: 'MEASUREMENT', unit: 'dB', explanation: 'Matters in small homes and around sleeping children.', relatedNeeds: ['small home', 'children'] },
    { name: 'Power source', type: 'CATEGORY', unit: null, explanation: 'Battery, mains or manual changes where you can use it.', relatedNeeds: ['travel', 'outdoor use'] },
  ]
}

export function dryRunCandidates(slug: string, categoryName: string): { candidates: FixtureCandidate[] } {
  return { candidates: slug === 'strollers' ? STROLLERS : generic(categoryName) }
}
