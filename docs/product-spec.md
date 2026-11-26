# Verdict Product Spec

Nov 26, 2026 · Brennan

## Vision and structure

Verdict helps people decide better. It has two halves that never share data or money: a reviews half that helps people choose, and an advertisements half that earns the revenue.

- **Reviews half:** product search, value levers, Best Fit ranking, guided purchase projects, and longitudinal reviews (2 weeks, 3 months, 1 year, 2 years).
- **Advertisements half:** a digital archive of historical ads and a place to engage directly with brands. It is the business model, and still a concept.

**The firewall (non-negotiable).** No brand payment, relationship or ad data can influence what the reviews half shows: rankings, value levers, review visibility or project guidance. The two halves use separate data stores, and no ad or brand entity is ever an input to ranking. Advertising never appears inside the reviews half.

**Principles**

1. Long-term evidence beats first impressions. Rankings weight later-stage reviews most heavily, and every product shows how opinion changed over time.
2. Needs first, products second. A user's stated needs drive what they see.
3. Explain every recommendation. Each ranked result says why it ranks where it does.
4. Build the framework once, write content per category. The seed categories are carry-on luggage, strollers and car seats.

## Users and core journey

The user is anyone facing a purchase decision. Launch content covers carry-on luggage first, then strollers and car seats, so early users will be frequent travelers and expecting and new parents.

One journey connects every feature. Each step produces the input the next one needs:

1. **Start a project** ("Buy a stroller"). The project asks about needs: travel, terrain, car, storage, budget.
2. **Work through the roadmap** over days or weeks. Each answer narrows the value levers that matter and filters the product list.
3. **Compare products** under Best Fit, ranked by people with similar needs and circumstances, with long-term scores shown.
4. **Record the purchase.** The project marks the product bought and sets the purchase date.
5. **First impression review**, prompted right after purchase, with the email check-in opt-in.
6. **Check-ins** at 2 weeks, 3 months, 1 year and 2 years feed the long-term scores that rank products for the next user.

The loop is the product: today's buyer becomes the evidence for the next buyer. A journey that ends at purchase, without the review cycle, misses the core asset.

## Product taxonomy

Products sit in a taxonomy so people move from a broad need to the exact type of product they are comparing. Levers, rankings and products live only at decision nodes. At launch, Baby and Kids holds two navigation nodes, Car seats and Strollers, with seven decision nodes beneath them, all generated through the full workflow. Convertible and all-in-one car seats share one node, and umbrella strollers are part of Travel strollers. Nodes are generated in order, starting with the travel-system pair (Infant car seats and Full-size strollers), so problems surface before all seven are reviewed.

```
Baby and Kids
├── Car seats                          (navigation node; also listed in Seats)
│   ├── Infant car seats               (decision node)
│   ├── Convertible and all-in-one car seats (decision node)
│   └── Booster seats                  (decision node)
└── Strollers                          (navigation node)
    ├── Full-size strollers            (decision node)
    ├── Travel strollers (incl. umbrella) (decision node)
    ├── Jogging strollers              (decision node)
    └── Double strollers               (decision node)
```

- **Navigation nodes** (for example Car seats) help people find the right type. Each has a short explainer of how its children differ, and no levers or ranking.
- **Decision nodes** (for example Infant car seats) are where products are compared directly. Each holds a ranked lever list, top five featured, and a product list.
- **One primary parent, optional secondary parents.** The primary path drives URLs and breadcrumbs; a secondary parent lists the node elsewhere (Car seats also appears under Seats).
- **Shared lever definitions.** A lever such as Seat weight (lb) is defined once and reused by sibling nodes, so the same attribute is measured the same way. Each decision node still chooses its own top five.
- **Product placement.** A product belongs to exactly one decision node, with optional "also listed in" for genuine overlaps. Bundles such as travel systems are deferred.
- **Generated, then approved.** Claude proposes the children of a node, each with a one-line rationale, and an admin approves. Demand-driven search terms map to existing nodes or propose new ones.

