// Dry-run fixture for Infant car seats: the end-to-end example (docs/adr-generation-run.md D11). All
// brands, products and hosts are fictional. Some products are built to fail a rule on purpose:
//   Cozycline     robots.txt disallows its product pages            → fetch: ROBOTS_DISALLOWED
//   Harborline    the product page answers 403                      → fetch: BLOCKED (not retried)
//   Petalpod      lookalike domain (site name "Deal Depot")          → brand domain waits for an admin
//   TinyTrek      a convertible seat (node fit MEDIUM)               → needs attention
//   Maple & Moss  the page names a different model                  → needs attention
//   Nestwell Roam weight in kg                                      → converted to lb, confidence MEDIUM
//   Kinderwise    height in cm                                      → converted to in
//   LullaCarry Glide: height only in the PDF manual                 → value sourced from the PDF
//   RoamBaby Trip: manual is a scanned PDF                         → skipped as SCANNED_PDF
//   Brightway Halo: the model paraphrases the expiration quote      → unknown (quote_not_found)
//   Nestwell Snug: the model answers "no" for an unmentioned feature → unknown (no_not_explicit)
import { LeverInputFormat, LeverType } from '@prisma/client'
import { NodeFixture } from './types'

const M = LeverType.MEASUREMENT
const SINGLE = LeverInputFormat.SINGLE

