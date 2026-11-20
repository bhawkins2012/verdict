// Generic dry-run fixture for any decision node other than Infant car seats: three fictional brands, twelve
// products and ten levers, built deterministically from the node's slug (so a restarted process serves the
// same pages). Good enough to exercise the pipeline and the review screen; the levers are not meant to fit.
import { LeverInputFormat, LeverType } from '@prisma/client'
import { FixtureLever, FixtureProduct, NodeFixture } from './types'

const SINGLE = LeverInputFormat.SINGLE

const LEVERS: FixtureLever[] = [
  { key: 'weight', label: 'Weight', reuseNameKey: 'weight', definition: { name: 'Weight', type: LeverType.MEASUREMENT, inputFormat: SINGLE, unit: 'lb', explanation: 'How heavy it is to lift, carry and store.', relatedNeeds: ['carrying', 'stairs'], allowedValues: [], safetyFlag: false } },
  { key: 'width', label: 'Width', definition: { name: 'Width', type: LeverType.MEASUREMENT, inputFormat: SINGLE, unit: 'in', explanation: 'Decides whether it fits through doors, aisles and car trunks.', relatedNeeds: ['small car', 'narrow doors'], allowedValues: [], safetyFlag: false } },
  { key: 'foldedHeight', label: 'Folded height', definition: { name: 'Folded height', type: LeverType.MEASUREMENT, inputFormat: SINGLE, unit: 'in', explanation: 'How much vertical space it needs when stored.', relatedNeeds: ['small apartment', 'small car'], allowedValues: [], safetyFlag: false } },
  { key: 'warranty', label: 'Warranty', definition: { name: 'Warranty', type: LeverType.MEASUREMENT, inputFormat: SINGLE, unit: 'years', explanation: 'How long the maker stands behind the frame and parts.', relatedNeeds: ['value for money', 'second child'], allowedValues: [], safetyFlag: false } },
  { key: 'maxLoad', label: 'Maximum load', definition: { name: 'Maximum load', type: LeverType.MEASUREMENT, inputFormat: SINGLE, unit: 'lb', explanation: 'The most weight it is rated to carry.', relatedNeeds: ['larger children', 'shopping'], allowedValues: [], safetyFlag: false } },
  { key: 'positions', label: 'Adjustable positions', definition: { name: 'Adjustable positions', type: LeverType.MEASUREMENT, inputFormat: SINGLE, unit: 'count', explanation: 'More positions fit more ages and naps.', relatedNeeds: ['naps', 'growing child'], allowedValues: [], safetyFlag: false } },
  { key: 'washable', label: 'Machine-washable fabric', definition: { name: 'Machine-washable fabric', type: LeverType.BOOLEAN, inputFormat: SINGLE, unit: null, explanation: 'Fabric that goes in the washing machine is easier to keep clean.', relatedNeeds: ['messy eaters'], allowedValues: [], safetyFlag: false } },
  { key: 'frame', label: 'Frame material', definition: { name: 'Frame material', type: LeverType.CATEGORY, inputFormat: SINGLE, unit: null, explanation: 'Aluminium frames are lighter; steel frames are sturdier.', relatedNeeds: ['carrying', 'rough terrain'], allowedValues: ['Aluminum', 'Steel', 'Plastic'], safetyFlag: false } },
  { key: 'brake', label: 'Hand brake', definition: { name: 'Hand brake', type: LeverType.BOOLEAN, inputFormat: SINGLE, unit: null, explanation: 'A hand brake helps on hills and when running.', relatedNeeds: ['hills', 'jogging'], allowedValues: [], safetyFlag: false } },
  { key: 'accessories', label: 'Compatible accessories', definition: { name: 'Compatible accessories', type: LeverType.COMPATIBILITY_LIST, inputFormat: SINGLE, unit: null, explanation: 'Add-ons that fit without adapters.', relatedNeeds: ['weather', 'travel'], allowedValues: [], safetyFlag: false } },
]

const BRANDS = [
  { brand: 'Acme Gear', host: 'acmegear.example', siteName: 'Acme Gear' },
  { brand: 'Northwind', host: 'northwind-baby.example', siteName: 'Northwind Baby' },
  { brand: 'Fabrikam', host: 'fabrikam.example', siteName: 'Fabrikam' },
]
const MODELS = ['Cruiser', 'Breeze', 'Summit', 'Harbor']

export function titleFromSlug(slug: string): string {
  const words = slug.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function genericFixture(slug: string): NodeFixture {
  const products: FixtureProduct[] = []
  BRANDS.forEach((b, bi) => MODELS.forEach((m, mi) => {
    const i = bi * MODELS.length + mi
    const specs: Record<string, string> = {
      weight: `${(14 + i * 0.7).toFixed(1)} lb`,
      width: `${20 + (i % 5)} in`,
      foldedHeight: `${11 + (i % 4)} in`,
      warranty: `${1 + (i % 3)} years`,
      maxLoad: `${45 + (i % 4) * 5} lb`,
      positions: `${2 + (i % 4)} positions`,
      frame: ['Aluminum', 'Steel', 'Plastic'][i % 3],
      accessories: 'Works with the Rain Cover and the Cup Holder',
    }
    if (i % 4 !== 3) specs.washable = 'Yes'
    if (i % 3 === 0) specs.brake = 'Yes'
    products.push({
      brand: b.brand, model: `${m} ${bi + 1}`, path: `/${slug}/${m.toLowerCase()}-${bi + 1}`, specs,
      items: { accessories: ['Rain Cover', 'Cup Holder'] },
    })
  }))
  return { slug, productType: titleFromSlug(slug).replace(/s$/, ''), levers: LEVERS, brands: BRANDS, products, searchTerms: [] }
}