**Luggage goes first.** Travel holds a navigation node, Luggage, with three decision nodes: Carry-on, Checked and Personal item. Carry-on is generated before the baby nodes, using the product owner's own carry-on purchase as the real-world test. Hardside versus softside is a lever, not a node.

**Kids furniture (after launch).** Baby and Kids gains a Kids furniture navigation node with a Bunk beds decision node after the launch nodes, unless demand logging moves it up. Bunk bed safety levers are handled like car seat levers.

## Reviews half: search, value levers, product pages

Each decision node ranks its value levers and features the top five: the attributes that most decide whether a product is right for someone. Levers are generated by an automated pipeline and approved by a person before publishing (next section); Verdict's own reviews later test whether the chosen levers match what reviewers actually discuss.

**Levers come from owner evidence.** Owner reviews, on Verdict and elsewhere, decide which levers matter; manufacturer specs are a secondary source that fills in values.

- Levers are selected and ranked by how often and how strongly owners discuss them.
- Each decision node has one lever list. The top five appear in their own panel; opening the panel shows the full list.
- Levers are what they are; badges show what each one is relevant to, and a lever can carry several. Spec: it has a manufacturer value (weight, dimensions, warranty). Experience: owners rate it (wheel tracking, handle stability, wear at one year); experience evidence is the core of the product. Fit: it is checked against the buyer's project answers ("31 in of headroom in your room", "fits your airline's sizer"), shown only when the answer exists. Trade-off: it has no better value; the project asks the buyer's preference, and the card reads "Depends on you" and explains both sides.
- Expert-review evidence on a lever is labelled with its source, separately from owner ratings.
- A lever with the Experience badge and no ratings yet shows "No owner data yet".
- Every lever has an expandable plain-language explainer, for example what self-aligning spinner wheels are.

**Featured-five panel.** Each card shows a checkmark, a plain-language title, one or two sentences on why it matters, the owner score where there is one, and its badges. The panel links to the full lever list.

**Dependencies and How to shop.** Every decision node lists its dependencies: the things outside the product that decide which products can work. They vary by category, are proposed in the node's generation run and are approved by an admin.

- Situation dependencies come from the buyer: ceiling height and room layout for bunk beds, airline size limits for carry-ons, trunk space for strollers.
- Product dependencies come from related products: a bunk bed's maximum mattress height and weight limit constrain the mattress; an infant car seat constrains the stroller.
- Each dependency names the levers it constrains and the project question that captures it.
- The node's How to shop view is structured, not prose: the ranked levers with their badges, the dependencies and the safety section. Its questions become the node's project template.

**Safety.** Every decision node with safety rules shows a safety section on its category page, next to the levers. Each rule states the requirement, its source (for example CPSC: no children under 6 on a top bunk) and when it applies. Inside a project, a rule triggered by the buyer's answers shows a warning that cannot be dismissed silently. Safety-flagged levers keep their individual value review.

**Stroller value levers (reference set)**

| # | Lever | Type | Example values |
| --- | --- | --- | --- |
| 1 | Fold size | Measurement | Folded dimensions; one-hand fold yes/no |
| 2 | Weight | Measurement | lb |
| 3 | Car seat / travel system compatibility | Compatibility list | Compatible car seat models; adapter needed yes/no |
| 4 | Wheel material | Category | Rubber, foam-filled, plastic |
| 5 | Seat size and adjustability | Category + measurement | Recline positions, seat height, weight limit |

These five were chosen by hand before the taxonomy existed. Every launch decision node, Full-size strollers included, gets its levers from a generation run; this set is a reference input to the Full-size strollers run.

**Search**

- Search matches taxonomy nodes first ("stroller", "car seat"), then products by name and brand. A navigation node opens with a short explainer of how its children differ ("Which kind of car seat?").
- A category with no content yet says so and offers to notify the user, rather than showing an empty list.

**Category page**