export const INFANT_CAR_SEATS: NodeFixture = {
  slug: 'infant-car-seats',
  productType: 'Infant Car Seat',
  searchTerms: ['baby bucket seat', 'newborn car seat'],
  levers: [
    {
      key: 'weight', label: 'Carrier weight', reuseNameKey: 'weight',
      definition: { name: 'Carrier weight', type: M, inputFormat: SINGLE, unit: 'lb', explanation: 'How heavy the seat is to carry between car, stroller and home, without its base.', relatedNeeds: ['carrying', 'stairs'], allowedValues: [], safetyFlag: false },
      note: 'Reuses the shared Weight definition, so seats and strollers are weighed the same way.',
    },
    {
      key: 'maxWeight', label: 'Maximum child weight',
      definition: { name: 'Maximum child weight', type: M, inputFormat: SINGLE, unit: 'lb', explanation: 'Decides how long the seat lasts before a convertible seat is needed.', relatedNeeds: ['larger babies', 'value for money'], allowedValues: [], safetyFlag: true },
    },
    {
      key: 'maxHeight', label: 'Maximum child height',
      definition: { name: 'Maximum child height', type: M, inputFormat: SINGLE, unit: 'in', explanation: 'Babies often outgrow an infant seat by height before weight.', relatedNeeds: ['tall babies', 'value for money'], allowedValues: [], safetyFlag: true },
    },
    {
      key: 'loadLeg', label: 'Load leg',
      definition: { name: 'Load leg', type: LeverType.BOOLEAN, inputFormat: SINGLE, unit: null, explanation: 'A load leg on the base reduces rotation in a frontal crash.', relatedNeeds: ['crash protection'], allowedValues: [], safetyFlag: true },
    },
    {
      key: 'antiRebound', label: 'Anti-rebound bar',
      definition: { name: 'Anti-rebound bar', type: LeverType.BOOLEAN, inputFormat: SINGLE, unit: null, explanation: 'Limits the seat rebounding toward the back seat after a crash.', relatedNeeds: ['crash protection'], allowedValues: [], safetyFlag: true },
    },
    {
      key: 'strollers', label: 'Compatible strollers',
      definition: { name: 'Stroller compatibility', type: LeverType.COMPATIBILITY_LIST, inputFormat: SINGLE, unit: null, explanation: 'Which strollers the seat clicks into as a travel system.', relatedNeeds: ['travel system', 'city walking'], allowedValues: [], safetyFlag: false },
    },
    {
      key: 'latch', label: 'Base installation',
      definition: { name: 'Base installation', type: LeverType.CATEGORY, inputFormat: SINGLE, unit: null, explanation: 'How the base attaches to the car, which affects how easy a correct install is.', relatedNeeds: ['several cars', 'grandparents'], allowedValues: ['Rigid LATCH', 'LATCH connectors', 'Belt only'], safetyFlag: true },
    },
    {
      key: 'side', label: 'Side-impact protection',
      definition: { name: 'Side-impact protection', type: LeverType.CATEGORY, inputFormat: SINGLE, unit: null, explanation: 'Side-impact features beyond the standard shell.', relatedNeeds: ['crash protection'], allowedValues: ['Foam only', 'Foam and external pods'], safetyFlag: true },
    },
    {
      key: 'expiration', label: 'Expiration',
      definition: { name: 'Expiration', type: M, inputFormat: SINGLE, unit: 'years', explanation: 'Car seats expire; a longer life matters for a second child.', relatedNeeds: ['second child', 'value for money'], allowedValues: [], safetyFlag: true },
    },
    {
      key: 'faa', label: 'FAA approved for aircraft',
      definition: { name: 'FAA approved for aircraft', type: LeverType.BOOLEAN, inputFormat: SINGLE, unit: null, explanation: 'Lets the seat be used on a plane.', relatedNeeds: ['air travel'], allowedValues: [], safetyFlag: true },
    },
    {
      key: 'recline', label: 'Base recline positions',
      definition: { name: 'Base recline positions', type: M, inputFormat: SINGLE, unit: 'count', explanation: 'More positions make a correct recline easier in different cars.', relatedNeeds: ['several cars'], allowedValues: [], safetyFlag: false },
    },
  ],
  brands: [
    { brand: 'LullaCarry', host: 'www.lullacarry.example', siteName: 'LullaCarry' },
    { brand: 'Nestwell', host: 'nestwell.example', siteName: 'Nestwell Baby' },
    { brand: 'Kinderwise', host: 'kinderwise.example', siteName: 'Kinderwise' },
    { brand: 'RoamBaby', host: 'roambaby.example', siteName: 'RoamBaby' },
    { brand: 'Brightway', host: 'brightway-kids.example', siteName: 'Brightway Kids' },
    { brand: 'Cozycline', host: 'cozycline.example', siteName: 'Cozycline', robots: 'User-agent: *\nDisallow: /products/\n' },
    { brand: 'Harborline', host: 'harborline.example', siteName: 'Harborline' },
    { brand: 'Petalpod', host: 'petalpod-deals.example', siteName: 'Deal Depot' },
    { brand: 'TinyTrek', host: 'tinytrek.example', siteName: 'TinyTrek' },
    { brand: 'Maple & Moss', host: 'maplemoss.example', siteName: 'Maple & Moss' },
  ],
  products: [
    {
      brand: 'LullaCarry', model: 'Glide', path: '/products/glide-infant-car-seat',
      specs: { weight: '9.5 lb', maxWeight: '35 lb', loadLeg: 'Yes', antiRebound: 'Yes', strollers: 'Fits LullaCarry City Stroller and Nestwell Roam Stroller', latch: 'Rigid LATCH', side: 'Foam and external pods', expiration: '7 years', faa: 'Yes', recline: '4 positions' },
      items: { strollers: ['LullaCarry City Stroller', 'Nestwell Roam Stroller'] },
      manual: { maxHeight: '32 in' },
    },
    {
      brand: 'LullaCarry', model: 'City', path: '/products/city-infant-car-seat',
      specs: { weight: '8.9 lb', maxWeight: '32 lb', maxHeight: '30 in', loadLeg: 'Yes', antiRebound: 'No anti-rebound bar', latch: 'LATCH connectors', side: 'Foam only', expiration: '6 years', faa: 'Yes', recline: '3 positions' },
    },
    {
      brand: 'LullaCarry', model: 'Air', path: '/products/air-infant-car-seat',
      specs: { weight: '7.9 lb', maxWeight: '30 lb', maxHeight: '30 in', loadLeg: 'No load leg', latch: 'Belt only', side: 'Foam only', expiration: '6 years', faa: 'Yes', recline: '2 positions' },
    },
    {
      brand: 'Nestwell', model: 'Roam', path: '/car-seats/roam',
      specs: { weight: '4.3 kg', maxWeight: '35 lb', maxHeight: '32 in', loadLeg: 'Yes', antiRebound: 'Yes', latch: 'Rigid LATCH', side: 'Foam and external pods', expiration: '8 years', recline: '5 positions' },
    },
    {
      brand: 'Nestwell', model: 'Snug', path: '/car-seats/snug',
      specs: { weight: '10.2 lb', maxWeight: '35 lb', maxHeight: '32 in', loadLeg: 'Yes', latch: 'LATCH connectors', side: 'Foam only', expiration: '7 years', faa: 'Yes', recline: '4 positions' },
      // The page says nothing about an anti-rebound bar; the model answers "no" anyway.
      answers: { antiRebound: { found: true, bool: false, quote: 'Load leg: Yes', source: 'page', confidence: 'MEDIUM' } },
    },
    {
      brand: 'Nestwell', model: 'Cloud', path: '/car-seats/cloud',
      specs: { weight: '11 lb', maxWeight: '35 lb', maxHeight: '32 in', loadLeg: 'Yes', antiRebound: 'Yes', latch: 'Rigid LATCH', side: 'Foam and external pods', expiration: '10 years', faa: 'Yes', recline: '6 positions' },
    },
    {
      brand: 'Kinderwise', model: 'Guard', path: '/infant/guard',
      specs: { weight: '9.8 lb', maxWeight: '32 lb', maxHeight: '76 cm', loadLeg: 'No load leg', antiRebound: 'Yes', latch: 'LATCH connectors', side: 'Foam only', expiration: '7 years', faa: 'Yes', recline: '3 positions' },
    },
    {
      brand: 'Kinderwise', model: 'Guard Plus', path: '/infant/guard-plus',
      specs: { weight: '10.6 lb', maxWeight: '35 lb', maxHeight: '81 cm', loadLeg: 'Yes', antiRebound: 'Yes', latch: 'Rigid LATCH', side: 'Foam and external pods', expiration: '7 years', faa: 'Yes', recline: '4 positions' },
    },
    {
      brand: 'RoamBaby', model: 'Trip', path: '/seats/trip',
      specs: { weight: '8.4 lb', maxWeight: '30 lb', maxHeight: '29 in', loadLeg: 'No load leg', latch: 'Belt only', side: 'Foam only', expiration: '6 years', faa: 'Yes', recline: '2 positions' },
      scannedManual: true,
    },
    {
      brand: 'RoamBaby', model: 'Trip Lite', path: '/seats/trip-lite',
      specs: { weight: '7.2 lb', maxWeight: '30 lb', maxHeight: '29 in', loadLeg: 'No load leg', latch: 'Belt only', side: 'Foam only', expiration: '6 years', faa: 'Yes', recline: '2 positions' },
    },
    {
      brand: 'Brightway', model: 'Halo', path: '/products/halo',
      specs: { weight: '9.9 lb', maxWeight: '35 lb', maxHeight: '32 in', loadLeg: 'Yes', antiRebound: 'Yes', latch: 'Rigid LATCH', side: 'Foam and external pods', expiration: '7 years from date of manufacture', recline: '4 positions' },
      answers: { expiration: { quote: 'Expires seven years after manufacture', statedValue: '7', statedUnit: 'years' } },
    },
    {
      brand: 'Brightway', model: 'Halo Max', path: '/products/halo-max',
      specs: { weight: '10.8 lb', maxWeight: '35 lb', maxHeight: '32 in', loadLeg: 'Yes', antiRebound: 'Yes', latch: 'Rigid LATCH', side: 'Foam and external pods', expiration: '10 years', faa: 'Yes', recline: '5 positions' },
    },
    {
      brand: 'Cozycline', model: 'Nest', path: '/products/nest',
      specs: { weight: '9.1 lb', maxWeight: '32 lb', maxHeight: '30 in', loadLeg: 'Yes', latch: 'LATCH connectors', side: 'Foam only', expiration: '7 years' },
    },
    {
      brand: 'Harborline', model: 'Anchor', path: '/products/anchor', status: 403,
      specs: { weight: '9.4 lb', maxWeight: '35 lb' },
    },
    {
      brand: 'Petalpod', model: 'Bloom', path: '/shop/bloom',
      specs: { weight: '8.8 lb', maxWeight: '30 lb', maxHeight: '30 in', latch: 'Belt only', side: 'Foam only', expiration: '6 years' },
    },
    {
      brand: 'TinyTrek', model: 'Grow 3-in-1', path: '/car-seats/grow-3-in-1', pageName: 'TinyTrek Grow 3-in-1 Convertible Car Seat',
      specs: { weight: '19.5 lb', maxWeight: '65 lb', maxHeight: '49 in', loadLeg: 'No load leg', latch: 'LATCH connectors', side: 'Foam only', expiration: '10 years', faa: 'Yes' },
      nodeFit: { belongs: false, confidence: 'MEDIUM', reason: 'A rear- and forward-facing convertible seat, not an infant carrier.' },
    },
    {
      brand: 'Maple & Moss', model: 'Pebble Infant', path: '/products/pebble-infant', pageName: 'Maple & Moss Cobble Toddler Booster',
      specs: { weight: '8.6 lb', maxWeight: '30 lb', maxHeight: '30 in', latch: 'Belt only', side: 'Foam only', expiration: '6 years' },
    },
  ],
}
