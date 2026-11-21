// Dry-run fixture shapes (docs/adr-generation-run.md D11). Fictional brands on reserved `.example` hosts;
// pages are served by the fixture transport, so the real fetcher, allow-list, robots.txt, rate limit,
// text extraction and evidence rules all run. Only the network and the model are replaced.
import { LeverInputFormat, LeverType } from '@prisma/client'
import { ExtractedValue } from '../schemas'

export interface FixtureDefinition {
  name: string
  type: LeverType
  inputFormat: LeverInputFormat
  unit: 'lb' | 'in' | 'cu ft' | 'years' | 'count' | null
  explanation: string
  relatedNeeds: string[]
  allowedValues: string[]
  safetyFlag: boolean
}

export interface FixtureLever {
  key: string
  /** Label the fixture pages print before the value ("Carrier weight: 9.5 lb"). */
  label: string
  /** Reuse an existing shared definition with this normalized name, if there is one. */
  reuseNameKey?: string
  definition: FixtureDefinition
  note?: string
}

export interface FixtureBrand {
  brand: string
  host: string
  /** og:site_name and the schema.org Organization name on the home page. */
  siteName: string
  robots?: string
}

export interface FixtureProduct {
  brand: string
  model: string
  path: string
  /** Page title and h1; defaults to "<brand> <model>". */
  pageName?: string
  /** Value text on the product page, by lever key ("9.5 lb", "Yes", "Rigid LATCH"). */
  specs: Record<string, string>
  /** Items for compatibility-list levers, by lever key. */
  items?: Record<string, string[]>
  /** Value text in the linked manual (PDF), by lever key. */
  manual?: Record<string, string>
  /** Link a PDF with no text (a scanned manual). */
  scannedManual?: boolean
  /** HTTP status for the product page (default 200). */
  status?: number
  nodeFit?: { belongs: boolean; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; reason: string }
  /** Replace parts of the model's answer for a lever (deliberate faults the code must catch). */
  answers?: Record<string, Partial<ExtractedValue>>
}

export interface NodeFixture {
  slug: string
  /** Product type words for page titles ("Infant Car Seat"). */
  productType: string
  levers: FixtureLever[]
  brands: FixtureBrand[]
  products: FixtureProduct[]
  searchTerms: string[]
}