- The featured five levers sit at the top as filters, each with a one-line explanation of why it matters.
- The product list defaults to Best Fit, with Top Rated as the alternative (ranking section below).
- If the user has an open project in this category, its answers pre-set the filters, and the page says so.

**Product page**

- Lever values for this product, side by side with the category typical value.
- The opinion-over-time curve: average score at first impression, 2 weeks, 3 months, 1 year, 2 years, with reviewer counts at each stage.
- Reviews grouped by stage, so a reader can see what changed after a year.
- A "would buy again" rate at each later stage.

**Price.** MSRP from the brand's site at launch. Later, a purchase interface shows the best price across retailers; how it fits the firewall is an open decision.

**Acceptance criteria**

- [ ] A decision node has one ranked lever list with a featured top five; each lever has a type, an explanation and source badges.
- [ ] Every product in the node has a value (or an explicit unknown) for every lever.
- [ ] Product pages show the stage curve once at least two stages have reviews.
- [ ] Filtering by a lever updates the list without a page reload.

## Lever generation and review synthesis

Levers, the products they describe and those products' values are Verdict's main value until its own reviews reach critical mass, so generating all three is automated end to end, with a person approving before anything is published. No step depends on scraping third-party review sites.

**Demand-driven categories**

User searches decide which category is built next.

- Every search that matches no published category is logged as an aggregate count per normalized term (lowercased, trimmed, singular). No user id or IP is stored with it.
- The admin screen shows a weekly ranked list of unmet search terms, with counts and trend, and lets the admin merge synonyms ("pram" into "stroller").
- One click on a term maps it to an existing taxonomy node, or creates an unpublished one, and starts a generation run (below). An admin can also set a threshold so a term with enough searches starts a run automatically, still requiring approval before anything is published.
- Users who searched can opt in to be notified when the category goes live, as the search section describes.

**One generation run per decision node**

Levers cannot be judged without data: a lever manufacturers rarely publish is weak however important it sounds. So one run produces the node's placement, candidate levers, candidate products and their values together, and one review publishes them together.

1. **Place the node.** Confirm its primary parent and any secondary parents in the taxonomy.
2. **Generate candidate levers.** 10 to 12 candidates drawn first from owner reviews, reusing shared lever definitions where they exist, each with a type, units, explanation, related needs and a safety flag where relevant. The same step proposes the node's dependencies and sourced safety rules.
3. **Discover products.** 15 to 20 widely sold products (at least 10 for niche nodes), each with its manufacturer product-page URL.
4. **Verify and auto-approve.** Each brand's official domain is verified once: automatically when it is HTTPS, not a retailer or review site, contains the brand name and its homepage identifies the brand; otherwise by a one-time admin confirmation. A product is approved automatically when its page is on its brand's verified domain, fetches successfully, names the model, is confirmed to belong in the node and is not a duplicate. Products that fail a check go to a needs-attention list without stopping the run.
5. **Extract values.** For every candidate lever and approved product, the value from the manufacturer page or a text-based PDF manual on the brand's verified domain, with a short evidence quote and the source URL, or unknown. One page fetch per product covers all candidate levers.
6. **Validate with owners.** The owner baseline survey (below) rates the candidate levers and asks owners which matter most; responses are a Verdict-owned asset. Paid owner panels are dropped.
7. **Review and publish.** One review screen: remove any auto-approved product that should not be listed; order the lever list, each card showing its owner-importance evidence and data coverage (for example 18 of 20 products); accept, edit or reject spec values for the featured five. Publishing is atomic: the node, its lever list, the listed products and their values go live together. Value review is the one human step, by design.

**Publish gate**

- Each featured lever with a Spec badge needs an accepted value for at least 80% of the node's published products. Levers rated only by owners are exempt and show "No owner data yet" until owners rate them.
- Values on safety-flagged levers (all car seat levers) are each reviewed individually and cannot be bulk-accepted.
- Runs take minutes; the admin is notified when one is ready for review.

**Review synthesis per product**

