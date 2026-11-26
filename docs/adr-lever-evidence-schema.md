# ADR: Lever badges, dependencies, safety rules and the owner survey
Status: proposed. Spec sections: "Product taxonomy" (Luggage goes first), "Reviews half: search, value levers, product pages" (badges, featured-five panel, Dependencies and How to shop, Safety, Price), "Lever generation and review synthesis" (steps 2, 6, 7, Publish gate, Owner evidence sources), "Owner baseline survey", "Ranking: Top Rated and Best Fit", "Projects" (Multi-product projects), "Review cycle", "Data model, phasing and open decisions".

## Context
What exists (builds on `docs/adr-generation-run.md`, whose section 5 stays in force):

- **Five levers, fixed.** `NodeLever.position` is 1–5 and set exactly when `APPROVED` (`backend/prisma/schema.prisma:696`, `@@unique([nodeId, position])` at :715; CHECKs in `backend/prisma/migrations/20261120000200_lever_definitions/migration.sql:107-112`). A deferred trigger allows 0 or 5 approved levers per node (same file :196-220). `LEVERS_PER_NODE = 5` (`backend/src/catalog/publish.ts:15`). Publish takes exactly five ids (:56-58), gates every one of them at 80% (:94-104), snapshots only those five (:123-125) and copies only their values (:135-149). `leversPerNode` goes to the admin UI (`backend/src/routes/admin.ts:54`). The PR #13 board has five slots (`frontend/src/components/levers/PublishBoard.tsx:1,9`). The review page hardcodes 5 (`frontend/src/pages/admin/AdminReviewPage.tsx:55,417`). Public reads take `APPROVED` levers by `position` (`backend/src/catalog/public.ts:29-39`), and the category page has five filter columns (`frontend/src/pages/CategoryPage.tsx:118,125`). A published lever cannot be retired on its own (`backend/src/catalog/levers.ts:139`).
- **No badges, dependencies or safety rules.** A lever has a type (`schema.prisma:453-458`) and a `safety` flag (:698). The LEVERS stage only gets the definitions and the reference levers (`backend/src/generation/runs.ts:318-321`). It returns candidates and nothing else (`backend/src/generation/schemas.ts:77-79`), and its stored output is just counts (`runs.ts:365`).
- **Survey is a CSV of rankings.** `SurveyImport`/`SurveyRanking` (`schema.prisma:761-787`) hold an admin-uploaded `lever, rank, respondents` file (`backend/src/catalog/survey.ts:50-73`). The board matches it to cards by lever name (`admin.ts:253,261,286`). There are no responses, no public route and no per-respondent data.
- **Demographics today.** `UserDemographics` (`schema.prisma:70-87`) belongs to accounts. Its enums do not match the spec's topics: ages start at `AGE_18_24` (:349-356), income has six bands (:358-365), gender is free text, region is used instead of ZIP, and education and lifestyle tags are stored that the spec never asks for. It is written by `PUT /api/users/me/demographics` (`backend/src/routes/users.ts:59-69`) and returned by `/auth/me` (`backend/src/routes/auth.ts:243`). The ML recommender also reads it and gives it 30% of the similarity weight (`ml/models/recommender.py:43-50,103,286-288`; `backend/src/routes/recommendations.ts:31-41`). **That conflicts with the request:** the request says demographics must not affect ranking before the Best Fit ADR, and the code already uses them. This design does not resolve the conflict; it is open question 1.
- **The ML service** connects with the backend's own `DATABASE_URL` (CLAUDE.md, Architecture), so it can read every table this design adds. Its only query reads `reviews`, `review_threads` and `user_demographics` (`recommender.py:89-106`).
- **Luggage is missing.** The launch taxonomy migration creates only Baby and Kids and Seats (`backend/prisma/migrations/20261120000100_launch_taxonomy/migration.sql:26-54`). `LAUNCH_ORDER` starts with Infant car seats (`admin.ts:47`). The spec now puts Carry-on first (spec "Luggage goes first").
- **Projects do not exist** (spec Phase B). This design defines only what Fit checks, dependency gates and safety warnings need from a project: a typed answer contract (D6). It does not design projects.

## Decisions

### D1. One ranked lever list per decision node; ranks 1–5 are the featured five
- `NodeLever.rank Int?` is the admin's working order. Every lever in the working list has a rank. Ranks run 1..n with no gaps, and "featured" means rank ≤ 5; it is computed, not stored. `rank` is null for `RETIRED` levers and for a published lever the admin has removed, which publish retires (D5). The spec asks for exactly this list: "one lever list. The top five appear in their own panel" (spec, Reviews half).
- `NodeLever.publishedRank Int?` is the public order. Only publish writes it, so re-ranking after a publish changes nothing public until the next publish. This is the snapshot rule of `adr-generation-run.md` D10, applied to order.
- **Integrity.** A deferred constraint trigger checks at commit that a node's non-null ranks are exactly 1..n, and that its `APPROVED` levers number 0 or at least 5 with `publishedRank` exactly 1..k. Row CHECKs: `rank` is null when `RETIRED`; `publishedRank` is non-null exactly when `APPROVED`. Being deferred, the trigger lets one transaction swap ranks. A plain unique index would not, and Prisma cannot declare a deferrable unique constraint, so `migrate diff` would not track one.
- **Concurrency.** `TaxonomyNode.leverRankingVersion Int` goes up by one on every reorder, add, remove or retire. `PUT /api/admin/nodes/:id/lever-ranking { order, seen }` locks the node row (`lockNode`), compares `seen` with the version and answers 409 if they differ. This is the same pattern as value decisions (`adr-generation-run.md` section 5, "Review decisions are conditional").
- **New candidates** from a later run are added at the end (n+1…) in the model's order.
- Rejected: keeping `position` 1–5 and adding a separate "extra levers" list. The spec has one list, and two lists would need two orderings and two publish paths.

### D2. Badges are a set on `NodeLever`; each badge has a meaning in data
`NodeLever.badges LeverBadge[]` with `LeverBadge { SPEC, EXPERIENCE, FIT, TRADE_OFF }`. A lever has at least one badge. Badges are per node, as in the spec's data model ("NodeLever … with each lever's badges").

| Badge | Data it requires | Enforced by |
| --- | --- | --- |
| SPEC | the definition has a manufacturer value type (not the new `LeverType.RATING_ONLY`); EXTRACT asks for values of SPEC levers only | trigger on `node_levers` |
| EXPERIENCE | the definition is `ownerRatable` (new, default true; false with `notRatableReason` for crash protection: spec "Car seat surveys never ask owners to rate crash protection") | trigger |
| FIT | SPEC is also set, and `fitRule` (D3) is non-null. A Fit check compares a manufacturer value. | CHECK; publish validates `fitRule` |
| TRADE_OFF | `tradeOff` (D4) is non-null | CHECK; publish validates it |

