import { PrismaClient, ReviewStage, ReviewSource, PriceTier, AgeRange, IncomeBracket, NudgeStatus } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { addWeeks, addMonths, subMonths, subWeeks } from 'date-fns'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // ── Users ──────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('password123', 10)

  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: {
      email: 'alice@example.com',
      username: 'alice_reviews',
      passwordHash,
      displayName: 'Alice Chen',
      emailVerified: true,
      demographics: {
        create: {
          ageRange: AgeRange.AGE_25_34,
          genderIdentity: 'woman',
          region: 'US-CA',
          incomeBracket: IncomeBracket.RANGE_75_100K,
          lifestyleTags: ['tech-early-adopter', 'home-cooking', 'fitness'],
          householdSize: 2,
          hasChildren: false,
        }
      }
    }
  })

  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: {
      email: 'bob@example.com',
      username: 'bob_tests_things',
      passwordHash,
      displayName: 'Bob Martinez',
      emailVerified: true,
      demographics: {
        create: {
          ageRange: AgeRange.AGE_35_44,
          genderIdentity: 'man',
          region: 'US-TX',
          incomeBracket: IncomeBracket.RANGE_100_150K,
          lifestyleTags: ['outdoor', 'family', 'budget-conscious'],
          householdSize: 4,
          hasChildren: true,
        }
      }
    }
  })

  const carol = await prisma.user.upsert({
    where: { email: 'carol@example.com' },
    update: {},
    create: {
      email: 'carol@example.com',
      username: 'carol_k',
      passwordHash,
      displayName: 'Carol Kim',
      emailVerified: true,
      demographics: {
        create: {
          ageRange: AgeRange.AGE_45_54,
          genderIdentity: 'woman',
          region: 'US-NY',
          incomeBracket: IncomeBracket.OVER_150K,
          lifestyleTags: ['luxury', 'travel', 'food-enthusiast'],
          householdSize: 1,
          hasChildren: false,
        }
      }
    }
  })

  // ── Products ──────────────────────────────────────────────
  const espressoMachine = await prisma.product.upsert({
    where: { amazonAsin: 'B08XYZ1234' },
    update: {},
    create: {
      name: 'Breville Barista Express',
      brand: 'Breville',
      category: 'kitchen',
      subcategory: 'espresso',
      description: 'Built-in grinder, precise temperature control, 15-bar pressure',
      priceTier: PriceTier.PREMIUM,
      amazonAsin: 'B08XYZ1234',
      attributes: { hasGrinder: true, barPressure: 15, hasSteamWand: true },
      avgRatingInitial: 8.6,
      avgRatingLongterm: 7.9,
      driftScoreAvg: -0.7,
      totalReviewCount: 3,
    }
  })

  const standingDesk = await prisma.product.upsert({
    where: { amazonAsin: 'B09ABC5678' },
    update: {},
    create: {
      name: 'FlexiSpot E7 Standing Desk',
      brand: 'FlexiSpot',
      category: 'furniture',
      subcategory: 'desks',
      description: 'Dual motor, 355lb capacity, anti-collision technology',
      priceTier: PriceTier.MID_RANGE,
      amazonAsin: 'B09ABC5678',
      attributes: { motorCount: 2, maxHeight: 48, minHeight: 22, weightCapacity: 355 },
      avgRatingInitial: 8.2,
      avgRatingLongterm: 8.8,
      driftScoreAvg: 0.6,
      totalReviewCount: 2,
    }
  })

  const airPurifier = await prisma.product.upsert({
    where: { amazonAsin: 'B07DEF9012' },
    update: {},
    create: {
      name: 'Dyson Purifier Cool TP07',
      brand: 'Dyson',
      category: 'home',
      subcategory: 'air-quality',
      description: 'HEPA H13 filter, 350° oscillation, real-time air quality reporting',
      priceTier: PriceTier.PREMIUM,
      amazonAsin: 'B07DEF9012',
      attributes: { filterType: 'HEPA H13', oscillation: 350, hasApp: true },
      avgRatingInitial: 9.1,
      avgRatingLongterm: 7.4,
      driftScoreAvg: -1.7,
      totalReviewCount: 2,
    }
  })

  const hikingBoots = await prisma.product.upsert({
    where: { amazonAsin: 'B06GHI3456' },
    update: {},
    create: {
      name: 'Salomon X Ultra 4 GTX',
      brand: 'Salomon',
      category: 'outdoor',
      subcategory: 'footwear',
      description: 'Gore-Tex waterproofing, Contagrip outsole, low-cut trail hiking',
      priceTier: PriceTier.MID_RANGE,
      amazonAsin: 'B06GHI3456',
      attributes: { waterproof: true, closure: 'lace', terrain: 'trail' },
      avgRatingInitial: 7.8,
      avgRatingLongterm: 9.2,
      driftScoreAvg: 1.4,
      totalReviewCount: 1,
    }
  })

  // ── Review Threads & Reviews ──────────────────────────────

  // Alice's espresso machine journey (bought 14 months ago)
  const aliceEspressoThread = await prisma.reviewThread.create({
    data: {
      userId: alice.id,
      productId: espressoMachine.id,
      stagesCompleted: [ReviewStage.INITIAL, ReviewStage.ONE_WEEK, ReviewStage.ONE_MONTH, ReviewStage.ONE_YEAR],
      driftScore: -1.5,
      reviews: {
        create: [
          {
            stage: ReviewStage.INITIAL,
            capturedAt: subMonths(new Date(), 14),
            scoreOverall: 9,
            scoreValue: 8,
            scoreQuality: 9,
            scoreExpectations: 9,
            bodyText: "Absolutely blown away. First shot pulled perfectly on day one. The integrated grinder is a game changer — no separate machine to clean. Steaming milk took a few tries but I'm getting there. This is worth every penny.",
            pros: ['Integrated grinder', 'Great crema', 'Easy to use'],
            cons: ['Learning curve for milk steaming', 'Loud grinder'],
            wouldStillBuy: true,
            wouldRecommend: true,
            sentimentScore: 0.87,
            keyTopics: ['grinder', 'espresso quality', 'value'],
          },
          {
            stage: ReviewStage.ONE_WEEK,
            capturedAt: subMonths(new Date(), 13).valueOf() > 0 ? subMonths(new Date(), 13) : new Date(),
            scoreOverall: 9,
            scoreQuality: 9,
            scoreLongevity: null,
            bodyText: "Still loving it. Dialed in my grind settings — getting very consistent shots now. Milk steaming is improving daily.",
            pros: ['Consistent results', 'Great build quality'],
            cons: ['Cleaning portafilter is tedious'],
            wouldStillBuy: true,
            sentimentScore: 0.82,
            keyTopics: ['consistency', 'grind settings', 'cleaning'],
          },
          {
            stage: ReviewStage.ONE_MONTH,
            capturedAt: subMonths(new Date(), 13),
            scoreOverall: 8,
            scoreValue: 7,
            scoreQuality: 8,
            scoreLongevity: 8,
            bodyText: "Still great, but the daily cleaning routine is more involved than I expected. The grinder occasionally clogs with oily beans. Still producing excellent espresso but the maintenance overhead is real.",
            pros: ['Coffee quality remains excellent', 'Durable feel'],
            cons: ['Cleaning is a daily chore', 'Grinder clogs with dark roast'],
            wouldStillBuy: true,
            wouldRecommend: true,
            sentimentScore: 0.61,
            keyTopics: ['maintenance', 'cleaning', 'grinder issues'],
          },
          {
            stage: ReviewStage.ONE_YEAR,
            capturedAt: subWeeks(new Date(), 2),
            scoreOverall: 7,
            scoreValue: 6,
            scoreQuality: 7,
            scoreLongevity: 6,
            scoreExpectations: 7,
            bodyText: "After a year: the grinder burrs have noticeably dulled, and I'm getting inconsistent shots now. Replacement burrs cost $80. The steam wand O-ring failed at month 10 — Breville support was helpful but the repair took 3 weeks. Coffee is still better than any coffee shop, but the long-term cost of ownership is higher than I budgeted for.",
            pros: ['Still makes great espresso when dialed', 'Good customer support'],
            cons: ['Burr degradation', 'High maintenance costs over time', 'Steam wand reliability'],
            wouldStillBuy: false,
            wouldRecommend: false,
            sentimentScore: 0.28,
            keyTopics: ['burr wear', 'maintenance costs', 'reliability'],
          },
        ]
      }
    }
  })

  // Bob's standing desk journey (bought 8 months ago)
  const bobDeskThread = await prisma.reviewThread.create({
    data: {
      userId: bob.id,
      productId: standingDesk.id,
      stagesCompleted: [ReviewStage.INITIAL, ReviewStage.ONE_MONTH, ReviewStage.SIX_MONTHS],
      driftScore: 1.5,
      reviews: {
        create: [
          {
            stage: ReviewStage.INITIAL,
            capturedAt: subMonths(new Date(), 8),
            scoreOverall: 8,
            scoreValue: 9,
            scoreQuality: 8,
            scoreExpectations: 8,
            bodyText: "Assembly took about 2 hours solo but the instructions are clear. Desk is solid — zero wobble at standing height which was my main concern. Motor is quieter than expected. Cable management is a bit of an afterthought.",
            pros: ['Solid build', 'Quiet motor', 'Good value'],
            cons: ['Cable management poor', 'Long assembly'],
            wouldStillBuy: true,
            sentimentScore: 0.72,
          },
          {
            stage: ReviewStage.ONE_MONTH,
            capturedAt: subMonths(new Date(), 7),
            scoreOverall: 8,
            scoreLongevity: 9,
            bodyText: "Using it daily and standing about 3 hours a day now. Back pain has noticeably reduced. The memory presets are great — I just hit button 2 and it goes to exactly my standing height.",
            pros: ['Memory presets', 'Back pain improvement', 'Reliable motors'],
            cons: ['Wish it had a wider surface'],
            wouldStillBuy: true,
            wouldRecommend: true,
            sentimentScore: 0.81,
          },
          {
            stage: ReviewStage.SIX_MONTHS,
            capturedAt: subMonths(new Date(), 2),
            scoreOverall: 9,
            scoreValue: 9,
            scoreQuality: 9,
            scoreLongevity: 9,
            bodyText: "6 months in and this desk has been flawless. No wobble, motors still smooth. I bought a second one for my home office. The anti-collision feature saved my monitor twice when my kid bumped into the desk while it was moving. Genuinely one of the best purchases I've made.",
            pros: ['Zero issues after 6 months', 'Anti-collision works', 'Great durability'],
            cons: ['None at this point'],
            wouldStillBuy: true,
            wouldRecommend: true,
            sentimentScore: 0.94,
          }
        ]
      }
    }
  })

  // Carol's air purifier (bought 15 months ago — big drift downward)
  const carolAirThread = await prisma.reviewThread.create({
    data: {
      userId: carol.id,
      productId: airPurifier.id,
      stagesCompleted: [ReviewStage.INITIAL, ReviewStage.ONE_MONTH, ReviewStage.ONE_YEAR],
      driftScore: -2.5,
      reviews: {
        create: [
          {
            stage: ReviewStage.INITIAL,
            capturedAt: subMonths(new Date(), 15),
            scoreOverall: 9,
            scoreValue: 8,
            scoreQuality: 10,
            scoreExpectations: 9,
            bodyText: "This is a beautiful machine. The app is excellent — real-time PM2.5 readings, automatic mode works perfectly. Allergy symptoms improved noticeably in the first week. The fan function is a bonus in summer.",
            pros: ['Excellent app', 'Measurable air quality improvement', 'Beautiful design'],
            cons: ['Very expensive', 'Replacement filters cost a lot'],
            wouldStillBuy: true,
            wouldRecommend: true,
            sentimentScore: 0.88,
          },
          {
            stage: ReviewStage.ONE_YEAR,
            capturedAt: subMonths(new Date(), 3),
            scoreOverall: 6,
            scoreValue: 4,
            scoreQuality: 7,
            scoreLongevity: 5,
            scoreExpectations: 5,
            bodyText: "The unit itself still works, but the filter replacement cost is astronomical — $90 every 6 months for a household with pets. The app has gotten worse with updates, and Dyson now pushes aggressive upsells. The motor has developed a slight rattle at medium speed. At $600 initial + $180/year in filters, this is NOT good value. I'll use it until it dies but won't replace it.",
            pros: ['Core filtration still works'],
            cons: ['Filter costs unsustainable', 'App degraded', 'Rattle at medium speed', 'Dyson support declined'],
            wouldStillBuy: false,
            wouldRecommend: false,
            sentimentScore: -0.31,
            keyTopics: ['filter costs', 'app quality', 'long-term value'],
          }
        ]
      }
    }
  })

  // Bob's hiking boots — only initial so far, nudge pending
  const bobBootsThread = await prisma.reviewThread.create({
    data: {
      userId: bob.id,
      productId: hikingBoots.id,
      stagesCompleted: [ReviewStage.INITIAL],
      driftScore: null,
      reviews: {
        create: [
          {
            stage: ReviewStage.INITIAL,
            capturedAt: subWeeks(new Date(), 3),
            scoreOverall: 8,
            scoreValue: 8,
            scoreQuality: 8,
            scoreExpectations: 7,
            bodyText: "Straight out of the box these feel solid. Took them on a 5 mile trail — great grip on wet rocks. A bit stiff and I got a small hot spot on my right heel but I expect that to break in.",
            pros: ['Excellent grip', 'True to size', 'Waterproofing works'],
            cons: ['Stiff initially', 'Break-in needed'],
            wouldStillBuy: true,
            sentimentScore: 0.65,
          }
        ]
      },
      nudges: {
        create: [
          {
            userId: bob.id,
            targetStage: ReviewStage.ONE_MONTH,
            scheduledFor: addWeeks(new Date(), 1),
            status: NudgeStatus.PENDING,
          }
        ]
      }
    }
  })

  console.log('✅ Seed complete!')
  console.log(`   Users: alice, bob, carol (password: password123)`)
  console.log(`   Products: ${espressoMachine.name}, ${standingDesk.name}, ${airPurifier.name}, ${hikingBoots.name}`)
  console.log(`   Review threads: ${aliceEspressoThread.id}, ${bobDeskThread.id}, ${carolAirThread.id}, ${bobBootsThread.id}`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