- A job queries a licensed search API, reads expert and publisher reviews from sites that permit it, and has Claude write a short paraphrased summary of themes per lever, each claim linked to its source.
- It is shown on the product page as **What expert reviewers say**, visually separate from Verdict reviews. Verdict stores the summary and the links, never the source text.
- As Verdict's own long-term reviews accumulate, they take over the page. External reviews mostly cover first impressions; Verdict covers the long term.

**Owner evidence sources (approved Nov 26; counsel signs off on run-time reading before public launch)**

1. **Verdict-generated:** the owner baseline survey; a two-minute AI retro interview about a product the user already owns; "ask the owners" questions routed to verified owners in their next check-in; import of reviews users wrote elsewhere.
2. **Read at run time:** during a generation run, an AI web-search API reads blogs, expert reviews and public forums. Verdict stores counts, sentiment per lever, failure modes and citation links, never source text. Reddit is excluded: commercial use needs a contract, and Reddit is suing companies that collect its content through search results.
3. **Licensed:** the Reddit Data API under contract once there is traction; YouTube comment sentiment within its developer terms (comment text deleted within 30 days). Google Reviews are out: they cover places, not products, and cannot be stored.

**Data sourcing rules**

- No automated collection from third-party sites whose terms prohibit it (for example Amazon and Yelp), no logins, and no circumvention of blocks, CAPTCHAs or rate limits. robots.txt is respected.
- Product values come only from verified brand domains (the allow-list) and text-based PDF manuals hosted there. Retailers and review sites are excluded.
- Every extracted value carries an evidence quote that appears verbatim on its source page. A value not stated there is recorded as unknown, never inferred.
- An admin may enter a missing value with its source URL and a pasted quote. The quote is checked against a fresh fetch where possible; if the site blocks fetching, the value is labelled admin-attested.
- Manufacturer images are not stored or shown.
- Licensed review data is used only when the license grants Verdict's specific commercial use; a vendor's own collection method is checked during diligence.
- Brand-supplied specs may fill lever values, labelled with their source. Brand-supplied review content is never used in the reviews half.
- Reviewer names and personal details from external sources are never stored.
- Counsel signs off on the review-synthesis method before it is shown publicly.

**Acceptance criteria**

- [ ] A run for a new decision node produces candidate levers, 15 to 20 candidate products and their extracted values with no manual data entry.
- [ ] Products pass automated checks (verified brand domain, successful fetch, model named, node fit, no duplicate) or land in a needs-attention list; no manual product approval is required.
- [ ] Every published lever has an explanation and an approval record (who, when).
- [ ] Every published value has a source link and an evidence quote, or is marked unknown.
- [ ] Publishing is refused when any featured Spec-badged lever is below 80% value coverage.
- [ ] The product page never shows external summaries without the "What expert reviewers say" label.

## Owner baseline survey