- **`LeverType.RATING_ONLY`** is new: a lever with no manufacturer value that owners rate, such as "Wheels roll straight". Its definition has no unit and no allowed values (CHECK). It has no filter on the category page.
- Experience-only levers need a type of their own because every definition must have a type today (`schema.prisma:663`). Rejected alternative: making `type` nullable, which breaks every reader of `type`.
- **Safety** is unchanged. `NodeLever.safety` is still derived (`20261120000200_lever_definitions/migration.sql:125-142`), and values on safety levers are still accepted one by one (`product_lever_values_no_bulk_safety`, `20261120000300_lever_values_v2/migration.sql:140-161`). Badges never relax either rule.
- **Experience score.** An Experience lever shows an owner score only when at least 5 respondents rated it (Q13); otherwise it shows "No owner data yet" (spec :74).
  - **Source today:** survey ratings only (D10), labelled "Owner survey (retrospective), n = …".
  - **Later:** `ReviewLeverRating` (spec, Review cycle) is shown separately when it arrives. The two sources are not merged.
  - Expert-review evidence stays out of scope.

### D3. A Fit check is a typed comparison against a named project answer
`NodeLever.fitRule Json` (zod-validated on write and at publish):
```
{ answerKey: "airlines_flown",          // a question of an approved NodeDependency on this node (D6)
  answerField: "sizerIn" | null,         // a field of the chosen option's value, or null for the answer itself
  operand: "ANSWER" | { relatedLever: <definitionId> },  // product dependencies compare with the chosen related product
  comparator: "LTE" | "GTE" | "DIMS_WITHIN" | "CONTAINS",
  quantifier: "ALL" | "ANY",             // multi-select answers; ALL = must fit every airline flown
  requiresBasis: "WITH_WHEELS" | null }  // dimension levers only (Q2)
```
**Result** (computed by `evaluateFit()`, a pure function in a new `catalog/fit.ts`):
- `NOT_SHOWN`: the answer does not exist, or the chosen options have no value for `answerField`. Spec: "shown only when the answer exists".
- `FITS` or `DOES_NOT_FIT`: the product's **published** known value compared as stated.
  - Equality fits.
  - No tolerance is added (values are already rounded to 2 decimals, `adr-generation-run.md` D7).
  - `DIMS_WITHIN` compares the sorted dimensions largest-first, because manufacturers list L, W and H in no fixed order and the evidence check cannot tell which number is which axis.
  - An admin-attested value gives a result and keeps its "Admin-attested" label.
- `UNVERIFIED` with a reason, whenever the check cannot be proven:
  - the value is unknown;
  - the value is not in `published_lever_values` (an accepted but unpublished value is not used);
  - the value's `dimensionBasis` does not meet `requiresBasis` ("Size stated without wheels");
  - a `CONTAINS` check misses ("Not on the manufacturer's compatibility list"; a missing entry is not proof of a mismatch).

**Display and filtering:**
- An `UNVERIFIED` product is never hidden by a Fit filter. It stays in the list with its label.
- A Fit filter hides `DOES_NOT_FIT` products only when the user turns the filter on, and the page says how many it hid.

Rejected: free-text fit rules interpreted by the model at read time. They are untestable and nondeterministic.

### D4. A Trade-off lever enters ranking only through the buyer's stated preference
`NodeLever.tradeOff Json`:
```
{ preferenceKey: "shell_preference",          // a CHOICE question of an approved NodeDependency (D6)
  sides: [{ key, label, why, match? }, { key, label, why, match? }],   // exactly two; `why` ≤ 200 chars each
  neutralOption: "no_preference" }
```
- **The card** reads "Depends on you" and shows both `why` texts (spec :72).
- **`match`** says which published values belong to a side (`{ valueText: [...] }` or `{ valueBool: true }`). It is allowed only when the lever also has SPEC.
  - A Trade-off lever **without** SPEC is advice only: a card and a project question, with no effect on any product's position.
  - This is why open question 17 recommends adding SPEC to "Hardside or softside".
- **Rule (spec Ranking rule 3):** a Trade-off lever affects order or filtering only when the user's own preference answer exists and is not the neutral option.
  - The answer is a project answer, so the user can see and edit it.
  - With no answer, the lever contributes nothing. There is no default side, and no side is inferred from similar reviewers, demographics or popularity.
  - Top Rated never reads Trade-off levers.
  - Phase A has no ranking. Until Phase C, the rule means the category page's default order and default filters never depend on a Trade-off lever's values (`public.ts:227` sorts by name).
- Rejected: giving Trade-off levers a "majority preference" default. That would be a hidden input.

### D5. Publish takes the whole list; the 80% gate applies to featured levers with SPEC
**Request:** `POST /api/admin/nodes/:id/publish { order: string[], seen: number }`. `order` is every lever with a non-null rank, in rank order, and `seen` is `leverRankingVersion`. This replaces `{ leverIds: [5] }` (`publish.ts:47,56`).

**Checks**, in the existing transaction with the node locked (`publish.ts:60-61`):
1. `order` equals the node's ranked set, and `seen` is current. Otherwise 409 "The lever list changed since you loaded it".
2. There are at least 5 levers.
3. The existing busy-run, minimum-products and dry-run checks (`publish.ts:65-92`) stay.
4. Every lever is valid:
   - it has at least one badge;
   - category allowed values: the existing rule (:83-84);
   - FIT: the `fitRule` parses, and its `answerKey` is a question of an approved dependency of this node;
   - TRADE_OFF: two sides, and `preferenceKey` is an approved CHOICE question.
5. **The gate:** each lever with `rank ≤ 5` **and** SPEC must meet `meetsGate(accepted, products)` (`publish.ts:17`, unchanged).
   - Featured levers without SPEC (Experience-only, Trade-off-only) are exempt.
   - Levers ranked 6 and below are not gated: a listed product without a published value shows "Unknown" (`adr-generation-run.md` D10), which satisfies the spec's "a value (or an explicit unknown)".
   - The 400 still names each failing lever.
6. Every approved safety rule has a verified or admin-attested source (D7).