A one-page, tap-only survey per decision node collects baseline owner data before Verdict has its own long-term reviews. It is shared as a link that opens straight to the page. [Mock-ups: carry-on, infant car seats, full-size strollers](https://claude.ai/artifact/S4gbA9Lk4tDt8pV53Me4CH).

**Page structure**

1. A slim Verdict bar with an "About +" button that expands the survey's purpose and a "Learn more" link. Below it, the survey title and "6 questions · About 2 minutes · No name needed".
2. **About you (optional):** one sentence on aggregate-only use, linked to how Verdict uses demographics. Each topic is a button; tapping it opens an inline panel with that topic's choices, and an answered button shows its answer. A checkbox saves the answers for future surveys.
3. **Six product questions,** all taps, no open-ended text:
   1. Which product: 5 to 7 brand buttons including Other, then a model list from the catalog. Other swaps in brand and model text boxes.
   2. How long owned, and how hard it is used (trips for luggage, installs or moves for car seats, how often for strollers).
   3. Overall score, 1 to 10.
   4. Ratings, 1 to 5, on the node's top five levers.
   5. What would matter most if buying again: up to 3 of about 10 candidate levers. This ranks levers by owner importance.
   6. Would you buy it again: yes, probably, no.
4. "+ I want to say more", once at the bottom, opens an optional text box.
5. A thank-you screen offering one check-in, by email, in about 6 months.

**Demographic topics**

| Topic | Choices |
| --- | --- |
| Age | Under 25, 25–34, 35–44, 45–54, 55–64, 65+, prefer not to say |
| Gender | Woman, man, non-binary, prefer not to say |
| Race or ethnicity | OMB categories including Middle Eastern or North African; pick all that apply |
| ZIP code | 5 digits |
| Children | None, expecting, 1, 2, 3 or more |
| Marital status | Single, married, partnered, divorced, widowed, prefer not to say |
| Household income | Five bands, prefer not to say |
| Where you live | City, suburb, small town, rural |
| One per node | Carry-on: why you travel. Infant car seats: your vehicle. Full-size strollers: your height |

Car seat surveys never ask owners to rate crash protection, and the page says why: no owner can judge it from everyday use.

**Acceptance criteria**

- [ ] A survey link opens directly to one node's page, with every question on that page.
- [ ] The page can be completed with taps only, in about 2 minutes, at 390 px phone width.
- [ ] Every demographic topic can be skipped; saved demographics pre-fill the next survey.
- [ ] Responses feed the node's lever ratings (question 4) and lever importance (question 5).

**Decided Nov 26**

- Built in Verdict: a public survey page and a responses table (gated: schema). Responses are labelled "survey, retrospective" and kept apart from verified-purchase reviews.
- One link per decision node; an optional link parameter pre-fills the product and skips question 1.
- All demographic topics, including race, household income and non-binary gender, are on the public link, every one optional. This is sensitive data under several state privacy laws, Maryland's included.
- Saved demographics live on the respondent's device until Verdict accounts exist, then move to the account.
- A "How Verdict uses demographics" page goes live with the survey and commits to aggregate-only use, no sale and deletion on request.

## Ranking: Top Rated and Best Fit

Best Fit is the default sort, but it only applies when there is enough similar evidence; otherwise the list falls back to Top Rated and says so. Both sorts rank on long-term scores, not first impressions.

**Top Rated**

- Score = stage-weighted average of all reviews, with later stages weighted more (current weights run from 0.6 at first impression to 1.0 at 1 year and beyond).
- Shrunk toward the category average when a product has few reviews, so one 10/10 review cannot top the list.
- Ties broken by the number of long-term (1 year or later) reviews.

**Best Fit**

- Similarity between the user and each reviewer comes from two sources: project answers (needs, such as terrain or air travel) and demographics (such as household size or region). Needs carry more weight, because they are known from the first visit and relate directly to the levers.
- Each product's Best Fit score = similarity-weighted average of its reviews' stage-weighted scores.
- Exact weights are a statistical design question for a later ADR; the spec fixes the inputs and the rules below.

**Rules**

1. **Minimum evidence.** Best Fit is shown for a product only when at least N similar reviewers exist (N to be set, starting proposal 5). Below that, the product is ranked by Top Rated and labelled "not enough similar reviewers yet."
2. **Explain every result.** Each item shows a one-line reason, for example: "8.4 at one year from 12 parents who also fly often and live in a city."
3. **No hidden inputs.** Only the user's own project answers and profile fields are used, and the user can see and edit them.
4. **Firewall.** No ad, brand or payment data is ever an input.

## Projects

A project is a saved, guided purchase decision that a user returns to over days or weeks, and it ends by starting the review cycle.

**Structure**

- A **project template** belongs to a category (or a set of categories) and defines ordered milestones. Each milestone holds one or more steps: a question, a measurement, a checklist or a reading.
- A **user project** is an instance of a template, saved with the user's answers and progress. It shows as a horizontal roadmap: a line with circle milestones, done, current and upcoming.
- Answers map to levers. For example, "air travel often" raises the weight of fold size and weight; "rough terrain" favours rubber wheels.

**Stroller template (draft)**

1. How you'll use it: daily routes, terrain, jogging, air travel.
2. Your car and home: trunk space, car seat you have or plan to buy, stairs or storage limits.
3. Must-haves and budget.
4. Shortlist: Best Fit results filtered by the answers above.
5. Decide and buy: record the product and purchase date.
6. First impression review, which starts the check-in cycle.

**Multi-product projects**

Every category's product dependencies (see Dependencies and How to shop) become gates in its project template, and the roadmap shows them. Order matters when one product constrains another.

- Travel system: choose the car seat first, then only show strollers compatible with it.
- Freestanding bathtub (later category): confirm floor load and drain location, then choose the tub, then the filler and drain fixtures that fit it.

Bunk bed: choose the bed first, then show only mattresses within its maximum mattress height and weight limit.

**Acceptance criteria**

- [ ] A user can start, leave and resume a project; answers and progress persist.
- [ ] Completing a milestone updates the category filters and the Best Fit shortlist.
- [ ] A dependency blocks a later item until its prerequisite is chosen, and says why.
- [ ] Recording a purchase sets the anchor date for the 2-week check-in.

## Review cycle

The review cycle is already built: review threads, drift scoring, nudges at 2 weeks, 3 months, 1 year and 2 years, email opt-in and verified email delivery. The spec adds three things to connect it to projects and levers.

1. **Purchase from a project.** Recording a purchase creates the review thread with the purchase date as the anchor, so check-ins are scheduled from the real purchase, not from when the review was written.
2. **Lever-based questions.** Each review asks for a short rating on each of the category's featured five levers, alongside the overall score. This makes "how did the wheels hold up at one year" a measurable answer.
3. **One-tap check-in from the email.** The nudge email opens a short form (overall score, one lever question, "still happy?") that can be done in under a minute; the full review stays optional.

**Per-category check-ins.** Each category gets its own minimal template: overall score, "still happy?", and one or two questions on that category's key levers, done in under 60 seconds. Categories where wear follows use rather than time ask a usage count; luggage asks trips since the last check-in.

**Acceptance criteria**

- [ ] A purchase recorded in a project creates the thread and schedules the 2-week nudge from the purchase date.
- [ ] Lever ratings are stored per review stage and feed the product page curve.
- [ ] A user can complete a check-in from the email link in under 60 seconds.

## Advertisements half (concept)

The advertisements half is the revenue engine: a digital museum of advertising, and a place where people engage directly with brands they like. It is a concept to make concrete before any build.

**Concept**

- **Archive:** historical ads (for example Coca-Cola and Ford) organised by brand, decade and medium, with context on each campaign.
- **Brand engagement:** brands maintain a presence where users can follow them, see current campaigns, and interact directly.
- **Revenue:** brands pay for their presence, curation or engagement features. The model is not yet defined.

**Follow brands.** Users choose brands to follow, learn about each brand and its products, and engage with it over time. A brand's own pitch page (why choose us) lives here. The reviews half has no brand pages: it highlights products on their merits only.

**Constraints**

- **Rights.** Historical ads are copyrighted and their marks are trademarked. Content must come from brand partnerships, licensing or clearly public-domain material, never scraped. This needs legal review before launch.
- **Firewall.** A brand's payment buys nothing in the reviews half (see Vision and structure). Users must be able to see that the halves are separate.

**Open questions**

- Who pays, for what, and at what price?
- What does a user do in the archive besides browse, and why do they come back?
- What does "interact directly with a brand" mean concretely: follow, message, offers, feedback?
- Does the archive launch with partner brands only, or with licensed or public-domain collections?
- What separates this from a brand's own website and social accounts?

## Data model, phasing and open decisions

**New entities (reviews half)**

| Entity | Holds | Links to |
| --- | --- | --- |
| TaxonomyNode | Name, kind (navigation or decision), search terms, explainer | Primary parent, secondary parents, levers, products |
| LeverDefinition | Shared name, type, units, explanation, safety flag | Decision nodes that use it |
| NodeLever | A decision node's ranked lever list, top five featured, with each lever's badges (Spec, Experience, Fit, Trade-off) | TaxonomyNode, LeverDefinition |
| GenerationRun | Candidate levers, products and values for one node; cost; status | TaxonomyNode |
| BrandDomain | Brand, verified manufacturer host, how it was verified (automatic or admin) | Products |
| ProductLeverValue | Value, status (proposed, accepted, rejected), evidence quote, source URL, admin-attested flag | Product, LeverDefinition |
| ProjectTemplate | Milestones, steps, dependencies between items | One or more decision nodes |
| UserProject | Answers, progress, chosen products, purchase dates | User, ProjectTemplate, ReviewThread |
| ReviewLeverRating | A rating for one lever at one review stage | Review, LeverDefinition |
| SurveyTemplate | A node's brand list, usage question, five rated levers, buy-again candidates, node demographic topic | TaxonomyNode, LeverDefinition |
| SurveyResponse | Answers, optional text, check-in opt-in, source label (survey, retrospective) | SurveyTemplate, Product |
| DemographicProfile | Optional demographic answers saved for future surveys | User or device (open decision) |
| NodeDependency | Kind (situation or product), the project question or related node, the levers it constrains, approval record | TaxonomyNode, LeverDefinition, related TaxonomyNode |
| SafetyRule | Requirement, source URL, condition on project answers, warning text, approval record | TaxonomyNode |

Existing entities (users, products, review threads, reviews, nudges) stay, and Phase A's single-level categories become decision nodes. The ads half gets its own schema and is never joined to these tables.

**Phasing**

1. **Phase A, catalog and levers:** the taxonomy, the unified generation run (levers, products and values) with its review screen, and the Carry-on luggage node generated first, then the seven launch decision nodes, travel-system pair first, the wired "Add product" flow, category and product pages. The owner baseline survey (carry-on, infant car seats, full-size strollers) runs in parallel. Lever badges, node dependencies and safety rules ship with the taxonomy under one design note (gated: schema). Demand-driven category logging follows Phase A as a small item.
2. **Phase B, projects:** the stroller and car seat templates, roadmap UI, travel-system dependency, purchase recording into the review cycle.
3. **Phase C, ranking:** Top Rated with shrinkage, then Best Fit with the evidence threshold and explanations.
4. **Phase D, ads half:** only after the concept questions are answered and legal review is done.

The Phase 1 validation pilot (a small group of parents using real strollers and car seats) can run alongside Phase A and B, and should inform Phase C.

**Open decisions**

- [ ] Levers for Carry-on and the seven launch decision nodes, chosen in their generation runs. A by-hand Carry-on draft is in the Carry-on simulation (https://claude.ai/artifact/AHiyht52o19g4SDcpuAGzV).
- [ ] How bundles such as travel systems are modelled (deferred; overlaps use "also listed in").
- [ ] Best Fit minimum evidence threshold N.
- [ ] When to ask for profile and demographic fields outside the owner survey.
- [ ] Whether projects can be shared with a partner.
- [ ] Ads-half revenue model and rights strategy.
- [ ] Licensed search API provider for review synthesis and run-time reading.
- [ ] Counsel sign-off on review synthesis and run-time reading before public launch.
- [ ] Featured top five: fixed per node or personalised. Recommended: a fixed default per node, reordered by project answers, and the page says so.
- [ ] Purchase interface and the firewall. Recommended: no payment of any kind (brand, retailer, affiliate) influences ranking; prices show after ranking; commissions are disclosed; build after launch.
- [ ] Carry-on simulation findings. Recommended: add to the schema design note a dimension basis (with wheels, case only, unstated), several verified hosts per brand, a labelled and dated list price, structured warranty fields (term, airline damage, registration needed), evidence weighted by time owned, and a source-quality filter.