**Writes:**
- Every ranked lever becomes `APPROVED` with `publishedRank = rank` and a snapshot: the existing fields plus `badges`, `fitRule`, `tradeOff` and `ownerRatable`. `approvedById/At` are kept from the first approval (the spec's approval record).
- `APPROVED` levers with a null rank become `RETIRED`. That is how a published lever is removed, which replaces `levers.ts:139`.
- Products are listed as today.
- Values: accepted values of **every SPEC lever in the list** are copied to `published_lever_values`, not only five.
- Approved dependencies and safety rules get their `published` snapshot; every other dependency or rule of the node gets its snapshot cleared.

**Unpublish** (`publish.ts:163-173`) also clears `publishedRank` and the dependency and safety snapshots, and keeps `rank`.

**Public reads** (`public.ts`):
- `publicLevers` returns the whole list by `publishedRank`, with badges and a `featured` flag.
- The category page puts the featured SPEC levers at the top as filters, shows the other featured levers as cards, and has a "Full list" panel.
- `productLevers` returns every published lever.
- Snapshots without `badges` (only pre-migration rows) parse as `["SPEC"]`.

**Other code:** `LEVERS_PER_NODE` becomes `FEATURED_LEVERS = 5` plus `MIN_PUBLISHED_LEVERS = 5`, and admin config sends `featuredLevers`. The PR #13 board becomes one sortable list with a "Featured" divider after rank 5, keeping its keyboard and live-region behaviour (move up or down, move to rank n, Remove). Each card gets badge toggles and Fit and Trade-off editors.

Rejected: publishing only the featured five and leaving the rest admin-only. The spec says the panel opens the full list.

### D6. `NodeDependency` and the project answer contract
**Table `node_dependencies`:**

| Field | Notes |
| --- | --- |
| `nodeId`, `kind` | the node it belongs to; `SITUATION` or `PRODUCT` |
| `questionKey` | `^[a-z][a-z0-9_]{1,40}$`, unique per node |
| `prompt`, `answerType`, `options` | `answerType` is `CHOICE`, `MULTI_CHOICE`, `NUMBER` (with a canonical unit), `DIMENSIONS` (in), `BOOLEAN` or `PRODUCT_REF`. `options` are `[{ key, label, value?, sourceUrl? }]`. A `value` holds typed facts such as `{ sizerIn: [22,14,9], weightLimitLb: null }`; options that carry facts need an https `sourceUrl` and are approved with the dependency. |
| `relatedNodeId` | `PRODUCT` only, nullable: the decision node whose product constrains this one. Null means a product with no node yet (a power bank), which makes the dependency a plain question with no gate. |
| `status`, `proposedByRunId`, `approvedById/At` | `PROPOSED` / `APPROVED` / `REJECTED`; a decision needs who and when (CHECK) |
| `published` | the snapshot written by publish (D5) |

**Table `node_dependency_levers`** (`dependencyId`, `definitionId`): the levers it constrains. Each must be a non-retired lever of the same node (trigger).

**Triggers:**
- `nodeId` and `relatedNodeId` are decision nodes, and different from each other.
- **No cycles in `PRODUCT` edges**, checked under one advisory lock with a recursive walk, like the taxonomy trigger (`adr-generation-run.md` D1). The API pre-check gives a readable 400.

**Answer contract** (all Phase B needs; `catalog/answers.ts`):
- `answerSchemaFor(publishedDependencies)` builds a zod schema keyed by `questionKey`. A project stores `{ [questionKey]: value }` and validates it against the node's current published snapshot.
- An answer to a question removed by a republish is ignored, not deleted.
- `PRODUCT_REF` values are `{ productId }` (a listed product of `relatedNodeId`), `{ owned: "other", text }` or `"none"`.

**Gates (spec, Multi-product projects):**
- `gateOrder(nodeIds)` returns a topological order of the nodes in one project, plus, for each node, the `PRODUCT` dependencies that block it until the related product is chosen, each with its prompt as the reason.
- A project for only the dependent node (strollers only) gets the dependency as a question ("Which infant car seat do you have or plan to buy?") instead of a gate.
- The constraint itself is a Fit rule with `operand: { relatedLever }`. Example: the stroller's "Car seat compatibility" list `CONTAINS` the chosen seat's brand and model, normalised.

Rejected: storing dependencies as prose on the node. They would not be checkable and could not become project questions.

### D7. `SafetyRule`, a section on the category page, and acknowledgements in projects
**Table `safety_rules`:**

| Field | Notes |
| --- | --- |
| `nodeId`, `requirement` | `requirement` ≤ 300 chars, plain language |
| `authority`, `sourceUrl`, `sourceQuote` | the source and a verbatim quote from it |
| `sourceCheck` | `VERIFIED` (the quote was found in a fresh fetch, with the evidence rules of `generation/evidence.ts`), `ADMIN_ATTESTED` (the fetch was blocked, as for manual values in `adr-generation-run.md` A4) or `UNVERIFIED` |
| `appliesWhen` | ≤ 200 chars, shown on the category page |
| `condition` | JSON, below |
| `warningText` | ≤ 300 chars |
| `status`, `proposedByRunId`, `approvedById/At`, `published` | the approval record and the publish snapshot (D5) |

- `sourceUrl` must be https on a host in a fixed, coded list of authorities (faa.gov, tsa.gov, cpsc.gov, nhtsa.gov, …). The fetcher (`generation/fetch/fetcher.ts`) gets a new permit class, "authority page", with every other rule unchanged (robots.txt, rate limit, no bypass). The authority list is a data-sourcing change, which is why this design is gated.
- **Condition:** `{ all|any: [ { answer: key, op: "in"|"eq"|"gte"|"lte"|"exists", value }, { lever: definitionId, op: "is_true"|"not_false"|"in"|"gte"|"lte", value } ] }`. `evaluateSafety()` is pure. **It fails closed:** a lever predicate on an unknown or unpublished value counts as true, and the warning says "may apply". A missing answer makes an answer predicate false, but the rule still shows in the category-page section.
- **Category page:** every published rule of the node is listed (requirement, source link, "applies when") in a Safety section next to the levers. This needs no project.
- **Projects (Phase B; the table is designed here and created with `user_projects`).** `safety_acknowledgements(id, userProjectId, userId, safetyRuleId, ruleSnapshotHash, answersHash, productId?, acknowledgedAt)`.
  - A triggered warning stays expanded and blocks completing its milestone until the user presses "I understand" and that row is written.
  - The ack covers one version of the rule and one set of answers. A republished rule (different `ruleSnapshotHash`) or answers that change what the condition reads (different `answersHash`) trigger it again.
  - An acknowledged warning collapses but is never removed from the project summary.
  - **"Not silently" therefore means** that no code path hides a triggered warning without an ack row carrying the user, the time and the rule version. There is no "dismiss all" endpoint.
- Rejected: a dismiss flag on the project. It records no version, so a later, stricter rule would stay dismissed.

### D8. Generation run changes (spec step 2)
- **LEVERS output** (`schemas.ts:77`) gains:
  - per candidate: `badges`, `ownerRatable` (+ reason), `fitRule?` and `tradeOff?`;
  - at node level: `dependencies[]` (≤ 8) and `safetyRules[]` (≤ 6, each with authority, URL, a quote to look for, condition and texts).
  - Everything is strictly validated. Unknown `answerKey`s, or levers not in the candidate set, fail the stage (`validation_failed`).
  - Candidates are ranked in the model's order after the existing ranks. Dependencies and rules are stored `PROPOSED`.
- **Then the stage fetches each safety-rule URL** through the fetcher (authority permit) and runs the verbatim check. A miss leaves the rule `UNVERIFIED` for the admin to fix with a pasted URL and quote, exactly like a manual value (`adr-generation-run.md` A4).
- **EXTRACT** asks only for SPEC candidates (fewer output tokens).
- **Cost:** about +4k output tokens for LEVERS (≈ +$0.08 per node at `adr-generation-run.md` 5.6 prices) plus a few authority fetches. LEVERS is estimated at 10k out (D5 table), so the default `GENERATION_MAX_TOKENS` 16000 still fits. Too long an answer fails `validation_failed` and Resume retries.
- **Review screen:** the Levers step gets the ranked board (D5). New steps **Dependencies** and **Safety** each list proposals with Approve, Edit and Reject, plus the source-check result. Every action records who and when.

### D9. Owner survey: templates and one public route per decision node
**`survey_templates`** (`nodeId`, `version`, `status DRAFT|ACTIVE|CLOSED`):
- `brandOptions` (5–7, plus Other);
- `usageQuestion` (`{ prompt, options }`: trips for luggage, installs or moves for car seats, frequency for strollers);
- `nodeTopic` (`{ prompt, options }`);
- `createdById`, `activatedById/At`.

A partial unique index allows one `ACTIVE` template per node. An active template with responses is immutable; an edit creates the next version.

**`survey_template_levers`** (`templateId`, `definitionId`, `role RATED|IMPORTANCE`, `position`):
- exactly 5 `RATED`, all `ownerRatable`;
- 8 to 12 `IMPORTANCE`;
- both checked at activation.

The five are pinned **in the template**, because the survey is step 6 of the run, before the featured five exist (step 7). By default they are the five highest-ranked owner-ratable levers when the template is created.

**Routes** (`routes/surveys.ts`, outside `/api/admin`, under the general limiter plus D12):
- **`GET /api/surveys/:slug?product=<id>`** returns the active template:
  - the brands;
  - per brand, the model list: `IN_CATALOG` products of the node (`backend/src/catalog/products.ts:10-13`), not dry-run outside development and test;
  - the rated and importance levers from their definitions (name, explanation);
  - a form token (D12).
  - **Prefill:** `product` (≤ 64 chars) is used only if it is one of those products; otherwise it is ignored and question 1 is shown. A shared link never errors.
  - 404 when the node has no active template.
- **`POST /api/surveys/:slug/responses`**: strict zod body, D10.
- **`DELETE /api/surveys/responses`** `{ respondentKey } | { receiptCode }`: always answers 204, so it reveals nothing (D11).
- **`POST /api/surveys/responses/check-in`** `{ receiptCode, email }`: D12.
- **Admin:** create a draft from the current ranking, edit, activate and close; `GET /api/admin/nodes/:id/survey` for aggregates (D10, D11).

**Phase A CSV import:** `SurveyImport`/`SurveyRanking` stay as they are. They are aggregates without respondents, so they cannot become responses, and they are not migrated. The board shows them as "Imported survey (CSV)", next to the built-in survey's evidence.

### D10. Survey responses feed ratings and importance, and never reach reviews
**`survey_responses`:**

| Field | Notes |
| --- | --- |
| `templateId`, `nodeId` | the template version answered |
| `productId?`, `otherBrand?`, `otherModel?` | a product of the node, or 1–60 chars each; a response never creates a product |
| `ownedFor`, `usage` | option keys of the template |
| `overall`, `buyAgain` | `overall` 1–10 (CHECK); `buyAgain` is `YES`, `PROBABLY` or `NO` |
| `moreText?` | ≤ 2000 chars |
| `source` | `SurveySource.SURVEY_RETROSPECTIVE`; the only value, kept so labels stay explicit |
| `clientSubmissionId` | uuid, unique |
| `respondentKeyHash?`, `receiptHash` | D11 |
| `quarantined` | default false; D12 |
| `submittedAt` | |

**`survey_lever_ratings`** (`responseId`, `definitionId`, `rating` 1–5) holds only the template's `RATED` levers (trigger). A rating may be skipped.

**`survey_importance_picks`** (`responseId`, `definitionId`) holds at most 3 per response and only the template's `IMPORTANCE` levers (trigger plus zod).

A second submission from the same respondent key for the same template and product (or Other text) **replaces** the earlier one in one transaction (partial unique index on `(templateId, respondentKeyHash, productKey)`).

**Feeding levers (spec acceptance "Responses feed the node's lever ratings (question 4) and lever importance (question 5)"):**
- The owner score per (node, definition), and per (product, definition), is computed on read from non-quarantined ratings, shown only at n ≥ 5 (Q13), and labelled with its source.
- Owner importance per definition is the share of respondents who saw the lever as a candidate and picked it. It is shown on board cards ("Picked by 41% of 120 owners").
- Importance is evidence for the admin's ranking. It never re-ranks levers by itself.

**Kept apart from reviews** (spec "kept apart from verified-purchase reviews"):
- The survey tables have no foreign key to `review_threads`, `reviews` or `nudges`, and no survey code writes those tables.
- Drift is computed from reviews only. Nudges are planned per thread. `Product.avgRating*` and `totalReviewCount` are untouched.
- The ML loader reads only `reviews`, `review_threads` and `user_demographics` (`recommender.py:89-106`). The survey tables are visible to the ML service's credentials but never read; open question 16 recommends a role that cannot read them.
- The 6-month check-in (D12) opens a new survey response linked by `followsResponseId`, not a review thread.

### D11. Demographics: storage, access, aggregates, deletion, retention, logging
**Storage.**
- **`survey_response_demographics`** (`responseId` primary key, cascade) is a snapshot of what was given with that response, with these columns:
  - `ageBand` (`UNDER_25`, `A25_34`, `A35_44`, `A45_54`, `A55_64`, `A65_PLUS`, `PREFER_NOT`);
  - `gender` (`WOMAN`, `MAN`, `NON_BINARY`, `PREFER_NOT`);
  - `raceEthnicity RaceEthnicity[]`, multi-select: `AMERICAN_INDIAN_ALASKA_NATIVE`, `ASIAN`, `BLACK_AFRICAN_AMERICAN`, `HISPANIC_LATINO`, `MIDDLE_EASTERN_NORTH_AFRICAN`, `NATIVE_HAWAIIAN_PACIFIC_ISLANDER`, `WHITE`, `PREFER_NOT`. These are the OMB categories as revised in 2024; counsel and the copy editor confirm the labels. A CHECK makes `PREFER_NOT` exclusive.
  - `zip3` (Q12);
  - `children` (`NONE`, `EXPECTING`, `ONE`, `TWO`, `THREE_PLUS`);
  - `marital` (`SINGLE`, `MARRIED`, `PARTNERED`, `DIVORCED`, `WIDOWED`, `PREFER_NOT`);
  - `incomeBand` (`B1`…`B5`, `PREFER_NOT`; boundaries Q11);
  - `livesIn` (`CITY`, `SUBURB`, `SMALL_TOWN`, `RURAL`);
  - `nodeTopic` (an option key).
  
  A null column means the topic was skipped.
- **`demographic_profiles`** (`userId` unique, cascade) has the same columns plus `nodeTopics Json` (by node slug). It holds the account copy for prefill only.
- **`UserDemographics` is not reused.** Its bands differ, and it already feeds the recommender (Context).
  - Recommendation: freeze it (no new fields, no migration of its values: an 18–24 band cannot become "Under 25", and the six income bands cannot become five).
  - Its future depends on Q1.
- **Device copy:** `localStorage["verdict-survey"] = { version: 1, respondentKey, receipts: [{ node, code, at }], profile?, nodeTopics? }`.
  - `respondentKey` is a random uuid v4 that lets the device delete its responses. It and the receipts are always kept.
  - `profile` is kept only when the "save for future surveys" box is ticked.
  - The server never stores the device profile, only the per-response snapshot.
- **Moving to an account:** when signed in, the survey offers "Save to my account" (`PUT /api/users/me/demographic-profile`, explicit fields, never spread), then clears the device `profile`.
  - It is never automatic.
  - Responses are **never** linked to the account (no `userId` column), keeping "No name needed" true.
  - The spec says "until Verdict accounts exist"; accounts exist, so this reads it as "until the respondent signs in".

**Access.**
- No route returns a raw demographic row to anyone. Admins get aggregates only, from fixed reports: one demographic dimension at a time, per node. Demographics are never crossed with another demographic, with a product, or with free text.
- Every cell (count, share or mean) below **10** respondents shows as "fewer than 10". When one cell in a row is suppressed, the next smallest is suppressed too, so the hidden cell cannot be derived from the total.
- The account owner can `GET`, `PUT` and `DELETE` their own profile.
- Raw rows are readable only through database credentials (counsel item below).

**Ranking.** Survey demographics are never a ranking input. Account profiles are not one either until the Best Fit ADR decides (spec Ranking, Best Fit, lists demographics as an input; that ADR must also reconcile it with the "aggregate-only use" commitment, spec :238). The existing recommender use of `UserDemographics` is open question 1.

**Deletion on request.**
- `DELETE /api/surveys/responses` with the device's `respondentKey` deletes every response from that device; with a `receiptCode`, it deletes that one response. Ratings, picks, demographics and the check-in go with it (cascade).
- `DELETE /api/users/me/demographic-profile` deletes the account copy. Account deletion itself is backlog #8.
- Aggregates are computed on read, so a deletion leaves no trace in them.
- When the device storage is gone and there is no receipt, a response cannot be found, because nothing identifies it. The "How Verdict uses demographics" page must say so (counsel item).

**Retention.**
- Demographic snapshots and `moreText` are deleted 24 months after submission.
- Ratings and picks stay as lever evidence.
- Check-in emails: D12.
- A purge runs in the existing reconciler interval (`index.ts`).

**Logging.**
- Answers are never logged.
- Answers travel only in POST bodies, never in query strings (`morgan` logs URLs: `backend/src/app.ts:38`).
- The survey routes catch their own errors and log `errorClass` plus the route only. `errorHandler` logs the whole `err` (`backend/src/middleware/errorHandler.ts:23`), and a Prisma validation error includes the call's arguments.

**Counsel must confirm** (no legal conclusions here; the spec notes this is sensitive data under state laws including Maryland's):
1. Whether optional race or ethnicity, and possibly gender and income, collected with consent on a public page, is allowed for this purpose under Maryland's law and the other states', and what consent wording is needed.
2. Whether respondents under 18 (the "Under 25" band) need an age gate or must be excluded.
3. Whether ZIP3 plus the other fields is de-identified enough, or ZIP should not be stored.
4. Whether deletion limited to "device key or receipt" meets deletion-on-request duties for data Verdict cannot link to a person.
5. Whether the database operators' access to raw rows needs further controls.
6. Whether keeping a check-in email in the same database as that response's demographics changes the analysis.
7. Retention periods.
8. Whether the "How Verdict uses demographics" page's commitments (aggregate-only, no sale, deletion) are met by this design.

### D12. Survey abuse controls and the check-in opt-in
**Abuse controls:**
- **Per IP:** `SURVEY_RATE_LIMIT_MAX` (default 10 per hour) on POST and DELETE, keyed by `req.ip` (`TRUST_PROXY`). It is in memory, so per process (a known gap, CLAUDE.md).
- **Form token:** `HMAC(SURVEY_TOKEN_SECRET, templateId|issuedAt)`, from the GET. POST refuses a token younger than 15 s or older than 24 h. A hidden honeypot field must be empty. `SURVEY_TOKEN_SECRET` is a new env var, required in production.
- **Database circuit breaker:** responses to a node beyond `SURVEY_NODE_HOURLY_MAX` (default 100) in the trailing hour are stored with `quarantined = true` and left out of every aggregate until an admin releases or deletes them.
- **Duplicates:** a retried request with the same `clientSubmissionId` is a no-op 200. The same device and product replaces (D10).
- **No PII beyond what is asked:** no name, no IP or user agent stored, no `userId`. Free text is shown to admins without demographics.

**Check-in opt-in (thank-you screen):**
- It is a separate call after the response is stored, so the response row never holds the email.
- `survey_check_ins` holds:
  - `responseId` (unique, cascade);
  - `email` (normalised with `normalizeEmail`) and `emailHash`;
  - `consentText` (the exact wording shown) and `consentAt`;
  - `confirmTokenHash` and `confirmedAt`;
  - `sendAfter` (+6 months);
  - `status` and `sentAt`.
- It is double opt-in: a confirmation email with a selector-and-verifier link, the same token scheme as `docs/adr-email-verification.md`. It has its own per-address slot (`EmailRateKind.SURVEY_CHECKIN_EMAIL`, one per address per hour) so that nobody can make Verdict mail a stranger.
- **Sending:**
  - Unconfirmed rows are never sent.
  - Sends use the nudge provider, unsubscribe signing (`UNSUBSCRIBE_SECRET`) and `List-Unsubscribe`, with idempotency key `survey-checkin/<id>`. Delivery is at least once, as for nudges.
  - Real sending waits for legal review (backlog #4), like nudges.
- **Afterwards:** the address is nulled 30 days after sending or cancelling, and `emailHash` is kept to honour unsubscribes.

### D13. Worked example: Carry-on (Travel → Luggage → Carry-on)
**Lever list** (18 approved products, so the gate needs `accepted × 5 ≥ 72`, that is ≥ 15 of 18):

| Rank | Lever (definition type) | Badges | Accepted known | Gate |
| --- | --- | --- | --- | --- |
| 1 | Fits the sizer, wheels included (MEASUREMENT, DIMENSIONS) | FIT, SPEC | 16 / 18 (11 stated with wheels) | pass |
| 2 | Wheels roll straight (RATING_ONLY) | EXPERIENCE | n/a | exempt: "No owner data yet" until 5 ratings |
| 3 | Holds up to wear (RATING_ONLY) | EXPERIENCE | n/a | exempt |
| 4 | Empty weight (MEASUREMENT, lb) | SPEC, FIT | 17 / 18 | pass |
| 5 | Warranty covers airline damage (BOOLEAN) | SPEC, EXPERIENCE | 13 / 18 | **fail** |
| 6 | Handle stays steady (RATING_ONLY) | EXPERIENCE | n/a | not featured |
| 7 | Hardside or softside (RATING_ONLY as requested; Q17) | TRADE_OFF | n/a | not featured |
| 8 | Expansion that stays legal (MEASUREMENT, DIMENSIONS, expanded) | SPEC, FIT | 9 / 18 | not gated |
| 9 | Front or laptop pocket (BOOLEAN) | SPEC, TRADE_OFF | 15 / 18 | not gated |
| 10 | Replaceable parts (COMPATIBILITY_LIST: wheels, handle, zippers) | SPEC, EXPERIENCE | 8 / 18 | not gated |
| 11 | Capacity (MEASUREMENT, L converted to cu ft) | SPEC | 16 / 18 | not gated |
| 12 | USB port and battery pocket (BOOLEAN) | SPEC | 14 / 18 | not gated |

**Gate outcome:** publish is refused with "Warranty covers airline damage: 13 of 18 (72%)". Warranty terms usually sit on a separate warranty page that EXTRACT never fetches. The admin can either:
- add two manual values quoting the brands' warranty pages on their verified domains (A4), making it 15 / 18 and the publish passes; or
- move the lever to rank 6. Handle stays steady (Experience, exempt) then becomes featured and the publish passes.

**Fit rules:**
- Rank 1: `{ answerKey: "airlines_flown", answerField: "sizerIn", comparator: "DIMS_WITHIN", quantifier: "ALL", requiresBasis: "WITH_WHEELS" }`. With United and Spirit chosen, a 22 × 14 × 9 in bag reads "Fits United; too big for Spirit (22 > 18 in)". Five of the 16 bags read "Unverified: size stated without wheels".
- Rank 4: `answerField: "weightLimitLb"`, `LTE`. It shows only when an airline flown has a weight limit.
- Rank 8 uses the same rule as rank 1, on the expanded size.

**Trade-offs:**
- Rank 7: `preferenceKey: "shell_preference"`, sides hard ("protects contents, wipes clean; shows scuffs") and soft ("squeezes into tight bins, outside pockets"). It has no `match` because it has no SPEC, so it is advice only.
- Rank 9: `preferenceKey: "laptop_rides"`, `match: { valueBool: true }` for the "front pocket" side.

**Dependencies:**

| questionKey | Kind | Answer type | Related node | Constrains |
| --- | --- | --- | --- | --- |
| `airlines_flown` | SITUATION | MULTI_CHOICE; options carry `sizerIn` and `weightLimitLb`, each with the airline's source URL | none | ranks 1, 4, 8 |
| `trips_per_month` | SITUATION | CHOICE (< 1, 1–2, 3+) | none | ranks 2, 3 |
| `trip_length` | SITUATION | CHOICE (overnight, 2–4 nights, 5+) | none | ranks 8, 11 |
| `laptop_rides` | SITUATION | CHOICE (front pocket, personal item, no laptop) | none | rank 9 |
| `bag_on_handle` | PRODUCT | PRODUCT_REF | Personal item | rank 6 (a "Pack for a trip" project with both nodes chooses the personal item first) |
| `power_bank` | PRODUCT | BOOLEAN | none (no node; a question, no gate) | rank 12 |
| `shell_preference` | SITUATION | CHOICE (hard, soft, no preference) | none | rank 7 |

`shell_preference` is added because D4 needs a preference question; it is not in the requested list.

**Safety rule:**
- `authority: "FAA"`.
- `requirement`: "A bag with lithium batteries stays in the cabin unless the batteries are removed."
- `sourceUrl`: *to be filled at generation time from the FAA page, quote-verified by the fetcher (D7), and admin-approved*. No citation is invented here.
- `appliesWhen`: "The bag has a battery pocket and you carry a power bank; any carry-on can be checked or gate-checked."
- `condition`: `{ all: [ { lever: <USB port and battery pocket>, op: "not_false" }, { answer: "power_bank", op: "eq", value: true } ] }`.
  - With an unknown battery-pocket value the warning still triggers ("may apply").
  - Gate-checking is treated as always possible for a carry-on, so it needs no answer (Q18).

### D14. Failure modes
- **Two admins re-ranking:** the node lock plus `leverRankingVersion` lets one succeed and gives the other a 409 with a reload. Publish checks the same version, so it can never publish an order the admin did not see.
- **Partial publish:** one transaction, as today. A crash or an injected error leaves the previous published list, ranks, values, dependencies and rules untouched. The deferred trigger refuses any commit that leaves fewer than 5 approved levers or a gap in `publishedRank`.
- **A run writing during review:** the existing busy check (`publish.ts:65-78`). The LEVERS stage appends ranks under the node lock and bumps the version, so an open board gets a 409 rather than a silent reorder.
- **Old instances during deploy:**
  - The expand migration keeps `position` filled for already-published rows, so an old instance still reads them.
  - An old instance's publish fails at commit, because the new trigger needs `publishedRank`, and changes nothing.
  - Deploy as for cadence changes: stop the old instances, migrate, start the new ones.
- **Survey spam:** per-IP limit, form token and honeypot, then the database circuit breaker quarantines a flood instead of letting it into lever evidence. Quarantined rows are deletable in bulk.
- **Device storage lost:** saved answers are gone (the survey still works, with no prefill), and deletion needs the receipt code. Nothing on the server depends on the device copy.
- **Authority page unreachable or blocked:** the safety rule stays `UNVERIFIED`, publish refuses it while it is approved, and the admin attests or rejects it.
- **Check-in email path failure:** the response is already committed. A failure is logged as in account emails (`task`, `errorClass`, never the address) and the opt-in can be retried from the thank-you screen.

## Schema and migration plan
Each migration is applied with `prisma migrate deploy` only and stands alone. Raw SQL (CHECKs, triggers, partial indexes) is written by hand, as in the earlier catalog migrations, because `migrate diff` ignores it.

1. **`lever_badge_enums`** (enum changes only; nothing uses a new value in the same migration, as in `20261115000000_review_stage_two_weeks`):
   - `CREATE TYPE "LeverBadge"`;
   - `ALTER TYPE "LeverType" ADD VALUE 'RATING_ONLY'`;
   - `ALTER TYPE "EmailRateKind" ADD VALUE 'SURVEY_CHECKIN_EMAIL'`;
   - `CREATE TYPE "DimensionBasis" ('WITH_WHEELS','CASE_ONLY','UNSTATED')`.
2. **`lever_ranking`** (expand):
   - `taxonomy_nodes.leverRankingVersion INT NOT NULL DEFAULT 0`.
   - `lever_definitions`: `ownerRatable BOOL NOT NULL DEFAULT true`, `notRatableReason TEXT`.
   - `node_levers`: `rank INT`, `publishedRank INT`, `badges "LeverBadge"[] NOT NULL DEFAULT '{SPEC}'`, `fitRule JSONB`, `tradeOff JSONB`.
   - **Backfill, row by row:**
     - `APPROVED`: `rank = publishedRank = position`, and the snapshot gains badges (`published = published || '{"badges":["SPEC"]}'`).
     - `CANDIDATE`: `rank = (approved count) + row_number() OVER (PARTITION BY nodeId ORDER BY createdAt, id)`. The model's original order is not stored (`runs.ts:365`); the admin re-ranks before publish.
     - `RETIRED`: null.
     - Every existing lever gets badges `{SPEC}`, because all existing types have manufacturer values.
   - **Constraints:**
     - Drop `node_levers_position_iff_approved` and `node_levers_position_range` (`20261120000200…:107-110`); keep the column and its unique index for old readers.
     - Add CHECKs: rank and publishedRank ≥ 1; `publishedRank` non-null exactly when `APPROVED`; `RETIRED` has a null rank; badges are not empty; FIT implies SPEC and a `fitRule`; TRADE_OFF implies `tradeOff`.
     - Add the badge/type trigger (D2).
     - Replace `node_levers_check_approved_count` with the deferred `node_levers_check_ranks` (D1).
   - **Existing published nodes keep:** their `publishedAt`, their five `APPROVED` levers in the same order, their `published_lever_values` rows (unchanged) and their products' `listed`. They stay published and readable throughout; the migration runs in one transaction, so readers see the old or the new state, never a mix.
3. **`value_dimension_basis`** (if Q2 is accepted): `product_lever_values.dimensionBasis "DimensionBasis" NOT NULL DEFAULT 'UNSTATED'`, and the same on `published_lever_values`. Existing rows become `UNSTATED`, so their Fit checks read "Unverified" until re-extraction or review.
4. **`node_dependencies_safety_rules`:**
   - `node_dependencies`, `node_dependency_levers`, `safety_rules`, with indexes on `nodeId`;
   - CHECKs (approval needs who and when; `PRODUCT` ⇔ the kind allows `relatedNodeId`; https source);
   - the decision-node, same-node-lever and acyclic `PRODUCT`-edge triggers under `pg_advisory_xact_lock(hashtext('node_dependencies'))`.
   - No existing data.
5. **`travel_taxonomy`:** a data migration in the style of `launch_taxonomy`.
   - **Nodes (all unpublished):** `travel` (navigation, root), `luggage` (navigation, under travel), and the decision nodes `carry-on`, `checked-luggage` and `personal-item`.
   - **Search terms:** "carry-on", "cabin bag", "spinner"; "checked bag", "suitcase"; "personal item", "underseat bag".
   - **Conflicts:** unlike `launch_taxonomy` (`ON CONFLICT DO UPDATE`, `…/migration.sql:19-22`), it uses `ON CONFLICT (slug) DO NOTHING`, then `RAISE EXCEPTION` naming any slug whose existing kind or parent differs. An admin-made node is never silently turned into another kind.
   - It does not unpublish anything.
   - **Code:** `LAUNCH_ORDER` (`admin.ts:47`) puts `carry-on` first. The Seats secondary parent already comes from `launch_taxonomy` (:51-54).
6. **`owner_survey`:**
   - **Enums:** `SurveyTemplateStatus`, `SurveyLeverRole`, `BuyAgain`, `SurveySource`, `AgeBand`, `Gender`, `RaceEthnicity`, `Children`, `MaritalStatus`, `IncomeBand`, `LivesIn`, `CheckInStatus`.
   - **Tables:** `survey_templates`, `survey_template_levers`, `survey_responses`, `survey_lever_ratings`, `survey_importance_picks`, `survey_response_demographics`, `survey_check_ins`, `demographic_profiles`.
   - **Indexes:**
     - a partial unique index: one `ACTIVE` template per node;
     - unique `clientSubmissionId`;
     - a partial unique index on `(templateId, respondentKeyHash, productKey)`;
     - `(nodeId, submittedAt)` for the circuit breaker;
     - `survey_check_ins(status, sendAfter)`.
   - **CHECKs:** rating ranges; `PREFER_NOT` exclusive in `raceEthnicity`; `zip3 ~ '^[0-9]{3}$'`; product XOR Other text.
   - **Triggers:** ratings and picks only for the template's levers; a template's `RATED` levers are `ownerRatable`.
   - No foreign key to `review_threads`, `reviews` or `nudges`. No existing data; `survey_imports`/`survey_rankings` are untouched.
7. **`drop_node_lever_position`** (contract; the next release, once no code reads `position`): drop `node_levers.position` and `node_levers_nodeId_position_key`.

**Code changes (not migrations):**
- Add the new models and fields the publish and survey paths use to `REQUIRED_MODELS` (`backend/src/lib/prismaClientGuard.ts`, which already lists `SurveyRanking` at :48).
- Document the new env vars (`SURVEY_TOKEN_SECRET`, `SURVEY_RATE_LIMIT_MAX`, `SURVEY_NODE_HOURLY_MAX`) in `.env.example`, CLAUDE.md and `docs/api.md`.
- `safety_acknowledgements` is created by the Phase B projects migration (D7).

## Testing plan
Backend tests run on real Postgres. Pure functions are tested directly. Survey isolation also gets one ML test. UI: one browser pass, covering:
- the ranked board, Dependencies and Safety steps (desktop);
- the category page's featured panel, full list and Safety section (desktop and 390 px);
- the survey page (390 px, taps only).

| Rule | Test | Mutation that must fail it |
| --- | --- | --- |
| Rank integrity | Ranks stay 1..n through add, reorder, remove and retire; a direct SQL duplicate or gap fails at commit; a swap in one transaction passes | drop the deferred trigger; skip the shift on remove |
| Featured five and concurrency | Featured = rank ≤ 5; two reorders with the same `seen`: one 200, one 409; publish with a stale `seen` or a different set → 409 | skip the version check; compare sets without order |
| Badge integrity | FIT without SPEC or `fitRule`, SPEC on `RATING_ONLY`, EXPERIENCE on a not-owner-ratable lever, empty badges: each refused by the database | drop each CHECK or trigger branch |
| Badge-dependent gate | 18 products: featured SPEC lever 14/18 refused and named, 15/18 passes; featured Experience-only with no values passes; rank-6 SPEC at 0% passes; SPEC+EXPERIENCE featured is gated | gate every featured lever; gate none; use `rank ≤ 6`; skip multi-badge levers |
| Publish snapshot and atomicity | Injected failure leaves the previous public list and values; values of every SPEC lever published; a re-rank after publish changes no public read until republish; a removed published lever is retired by publish | read `rank` publicly; copy only featured values |
| Migration keeps published nodes | A node published with five levers before migration 2: same order, values readable, badges `["SPEC"]`; candidates ranked 6+; retired ranks null; still published | number candidates from 1; skip the snapshot backfill |
| Fit: unknown and unverified | No answer → `NOT_SHOWN`; unknown or unpublished value → `UNVERIFIED`; `CASE_ONLY`/`UNSTATED` with `requiresBasis` → `UNVERIFIED`; equal → `FITS`; +0.01 → `DOES_NOT_FIT`; `ALL` over two airlines; `CONTAINS` miss → `UNVERIFIED`; an `UNVERIFIED` product is not hidden by the filter | treat unknown as fits; ignore basis; `<` for `≤`; `ANY` for `ALL`; read `product_lever_values` |
| Trade-off never a hidden input | Permuting a Trade-off lever's values leaves the default category order and filters identical; `preferenceFor()` is null without an answer or with the neutral option; publish refuses a Trade-off without two sides or with an unknown `preferenceKey`; `match` without SPEC refused | default to the first side; sort by the Trade-off value |
| Dependency gate ordering | A `PRODUCT` cycle (direct and indirect) → 400 and a trigger error, and two concurrent edges cannot form one; `gateOrder([stroller, infant seat])` puts the seat first with the reason; a constrained lever not on the node is refused | drop the trigger or its lock; reverse the order |
| Safety condition fails closed | Triggers with battery pocket true or unknown plus `power_bank` true; not with pocket false; not with no answer (but listed on the category page) | treat unknown as false |
| Safety warning not dismissed silently (Phase B) | No ack → warning blocks the milestone; ack records user, time and rule hash; a republished rule or changed answers trigger it again | key the ack on rule id only; skip `answersHash` |
| Safety source | Approving or publishing a rule with `UNVERIFIED` source → refused; a non-authority host → refused; a paraphrased quote → `UNVERIFIED` | skip the host check; accept unverified at publish |
| Survey never reaches reviews | A submission (prefilled product) creates no `review_threads`, `reviews` or `nudges` rows and changes no `driftScore`, `avgRating*` or `totalReviewCount`; ML: the loader's SQL references none of the `survey_`/`demographic_` tables | create a thread for the prefilled product; add a survey join to the loader |
| Demographics access control | No public, user or admin response body contains a raw demographic row (all survey and admin routes); a non-admin gets 403 on aggregates | return the snapshot in the admin survey view |
| Minimum cell size | A cell of 9 → "fewer than 10", 10 shown; with one suppressed cell, the next smallest is suppressed too; owner score hidden at n = 4, shown at 5; quarantined rows excluded | `<` for `≤`; drop complementary suppression; include quarantined |
| Deletion on request | Delete by `respondentKey` removes every response from the device, with ratings, picks, demographics and check-in, and aggregates drop; delete by receipt removes one; an unknown key gets the same 204; profile delete | drop the cascade on demographics; answer 404 for unknown |
| Logging | A survey POST failing zod and one failing in Prisma: captured logs contain no submitted value | log `req.body` or `err` |
| Public survey route | 429 after `SURVEY_RATE_LIMIT_MAX`; prefill from another node, not in the catalog or dry run → ignored (question 1 shown); POST with a product from another node → 400; >3 picks, a pick outside the candidates, a rating outside the five, an unknown key, a fresh token, a filled honeypot → 400; the same `clientSubmissionId` twice → one row; the same device and product → replaced | drop the node check on prefill; remove `.strict()`; skip the token age |
| Not owner-ratable never surveyed | Activating a template whose rated five include a not-owner-ratable lever (crash protection) → refused | drop the activation check |
| Check-in consent | No send without `confirmedAt`; consent text stored; a second address request within the hour → 429; the address is nulled 30 days after sending | send unconfirmed rows |
| Travel taxonomy migration | Creates the five nodes; an existing `luggage` decision node makes the migration raise with the slug | `DO UPDATE` on conflict |

## Out of scope
- Projects: `ProjectTemplate`, `UserProject`, the roadmap UI, purchase recording, and the `safety_acknowledgements` table itself (Phase B). Only the answer contract, `gateOrder` and the ack design are here.
- Ranking: Top Rated, Best Fit and their weights (Phase C). This design only constrains its inputs (D4, D11).
- `ReviewLeverRating` and per-category check-ins (spec, Review cycle).
- Run-time reading of blogs, forums and expert reviews, the AI retro interview, "ask the owners", review imports, licensed sources and review synthesis (counsel sign-off pending).
- Purchase interface and price comparison. Airline data refresh automation.
- Demand-driven categories; Kids furniture; bundles.

## Open questions
1. **The recommender already uses demographics** (`recommender.py:43-50,286-288`, `recommendations.ts:31-41`), which contradicts "never a ranking input until the Best Fit ADR". **Recommended default:** before the "How Verdict uses demographics" page goes live, set the recommender's demographic weight to 0 and stop sending `UserDemographics` to `/recommend`; the Best Fit ADR decides what comes back. Alternative: keep it, and scope the page's commitments to survey answers only.
2. **Dimension basis.** **Recommended default:** `dimensionBasis` (`WITH_WHEELS`, `CASE_ONLY`, `UNSTATED`) on values. It is extracted only when the quote states it ("including wheels and handles"), otherwise `UNSTATED`, and Fit checks needing wheels show "Unverified". Alternative: assume the stated size includes wheels (wrong for many brands).
3. **Several verified hosts per brand** already work: `host` is unique and `brandKey` is only indexed (`schema.prisma:998-1010`; `adr-generation-run.md` A1). The remaining gap is that one host cannot belong to two brands (a parent company's shared site). **Recommended default:** leave it until a launch node hits it. Alternative: a `brand_domain_brands` join table now.
4. **List price.** **Recommended default:** a `product_prices` row per product (amount, currency, source URL on a verified brand host, verbatim quote, `observedAt`, status). It is shown as "List price $X on brand.com, checked <date>", is not a lever, never ranks, and is re-checked on republish. Alternative: a MEASUREMENT lever with a USD unit (no date, and it would count toward coverage).
5. **Structured warranty.** **Recommended default:** three shared definitions (term in years, airline damage covered (boolean), registration required (boolean)), with only the airline-damage one in the Carry-on list. No schema change. Alternative: a composite warranty type.
6. **Evidence weighted by time owned.** **Recommended default:** store the ownership band, show owner scores split by band ("< 3 months", "3–12 months", "1 year +"), and leave weighting to the Phase C ADR. Alternative: weight now with the stage weights (0.6 to 1.0).
7. **Source-quality filter for run-time reading.** **Recommended default:** design it with run-time reading, after counsel sign-off. It would be a coded allow/deny list of source domains plus a quality class stored with each citation; nothing is stored now. Alternative: specify the classes here.
8. **Experience ratings before `ReviewLeverRating`.** **Recommended default:** survey ratings only, labelled, n ≥ 5; review ratings arrive with their own ADR and are shown separately. Alternative: show nothing until reviews carry lever ratings.
9. **Travel and Luggage nodes.** **Recommended default:** a `travel_taxonomy` migration (Schema, step 5), as for `launch_taxonomy`; the Seats secondary parent already exists. Alternative: create them in the admin UI (then every environment differs).
10. **The survey lists approved but unpublished product names** before publish (step 6 precedes step 7). That is an exception to "a discovered product is public only once a publish lists it" (`products.ts:16-18`). **Recommended default:** allow brand and model names only, with no link and no values. Alternative: run surveys only on published nodes (no owner evidence before the first publish).
11. **Five income bands:** the spec does not give boundaries, and the existing enum has six. **Recommended default:** under $50k, $50–100k, $100–150k, $150–200k, $200k+. Alternative: Census quintile boundaries.
12. **ZIP storage.** **Recommended default:** the device keeps 5 digits for prefill; the server stores only the first 3. Alternative: store all 5 (re-identification risk combined with the other fields).
13. **Thresholds.** **Recommended default:** demographic cells ≥ 10; owner scores ≥ 5 respondents. Alternative: 5 for both (matches Best Fit's starting N, weaker protection).
14. **Featured levers without SPEC.** **Recommended default:** no extra rule; the board warns when fewer than 3 featured levers carry SPEC. Alternative: require at least 3.
15. **Does a Fit lever's coverage count values without the required basis?** **Recommended default:** yes. The gate counts accepted known values, and the card shows how many state the basis. Alternative: count only `WITH_WHEELS` values.
16. **ML database access.** **Recommended default:** before the public survey launches, give the ML service its own read-only role (`ML_DATABASE_URL`) with no grant on `survey_*`, `demographic_profiles` or `survey_response_demographics`. This is an ops and env change, not a migration. Alternative: isolation by code only, as now.
17. **"Hardside or softside" has no SPEC** in the requested badges, so a preference cannot select products. **Recommended default:** add SPEC (CATEGORY: hardside, softside, hybrid). Alternative: keep it advice only.
18. **The FAA rule's "may be checked or gate-checked"** has no question in the requested dependencies. **Recommended default:** treat every carry-on as possibly gate-checked (no question). Alternative: add a `may_be_checked` situation question.
19. **Minimum respondent age.** **Recommended default:** a "16 or older" statement and checkbox before submission, pending counsel (D11, item 2). Alternative: no gate.
