# ADR: Lever badges, dependencies, safety rules and the owner survey
Status: proposed. Spec sections: "Product taxonomy" (Luggage goes first), "Reviews half: search, value levers, product pages" (badges, featured-five panel, Dependencies and How to shop, Safety, Price), "Lever generation and review synthesis" (steps 2, 6, 7, Publish gate, Owner evidence sources), "Owner baseline survey", "Ranking: Top Rated and Best Fit", "Projects" (Multi-product projects), "Review cycle", "Data model, phasing and open decisions".

## Context
What exists (builds on `docs/adr-generation-run.md`, whose section 5 stays in force):

- **Five levers, fixed.** `NodeLever.position` is 1–5 and set exactly when `APPROVED` (`backend/prisma/schema.prisma:696`, `@@unique([nodeId, position])` at :715; CHECKs in `backend/prisma/migrations/20261120000200_lever_definitions/migration.sql:107-112`). A deferred trigger allows 0 or 5 approved levers per node (same file :196-220). `LEVERS_PER_NODE = 5` (`backend/src/catalog/publish.ts:15`). Publish takes exactly five ids (:56-58), gates every one (:94-104), snapshots only those five (:123-125) and copies only their values (:135-149). `leversPerNode` goes to the admin UI (`backend/src/routes/admin.ts:54`). The PR #13 board has five slots (`frontend/src/components/levers/PublishBoard.tsx:1,9`). The review page hardcodes 5 (`frontend/src/pages/admin/AdminReviewPage.tsx:55,417`). Public reads order `APPROVED` levers by `position` (`backend/src/catalog/public.ts:29-39`), and the category page has five filter columns (`frontend/src/pages/CategoryPage.tsx:118,125`). A published lever cannot be retired on its own (`backend/src/catalog/levers.ts:139`).
- **No badges, dependencies or safety rules.** A lever has a type (`schema.prisma:453-458`) and a `safety` flag (:698). The LEVERS stage gets only the definitions and the reference levers (`backend/src/generation/runs.ts:318-321`), returns only candidates (`backend/src/generation/schemas.ts:77-79`), and stores only counts (`runs.ts:365`).
- **The survey is a CSV of rankings.** `SurveyImport`/`SurveyRanking` (`schema.prisma:761-787`) hold an admin-uploaded `lever, rank, respondents` file (`backend/src/catalog/survey.ts:50-73`), which the board matches to cards by name (`admin.ts:253,261,286`). There are no responses and no public route.
- **Demographics today.** `UserDemographics` (`schema.prisma:70-87`) belongs to accounts and does not match the spec's topics:
  - ages start at `AGE_18_24` (:349-356);
  - income has six bands (:358-365);
  - gender is free text;
  - it stores a region instead of a ZIP;
  - it stores education and lifestyle tags, which the spec never asks for.
  
  It is written by `PUT /api/users/me/demographics` (`backend/src/routes/users.ts:59-69`). It is returned by `/auth/me` (`backend/src/routes/auth.ts:243`), whose user object the frontend persists in `localStorage["verdict-auth"]`. The ML recommender also uses it per user, with 30% of the similarity weight (`ml/models/recommender.py:43-50,103,286-288`; `backend/src/routes/recommendations.ts:31-41`).

  **This conflicts with the spec.** The spec commits to aggregate-only use of demographics (spec :238), but the recommender already uses each user's demographics. Best Fit later lists demographics as an input too (spec :252). This ADR proposes that new survey demographics are never per-user inputs; the recommender's existing use is open question 1.
- **The ML service** connects with the backend's `DATABASE_URL` (CLAUDE.md, Architecture), so it can read every table added here. Its only query reads `reviews`, `review_threads` and `user_demographics` (`recommender.py:89-106`).
- **Luggage is missing.** `launch_taxonomy` creates only Baby and Kids and Seats (`backend/prisma/migrations/20261120000100_launch_taxonomy/migration.sql:26-54`), and `LAUNCH_ORDER` starts with Infant car seats (`admin.ts:47`). The spec puts Carry-on first.
- **Projects do not exist** (spec Phase B). This design defines only what Fit checks, gates and safety warnings need from a project: a typed answer contract (D6).

## Decisions

### D1. One ranked lever list per decision node; ranks 1–5 are the featured five
- **`NodeLever.rank Int?`** is the admin's working order.
  - Ranks run 1..n with no gaps. "Featured" means rank ≤ 5; it is computed, not stored.
  - CHECKs: a `CANDIDATE` lever has a rank, and a `RETIRED` lever has none.
  - An `APPROVED` lever may have a null rank: the admin has removed it, and the next publish retires it (D5).
  - This is the spec's "one lever list; the top five appear in their own panel".
- **`NodeLever.publishedRank Int?`** is the public order. Only publish writes it, so re-ranking changes nothing public until the next publish (the snapshot rule of `adr-generation-run.md` D10). A CHECK makes it non-null exactly when `APPROVED`.
- **Integrity, `node_levers_check_ranks`.** This deferred constraint trigger replaces the 0-or-5 trigger. At commit it checks that:
  - the node's non-null ranks are exactly 1..n;
  - its `APPROVED` levers number 0 or at least 5, with `publishedRank` exactly 1..k.
  
  Because it is deferred, a transaction can swap ranks. Prisma cannot declare a deferrable unique constraint, so this is hand-written SQL.
- **Concurrency.** Two layers:
  - **Database.** Both the existing `node_levers_before_write` trigger and the deferred check first take `pg_advisory_xact_lock(hashtext('node_levers:' || nodeId))`. Each check statement runs after the lock, so in READ COMMITTED it sees the other transaction's committed rows, and two concurrent appends of rank n+1 cannot both commit.
  - **API.** `TaxonomyNode.leverRankingVersion` goes up on every reorder, add, remove or retire. `PUT /api/admin/nodes/:id/lever-ranking { order, seen }` locks the node (`lockNode`) and answers 409 on a stale `seen`, as value decisions already do.
- New candidates from a later run are appended (n+1…) in the model's order.
- Rejected: keeping `position` 1–5 plus a separate "more levers" list. The spec has one list.

### D2. Badges are a set on `NodeLever`; each badge has a meaning in data
`NodeLever.badges LeverBadge[]`, with `LeverBadge { SPEC, EXPERIENCE, FIT, TRADE_OFF }`. A lever has at least one badge.

| Badge | Requires | Enforced by |
| --- | --- | --- |
| SPEC | the definition is not the new `LeverType.RATING_ONLY` | triggers (below) |
| EXPERIENCE | the definition's `ownerRatable` is true | triggers |
| FIT | SPEC, plus a `fitRule` (D3) | CHECK; publish validates the rule |
| TRADE_OFF | a `tradeOff` (D4) | CHECK; publish validates it |

- **`LeverType.RATING_ONLY`.** A lever with no manufacturer value that owners rate, such as "Wheels roll straight".
  - CHECK: no unit and no allowed values.
  - It has no category-page filter.
  - A trigger refuses `product_lever_values` and `published_lever_values` rows for it.
  - It is needed because every definition must have a type (`schema.prisma:663`). Making `type` nullable instead would break every reader of it.
- **`LeverDefinition.ownerRatable Boolean?`** (null means not decided) and `notRatableReason`.
  - EXPERIENCE badges and survey `RATED` levers need `true`.
  - The LEVERS stage sets it, except for safety-flagged definitions, which stay null until an admin decides. Spec: "Car seat surveys never ask owners to rate crash protection".
- **Triggers that keep this true when a definition is edited.** A `lever_definitions` BEFORE UPDATE trigger refuses:
  - a change to `RATING_ONLY` while any node lever with this definition has SPEC, or while the definition has values;
  - `ownerRatable` leaving `true` while any node lever has EXPERIENCE, or any DRAFT or ACTIVE template rates it;
  - `safetyFlag` becoming true while `ownerRatable` stays true, unless the same update sets it explicitly.
  
  The `node_levers` and `survey_template_levers` triggers check the same rules from their side.
- **Safety** keeps today's rules. `NodeLever.safety` is derived (`20261120000200_lever_definitions/migration.sql:125-142`), and safety values are accepted one by one (`product_lever_values_no_bulk_safety`, `20261120000300_lever_values_v2/migration.sql:140-161`). D7 adds levers referenced by safety rules.
- **Experience score.** "No owner data yet" (spec :74) until the score passes its threshold (D12); the source is survey ratings (D10), labelled. `ReviewLeverRating` is shown separately when it exists (Q8).

### D3. A Fit check is a typed comparison against a named project answer
`NodeLever.fitRule Json` is zod-validated on write and at publish:
```
{ answerKey,                      // a question of an approved dependency of this node (D6)
  answerField | null,             // a fact of the chosen option (D6), or the answer itself
  operand: "ANSWER" | { relatedLever: definitionId } | { relatedProduct: "BRAND_MODEL" },
  comparator: "LTE" | "GTE" | "DIMS_WITHIN" | "LINEAR_SUM_LTE" | "ALLOWANCE" | "CONTAINS",
  quantifier: "ALL" | "ANY",      // multi-select answers
  requiresBasis: "WITH_WHEELS" | null }
```
**How values are compared.** Facts and answers are stored as stated, with their unit, and both sides are converted through `catalog/units.ts`.

| Comparator | Meaning |
| --- | --- |
| `LTE`, `GTE` | plain comparison; equality fits |
| `DIMS_WITHIN` | compares the dimensions sorted largest first, because pages list L, W and H in no fixed order |
| `LINEAR_SUM_LTE` | for limits stated as length + width + height |
| `ALLOWANCE` | for like-for-unlike limits, such as an empty bag against a packed-weight limit. It never says FITS: it gives DOES_NOT_FIT when the value alone exceeds the limit, else "leaves X lb for your things" |
| `CONTAINS` with `{ relatedProduct }` | this product's compatibility list contains the chosen related product's `normalizeName(brand + " " + model)` |

**Result** (`evaluateFit()`, a pure function in `catalog/fit.ts`):
- **`NOT_SHOWN`:** no answer, or the chosen option has no such fact (spec: "shown only when the answer exists").
- **`FITS` / `DOES_NOT_FIT`:** the product's **published** known value. Admin-attested values keep their label.
- **`UNVERIFIED`, with a reason,** when:
  - the value is unknown or unpublished;
  - its `dimensionBasis` misses `requiresBasis` (Q2);
  - the option fact is not verified, or was checked more than 12 months ago (D6);
  - the related product is "other" text;
  - a `CONTAINS` check misses. A missing entry does not prove incompatibility.

**Filtering.** A Fit filter is off until the user turns it on. It hides only `DOES_NOT_FIT` products and says how many it hid; `UNVERIFIED` products stay, with their label.

**Derived operands** (the spec's "31 in of headroom" is ceiling − bed height − mattress) are not supported; see Q20.

Rejected: free-text rules interpreted by the model at read time. They cannot be tested and are not deterministic.

### D4. A Trade-off lever enters ranking only through the buyer's stated preference
`NodeLever.tradeOff Json` is `{ preferenceKey, sides: [two × { key, label, why ≤ 200, match? }], neutralOption }`. `preferenceKey` is a CHOICE question of an approved dependency.

- **The card** reads "Depends on you" and explains both sides (spec :72).
- **`match`** maps published values to a side (`{ valueText: [...] }` or `{ valueBool }`). It is allowed only with SPEC. Without SPEC, the lever is advice only.
- **Rule (spec Ranking rule 3).** The lever affects order or filters only when the user's own preference answer exists and is not neutral.
  - That answer is a project answer, which the user can see and edit.
  - There is no default side, and no side inferred from similar people, demographics or popularity.
  - Top Rated never reads it.
  - Until Phase C, the category page's default order and filters never depend on it (`public.ts:227` sorts by name).
- Rejected: a "majority preference" default. That would be a hidden input.

### D5. Publish takes the whole list; the 80% gate applies to featured levers with SPEC
`POST /api/admin/nodes/:id/publish { order, seen }`. `order` is every ranked lever in rank order, and `seen` is `leverRankingVersion`. It replaces `{ leverIds: [5] }` (`publish.ts:47,56`).

**Checks**, in the existing locked transaction (`publish.ts:60-61`):
1. `order` equals the node's ranked list, in the same order, and `seen` is current; otherwise 409. There are at least 5 levers.
2. The existing busy-run, minimum-products and dry-run checks stay (`publish.ts:65-92`).
3. Each lever is valid:
   - it has at least one badge;
   - category allowed values: the existing rule (:83-84);
   - `fitRule` and `tradeOff` reference approved questions of this node.
4. **The gate:** every lever with rank ≤ 5 **and** SPEC meets `meetsGate` (`publish.ts:17`, unchanged).
   - Featured levers without SPEC are exempt.
   - Levers ranked 6 and below are not gated: a missing value shows "Unknown", which satisfies the spec's "a value (or an explicit unknown)".
   - The 400 names each failing lever.
5. Every approved safety rule has a `VERIFIED` or `ADMIN_ATTESTED` source (D7).

**Writes:**
- Ranked levers become `APPROVED` with `publishedRank = rank`. Their snapshot gains `badges`, `fitRule`, `tradeOff` and `ownerRatable`.
- `approvedById/At` behave as today (`publish.ts:121-122`): kept while the lever stays published, and reset when it is republished after an unpublish.
- `APPROVED` levers with a null rank become `RETIRED`. That is how a published lever is removed, replacing `levers.ts:139`.
- Accepted values of **every SPEC lever in the list** are copied to `published_lever_values`.
- Approved dependencies, option facts and safety rules get a `published` snapshot; every other one has it cleared.
- **Unpublish** (`publish.ts:163-173`) also clears `publishedRank` and those snapshots, and keeps `rank`.

**Reads and UI:**
- `publicLevers` returns the full list by `publishedRank`, with badges and a `featured` flag.
- The category page puts featured SPEC levers at the top as filters, shows the other featured levers as cards, and adds a "Full list" panel.
- A snapshot without `badges` parses as `["SPEC"]`.
- In code, `LEVERS_PER_NODE` becomes `FEATURED_LEVERS = 5` and `MIN_PUBLISHED_LEVERS = 5`.
- The PR #13 board becomes one sortable list with a "Featured" divider. It keeps its keyboard and live-region behaviour and gains badge toggles and the Fit and Trade-off editors.

Rejected: publishing only the featured five. The spec's panel opens the full list.

### D6. `NodeDependency` and the project answer contract
**`node_dependencies`:**
- `nodeId`; `kind` (`SITUATION`/`PRODUCT`); `questionKey` (`^[a-z][a-z0-9_]{1,40}$`, unique per node); `prompt`;
- `answerType`: `CHOICE`, `MULTI_CHOICE`, `NUMBER` (with a unit), `DIMENSIONS`, `BOOLEAN` or `PRODUCT_REF`;
- `relatedNodeId`;
- `status` (`PROPOSED`/`APPROVED`/`REJECTED`), `proposedByRunId`, `approvedById/At`, `published`.

**CHECKs:**
- `relatedNodeId IS NULL OR kind = 'PRODUCT'`.
- A `PRODUCT` dependency with a null `relatedNodeId` (a power bank, which has no node) is a plain question.
- A decision needs who and when.

**`dependency_options`** (`dependencyId`, `key`, `label`, `position`).

**`dependency_option_facts`:** typed facts on an option, such as Airline A's sizer.
- `optionId`, `field`;
- `statedValue`, `unit`, and the converted value;
- `sourceUrl` (https), `sourceQuote`;
- `sourceCheck` (`VERIFIED` / `ADMIN_ATTESTED` / `UNVERIFIED`), `checkedAt`, `checkedById?`.
- **How a fact is checked.**
  - It is verified like a value: the quote must be verbatim in a fresh fetch, and the number and unit must be in the quote (`generation/evidence.ts`).
  - A blocked fetch makes it admin-attested.
  - Fit shows "checked <date>" next to the result, and treats a fact checked more than 12 months ago as `UNVERIFIED`. A "Re-check" button refetches it.
- **Fetch permit.** Facts are fetched under a new permit class, "fact source": hosts in `fact_source_hosts` (host, `approvedById/At`), added only by an admin with one click, like Confirm brand domain. The denylist, robots.txt, rate limit and no-bypass rules are unchanged.

**`node_dependency_levers`** (`dependencyId`, `definitionId`) lists the levers it constrains; each must be a live lever of the same node (trigger).
- **"Constrains" alone is display-only.** It explains why the lever matters and may reorder the How to shop view.
- Only a constrained lever with a Fit rule filters or labels products.

**Triggers:**
- the node and the related node are different decision nodes;
- **no cycles in `PRODUCT` edges**, a recursive walk under `pg_advisory_xact_lock(hashtext('node_dependencies'))`, like the taxonomy trigger. An API pre-check gives a readable 400.

**Answer contract** (`catalog/answers.ts`; all Phase B needs):
- `answerSchemaFor(published)` is a zod schema keyed by `questionKey`. Answers to questions removed by a republish are ignored, not deleted.
- `PRODUCT_REF` is `{ productId }` (a listed product of the related node), `{ other: text }` or `"none"`.

**Gates (spec, Multi-product projects):**
- `gateOrder(nodeIds)` returns a topological order of the project's nodes.
- A `PRODUCT` dependency **gates** (blocks the dependent node until the related product is chosen, and says why) only when one of its constrained levers has a Fit rule with a `relatedLever` or `relatedProduct` operand. Otherwise it is an ordered question.
- A single-node project gets the gate as a question ("Which infant car seat do you have or plan to buy?").

Rejected: dependencies as prose. They cannot be checked or turned into questions.

### D7. `SafetyRule`: a category-page section and acknowledgements in projects
**`safety_rules`:**
- `nodeId`, `requirement` (≤ 300 chars);
- `authority`, `sourceUrl`, `sourceQuote`;
- `sourceCheck` (as for option facts), `checkedAt`;
- `appliesWhen` (≤ 200), `condition`, `warningText` (≤ 300);
- `status`, `proposedByRunId`, `approvedById/At`, `published`.

**Source.** `sourceUrl` must be on a coded list of authority hosts (faa.gov, tsa.gov, cpsc.gov, nhtsa.gov, …), fetched under a new "authority page" permit with every other fetcher rule unchanged. This is a data-sourcing change, hence the gate.

**Condition** `{ all|any: [ { answer, op, value } | { lever: definitionId, op, value } ] }`, evaluated by the pure function `evaluateSafety()`:
- Each predicate is TRUE, FALSE or UNKNOWN. UNKNOWN covers an unanswered question and an unknown or unpublished value. They combine with three-valued logic.
- TRUE shows the warning. UNKNOWN shows it as "may apply" and names the missing answer or value. FALSE hides it in the project.
- The category page always lists every published rule (requirement, source link, "applies when"), with or without a project.

**Lever values a rule reads get individual review.** `safety_rule_levers` (`ruleId`, `definitionId`) is written with the condition in the same transaction, and publish checks that the two match. While a rule that references a lever is `APPROVED`, a trigger sets `node_levers.safety` on that node. `node_levers_before_write` also ORs in that check. So the lever's values cannot be bulk-accepted; a wrongly bulk-accepted "no" could otherwise silence the warning. The flag stays set afterwards, as the existing safety triggers never clear it.

**Projects** (Phase B creates the table): `safety_acknowledgements(id, userProjectId, userId, safetyRuleId, ruleSnapshotHash, answersHash, productId?, acknowledgedAt)`.
- A triggered or "may apply" warning blocks its milestone until the user answers the missing question or presses "I understand", which writes the row.
- A new rule version, or answers that change what the condition reads, trigger it again.
- An acknowledged warning collapses but stays in the project summary.
- **"Not silently" means** that no code path hides a triggered warning without that row. There is no dismiss-all.

Rejected: a dismiss flag. It records no rule version.

### D8. Generation run changes (spec step 2)
- **The LEVERS stage makes two calls.**
  1. Candidates, as today, plus `badges`, `ownerRatable` (with a reason), `fitRule?` and `tradeOff?`.
  2. Given the stored candidates: `dependencies[]` (≤ 8, with options and facts, each fact with a URL and a quote to look for) and `safetyRules[]` (≤ 6).
  
  Both are strictly validated; an unknown key or lever fails the stage with `validation_failed`. Two calls keep each answer well under `GENERATION_MAX_TOKENS`; an answer that is still too long stops with `max_tokens` (`runs.ts:132`), and Resume retries. A rerun does not duplicate candidates already on the node (`runs.ts:351-355`).
- **Ranks and status.** Candidates are appended in the model's order, and everything else is stored `PROPOSED`.
- **Source fetching.** The stage then fetches each safety source (authority permit) and each fact source already on `fact_source_hosts`, and runs the verbatim check. A miss is `UNVERIFIED`; the admin fixes it with a URL and pasted quote, as for manual values (`adr-generation-run.md` A4).
- **EXTRACT** asks only for SPEC levers.
- **Cost** is an estimate: about +$0.10 per node (`adr-generation-run.md` 5.6 prices), plus a few source fetches.
- **Review screen:** the Levers step gets the ranked board, and new **Dependencies** and **Safety** steps (Approve, Edit, Reject, source check, Re-check) record who and when.

### D9. Owner survey: templates and one public route per decision node
**`survey_templates`:**
- `nodeId`, `version`, `status` (`DRAFT`/`ACTIVE`/`CLOSED`);
- `brandOptions` (5–7, plus Other), `usageQuestion`, `nodeTopic`;
- `createdById`, `activatedById/At`.

**Template rules:**
- A partial unique index allows one `ACTIVE` template per node.
- A trigger makes a template with responses immutable; an edit creates the next version.

**`survey_template_levers`** (`templateId`, `definitionId`, `role` `RATED`/`IMPORTANCE`, `position`):
- exactly 5 `RATED`, each `ownerRatable = true` (trigger, plus a readable 400 at activation);
- 8–12 `IMPORTANCE`.

The rated five are pinned in the template, because the survey (step 6) runs before the featured five exist (step 7). By default they are the five highest-ranked ratable levers.

**Routes** (`routes/surveys.ts`):
- **`GET /api/surveys/:slug?product=<id>`** returns the active template:
  - the brands, and the node's `IN_CATALOG`, non-dry-run models (`backend/src/catalog/products.ts:10-13`);
  - the lever names and explanations;
  - a single-use form token (D12).
  
  A `product` that is not one of those models is ignored, and question 1 is shown; a shared link never errors. With no active template the route answers 404.
- **`POST /api/surveys/:slug/responses`** takes a strict zod body.
- **`DELETE /api/surveys/responses`** takes `{ respondentKey } | { receiptCode }` and always answers 204.
- **`POST /api/surveys/deletion-requests { email }`** and **`POST /api/surveys/responses/check-in`**: D11 and D12.
- **Admin:** draft from the current ranking, edit, activate, close; snapshots and quarantine (D11, D12).

`SurveyImport`/`SurveyRanking` stay as they are. They hold aggregates without respondents, so they are not migrated, and the board shows them as "Imported survey (CSV)".

### D10. Survey responses feed ratings and importance, and never reach reviews
**`survey_responses`:**
- `templateId`, `nodeId`;
- `productId?` (a product of the node) or `otherBrand` and `otherModel` (1–60 chars each). A response never creates a product.
- `ownedFor`, `usage`; `overall` (1–10); `buyAgain` (`YES`/`PROBABLY`/`NO`); `moreText?` (≤ 2000);
- `source` (`SURVEY_RETROSPECTIVE`); `clientSubmissionId` (unique);
- `respondentKeyHash?`, `receiptHash`;
- `followsResponseId?` (the 6-month check-in; `ON DELETE CASCADE`, so deleting a response deletes its follow-up);
- `quarantined`, `submittedAt`.

**Ratings and picks:**
- `survey_lever_ratings` (`responseId`, `definitionId`, 1–5) accepts only the template's `RATED` levers (trigger).
- `survey_importance_picks` accepts at most 3, only `IMPORTANCE` levers.

**Resubmission.** A partial unique index on `(nodeId, respondentKeyHash, COALESCE("productId", 'other:' || lower(btrim("otherBrand")) || '|' || lower(btrim("otherModel"))))` allows one response per device and product **per node**, so a new template version does not count a device twice.
- A resubmission **updates that row in place**: the id, the receipt and the check-in are kept, and the ratings, picks and demographics are replaced.
- A retry with the same `clientSubmissionId` is a no-op 200.

**Feeding levers** (spec acceptance for questions 4 and 5):
- **Owner scores** per lever come from snapshots (D11) of non-quarantined ratings. They are public by threshold (D12) and labelled "Owner survey (retrospective), n = …".
- **Importance** is the share of respondents who saw the lever and picked it. It appears on board cards and is evidence for the admin; it never re-ranks levers.

**Kept apart from reviews:**
- No foreign key to `review_threads`, `reviews` or `nudges`, and no survey code writes them.
- Drift, nudges, `avgRating*` and `totalReviewCount` are untouched.
- The ML loader reads none of the survey tables (`recommender.py:89-106`; Q16 removes its access).
- Survey data is never a ranking input: the spec ranks on reviews.

### D11. Demographics: storage, access, aggregates, deletion, retention, logging
**Storage.**
- **`survey_response_demographics`** (`responseId` primary key, cascade) holds one snapshot per response. Every column is nullable, and null means skipped.
  - `ageBand`: `UNDER_25`, `A25_34` … `A65_PLUS`, `PREFER_NOT`;
  - `gender`: `WOMAN`, `MAN`, `NON_BINARY`, `PREFER_NOT`;
  - `raceEthnicity RaceEthnicity[]`: the 2024 OMB categories including `MIDDLE_EASTERN_NORTH_AFRICAN`, plus `PREFER_NOT` (exclusive, CHECK). Counsel confirms the labels.
  - `zip3` (Q12); `children`; `marital`; `incomeBand` (`B1`–`B5`, `PREFER_NOT`; Q11); `livesIn`; `nodeTopic`.
- **`demographic_profiles`** (`userId` unique, cascade) has the same columns plus `nodeTopics`. It is used for prefill only, and is read only by `GET /api/users/me/demographic-profile`. It is never part of `/auth/me`, whose user object is persisted to `localStorage`.
- **`UserDemographics`** is frozen (its bands cannot be mapped) and gets a `DELETE /api/users/me/demographics` route. Its future is Q1.
- **Device copy.** `localStorage["verdict-survey"] = { version, respondentKey (uuid v4), receipts[], profile?, nodeTopics? }`. `profile` is kept only when "save for future surveys" is ticked. "Save to my account" is explicit, sends explicit fields, and then clears the device profile.
- **No account link.** Responses never get a `userId`, which keeps "No name needed" true. The spec's "until accounts exist" is read as "until the respondent signs in".

**Access and aggregates.**
- **Snapshots.** Admins and public pages see only `survey_aggregate_snapshots` (`nodeId`, `takenAt`, `payload`, `releasedById/At`).
  - The reconciler takes one nightly, and only when at least 10 new non-quarantined responses have arrived since the last one. So no one can compare aggregates before and after a single response.
  - Snapshots older than the newest two are deleted.
- **Reports.** One demographic dimension at a time per node, never crossed with another dimension, a product or free text.
- **Suppression.** A cell under **10** shows "fewer than 10", and the next smallest cell in the row is suppressed too.
- **Free text** is shown per snapshot, in random order, with no time.
- **`submittedAt`** is truncated to the day after 24 hours (the circuit breaker needs only the last hour).
- **No raw rows.** No route returns a raw row. For the tests, a raw row is any object carrying a `responseId` or `userId` together with a demographic field, or two or more demographic fields of one respondent.
- **Database access.** Raw rows are readable only with database credentials. An operator could link an account profile to a response through an identical answer set and close timestamps (counsel item 5; Q16).

**Ranking.** Survey demographics are never a ranking input. Account profiles are not one until the Best Fit ADR decides, and that ADR must reconcile per-user similarity with the aggregate-only commitment (spec :238, :252).

**Deletion on request.**
- **By device key** (every response from the device) or **by receipt** (one response). Ratings, picks, demographics, check-in and follow-ups cascade.
- **By email.** `POST /api/surveys/deletion-requests { email }` always answers 202. If a check-in row has that `emailHash`, a single-use link (the `adr-email-verification.md` token scheme, one per address per hour) is sent. Confirming it deletes those responses. Without a check-in, an email cannot find a response.
- **Profiles:** `DELETE /api/users/me/demographic-profile`.
- **Timing.** A deletion reaches aggregates at the next snapshot.
- **Logs and backups.** Logs hold no answers or addresses (below). Deleted rows remain in database backups until those expire; backup retention is an ops setting for counsel to confirm.
- **The "How Verdict uses demographics" page** must say that a lost device with no receipt and no check-in email cannot be matched.

**Retention.** A purge runs in the reconciler interval (`index.ts`):
- demographic snapshots and `moreText`: 24 months after submission;
- unconfirmed check-ins: 7 days;
- used form tokens: 24 hours.

Ratings and picks stay.

**Logging.** Answers and addresses are never logged.
- **Request log.** `morgan` (`backend/src/app.ts:38`) skips `/api/surveys`. That router writes its own line with the method, route pattern, status and duration, and no IP, user agent or query.
- **Body-parser errors.** `errorHandler` maps them (`entity.parse.failed`, `entity.too.large`, raised by `express.json()` at `app.ts:39`) to 400/413 and logs only the `type` and path. Today it logs the whole `err`, including `err.body` (`backend/src/middleware/errorHandler.ts:23`).
- **Other errors.** Survey routes catch their own and log only `errorClass` and the route.
- **Dry run.** The dry-run provider logs survey emails with `maskEmail`. The dev outbox stays in memory, in development and test only.

**Counsel must confirm** (no legal conclusions here; the spec notes this data is sensitive under state laws including Maryland's):
1. Collecting optional race or ethnicity, gender and income on a public page: consent wording and whether it is allowed.
2. Respondents under 18 (Q19).
3. ZIP3 combined with the other fields.
4. Deletion limited to a device key, receipt or check-in email.
5. Operator access to raw rows, including the profile-to-response linkage.
6. A check-in email stored next to that response's demographics.
7. Retention, including backups.
8. Whether the demographics page's commitments are met.

### D12. Survey abuse controls and the check-in opt-in
- **Per IP:** `SURVEY_RATE_LIMIT_MAX` (default 10 per hour) on the GET that mints tokens, on POST and on DELETE. It is in memory, so per process (CLAUDE.md, Known gaps).
- **Single-use form token.**
  - The GET stores `survey_form_tokens(nonceHash, templateId, issuedAt, usedAt)`.
  - The insert transaction consumes the token with a conditional `UPDATE … WHERE usedAt IS NULL AND issuedAt BETWEEN now() - 24 h AND now() - 15 s RETURNING`.
  - A hidden honeypot field must be empty.
  - `SURVEY_TOKEN_SECRET` is required in production.
- **Per respondent key:** at most 20 responses a day, counted in the database. The key is chosen by the client, so this stops only casual abuse.
- **Circuit breaker.** Inside the insert transaction, under `pg_advisory_xact_lock(hashtext('survey:' || nodeId))`:
  - a response beyond `SURVEY_NODE_HOURLY_MAX` (100) for the node, or `SURVEY_PRODUCT_HOURLY_MAX` (10) for the product, in the trailing hour is stored `quarantined`;
  - legitimate responses caught in a flood are released by the admin in bulk by time window;
  - the breaker never deletes.
- **Publication thresholds.**
  - Node-level lever scores are public at n ≥ 5.
  - Per-product survey scores are public only at n ≥ 20 **and** after an admin releases the snapshot.
- **Firewall residual risk (F1).** Someone with many IPs and patience can still submit plausible responses under every threshold. Survey data is never a ranking input and is labelled. Per-product scores need an admin release. Revisit F1 before any survey-derived number affects order.
- **No other data:** no name, IP, user agent or `userId` is stored.

**Check-in opt-in (thank-you screen).** It is a separate call, so the response row never holds the email.
- **`survey_check_ins`:**
  - `responseId` (unique, cascade);
  - `email` (normalised) and `emailHash`;
  - `consentText` and `consentAt`;
  - `confirmTokenHash` and `confirmedAt`;
  - `sendAfter` (+6 months), `status`, `sentAt`.
- **Double opt-in.** The confirmation link uses the email-verification token scheme. A per-address slot (`EmailRateKind.SURVEY_CHECKIN_EMAIL`, one per hour) applies. A request over the slot gets the same 202 and is skipped silently.
- **Sending.** Unconfirmed rows are never sent; they are purged after 7 days. Sends use the nudge provider, `UNSUBSCRIBE_SECRET` and `List-Unsubscribe`, with idempotency key `survey-checkin/<id>`, and wait for legal review (backlog #4).
- **Afterwards.** The address is nulled 30 days after the send or a cancel. `emailHash` stays, for unsubscribes and deletion by email.

### D13. Worked example: Carry-on (Travel → Luggage → Carry-on)
Airlines are fictional (Airline A, B, C); real figures are filled, quote-checked and dated at generation time.

**Lever list.** With 18 approved products, the gate needs ≥ 15 of 18.

| Rank | Lever (type) | Badges | Accepted known | Gate |
| --- | --- | --- | --- | --- |
| 1 | Fits the sizer, wheels included (MEASUREMENT, DIMENSIONS) | FIT, SPEC | 16 (11 stated with wheels) | pass |
| 2 | Wheels roll straight (RATING_ONLY) | EXPERIENCE | n/a | exempt, "No owner data yet" |
| 3 | Holds up to wear (RATING_ONLY) | EXPERIENCE | n/a | exempt |
| 4 | Empty weight (MEASUREMENT, lb) | SPEC, FIT | 17 | pass |
| 5 | Warranty covers airline damage (BOOLEAN) | SPEC, EXPERIENCE | 13 | **fail** |
| 6 | Handle stays steady (RATING_ONLY) | EXPERIENCE | n/a | not featured |
| 7 | Hardside or softside (RATING_ONLY, `ownerRatable` false until Q17) | TRADE_OFF | n/a | not featured |
| 8 | Expansion that stays legal (MEASUREMENT, DIMENSIONS) | SPEC, FIT | 9 | not gated |
| 9 | Front or laptop pocket (BOOLEAN) | SPEC, TRADE_OFF | 15 | not gated |
| 10 | Replaceable parts (COMPATIBILITY_LIST) | SPEC, EXPERIENCE | 8 | not gated |
| 11 | Capacity (MEASUREMENT, L → cu ft) | SPEC | 16 | not gated |
| 12 | USB port and battery pocket (BOOLEAN; safety via D7) | SPEC | 14 | not gated |

**Outcome.** Publish is refused: "Warranty covers airline damage: 13 of 18 (72%)". Warranty terms sit on pages EXTRACT does not fetch. The admin can either:
- add two manual values from the brands' warranty pages (A4); or
- move the lever to rank 6, which makes Handle stays steady featured (exempt).

**Fit rules:**
- **Rank 1:** `{ answerKey: "airlines_flown", answerField: "carryOnSize", comparator: "DIMS_WITHIN", quantifier: "ALL", requiresBasis: "WITH_WHEELS" }`.
  - With Airline A (22 × 14 × 9 in) and Airline B (55 × 35 × 20 cm, converted) chosen, a 22 × 14 × 9 in bag reads "Fits Airline A; too big for Airline B (22 > 21.65 in)".
  - Airline C states 45 linear in and uses `LINEAR_SUM_LTE` through a second fact field.
  - Five of the 16 bags read "Unverified: size stated without wheels".
- **Rank 4:** `ALLOWANCE` against `carryOnWeightLimit`: "leaves 9.4 lb under Airline B's 8 kg limit", or DOES_NOT_FIT if the empty bag alone is over. It never says "fits".
- **Rank 8:** as rank 1, on the expanded size.

**Trade-offs:**
- Rank 7 (`shell_preference`) is advice only, because it has no SPEC (Q17).
- Rank 9 (`laptop_rides`) has `match: { valueBool: true }` for "front pocket".

**Dependencies:**

| questionKey | Kind | Answer | Effect |
| --- | --- | --- | --- |
| `airlines_flown` | SITUATION | MULTI_CHOICE; option facts `carryOnSize`, `carryOnWeightLimit`, each quote-checked and dated | Fit on ranks 1, 4, 8 |
| `trips_per_month` | SITUATION | CHOICE | display-only (ranks 2, 3); also the check-in usage count |
| `trip_length` | SITUATION | CHOICE | display-only (ranks 8, 11) |
| `laptop_rides` | SITUATION | CHOICE | Trade-off preference for rank 9 |
| `shell_preference` | SITUATION | CHOICE (added: D4 needs it) | Trade-off preference for rank 7 |
| `bag_on_handle` | PRODUCT, related node Personal item | PRODUCT_REF | display-only (rank 6) and ordered first in a two-node project; no gate, because no Fit rule |
| `power_bank` | PRODUCT, no related node | BOOLEAN | read by the safety rule |

**Safety rule:**
- `authority` FAA.
- `requirement`: "Lithium batteries, including power banks, stay in the cabin. If the bag is checked or gate-checked, take them out of every pocket first."
- `sourceUrl` and `sourceQuote` are filled from the FAA page at generation time, quote-verified (D7) and admin-approved; no citation is invented here.
- `condition`: `{ any: [ { answer: "power_bank", op: "eq", value: true }, { lever: <USB port and battery pocket>, op: "is_true" } ] }`. It shows when:
  - the user carries a power bank (in any pocket); or
  - the bag has a battery pocket.
  
  With power bank unanswered and the pocket "no", or the pocket unknown, it shows "may apply". Gate-checking is assumed possible for any carry-on (Q18).

### D14. Failure modes
- **Two admins re-ranking:** the node lock and version give the second a 409. The database lock in the rank triggers covers writers that bypass the API. Publish checks the same version.
- **Partial publish:** one transaction. An error leaves the previous public state, and the deferred trigger refuses fewer than 5 approved levers or a rank gap.
- **A run writing during review:** the existing busy check (`publish.ts:65-78`). LEVERS appends under the node lock and bumps the version.
- **Deploy:** stop the old instances, migrate, start the new ones, as for cadence changes. The API is down for that window. Data stays intact and published nodes are unchanged afterwards. An old instance left running fails on the dropped `position` column.
- **Survey spam:** IP limit, single-use token, honeypot, key limit, then quarantine (D12). Residual risk F1.
- **Device storage lost:** no prefill. Deletion then needs a receipt or a check-in email.
- **A source page blocked or unreachable:** the safety rule or fact stays `UNVERIFIED`. Publish refuses an approved rule in that state; Fit shows the fact as Unverified.
- **Check-in email failure:** the response is already committed. The failure is logged like account emails (`task`, `errorClass`), and the user can retry.

## Schema and migration plan
- **How migrations are applied:** each one with `prisma migrate deploy` only, and each stands alone.
- **Generated versus hand-written SQL:** column, enum, table and default DDL comes from `prisma migrate diff --script`. Only CHECKs, triggers, expression and partial indexes, and data steps are hand-written, as `migrate diff` ignores them.
- **One transaction per migration:** each migration runs as one transaction, so a failure leaves no change.

1. **`lever_badge_enums`** (enum changes only; nothing uses a new value in the same migration, as in `20261115000000_review_stage_two_weeks`): `LeverBadge`, `LeverType` + `RATING_ONLY`, `EmailRateKind` + `SURVEY_CHECKIN_EMAIL`.
2. **`lever_ranking`**, in this order. The deferred 0-or-5 trigger is dropped before any `node_levers` write, so no trigger events are pending when later `ALTER TABLE`s run.
   1. Add columns:
      - `taxonomy_nodes.leverRankingVersion INT NOT NULL DEFAULT 0`;
      - `lever_definitions.ownerRatable BOOLEAN` (nullable) and `notRatableReason`;
      - `node_levers`: `rank`, `publishedRank`, `badges "LeverBadge"[] NOT NULL DEFAULT '{SPEC}'`, `fitRule`, `tradeOff`.
   2. Drop trigger `node_levers_approved_count`, its function, and the CHECKs `node_levers_position_iff_approved` and `node_levers_position_range` (`20261120000200…:107-110,196-220`).
   3. Backfill:
      - `APPROVED`: `rank = publishedRank = position`, and the snapshot gains `"badges":["SPEC"]`.
      - `CANDIDATE`: rank = approved count + `row_number()` by `(createdAt, id)`. The model's order was never stored (`runs.ts:365`), so the admin re-ranks.
      - `RETIRED`: null.
      - `ownerRatable`: false with `notRatableReason = 'Safety lever: an admin decides'` for safety-flagged definitions and for definitions used on safety-critical nodes; true for the others. Every existing type has manufacturer values, so SPEC is correct.
   4. Add the new CHECKs (D1, D2): the deferred `node_levers_check_ranks`, the node advisory lock in `node_levers_before_write`, the badge, definition-edit and `RATING_ONLY` value triggers.
   5. Drop `node_levers.position` and its unique index. New code never reads it; old instances are stopped (D14).
   
   **Published nodes keep:** `publishedAt`, the same five levers in order, `published_lever_values` and `listed`.
3. **`value_dimension_basis`** (only if Q2 is accepted): `CREATE TYPE "DimensionBasis"`, and `dimensionBasis NOT NULL DEFAULT 'UNSTATED'` on `product_lever_values` and `published_lever_values`. Existing rows read Unverified for Fit until re-extraction.
4. **`node_dependencies_safety_rules`:**
   - Tables: `node_dependencies`, `dependency_options`, `dependency_option_facts`, `node_dependency_levers`, `fact_source_hosts`, `safety_rules`, `safety_rule_levers`.
   - CHECKs: `relatedNodeId IS NULL OR kind = 'PRODUCT'`; a decision has who and when; a verified source has an https URL and a quote.
   - Triggers: decision nodes; same-node levers; acyclic `PRODUCT` edges under the advisory lock; safety-rule levers set `safety` (D7).
   - No existing data.
5. **`travel_taxonomy`** (data, in the style of `launch_taxonomy`):
   - Nodes, all unpublished: `travel` and `luggage` (navigation); `carry-on`, `checked-luggage` and `personal-item` (decision), with search terms.
   - It uses `ON CONFLICT (slug) DO NOTHING`, then `RAISE EXCEPTION` naming any existing slug with a different kind or parent. An admin-made node is never converted.
   - **Recovery:** fix or rename that node, run `cd backend && npx prisma migrate resolve --rolled-back <migration name>`, then `npm run db:deploy` again.
   - In code, `LAUNCH_ORDER` (`admin.ts:47`) puts `carry-on` first. The Seats secondary parent already exists (`launch_taxonomy` :51-54).
6. **`owner_survey`:**
   - Enums for D9–D12.
   - Tables: `survey_templates`, `survey_template_levers`, `survey_form_tokens`, `survey_responses`, `survey_lever_ratings`, `survey_importance_picks`, `survey_response_demographics`, `survey_check_ins`, `survey_aggregate_snapshots`, `demographic_profiles`.
   - Indexes:
     - one `ACTIVE` template per node;
     - unique `clientSubmissionId`;
     - the device-product expression index (D10);
     - `(nodeId, submittedAt)` and `(productId, submittedAt)` for the breaker;
     - `survey_check_ins(status, sendAfter)` and `(emailHash)`.
   - CHECKs: ranges; `PREFER_NOT` exclusive; `zip3 ~ '^[0-9]{3}$'`; product XOR Other text.
   - Triggers: ratings and picks follow the template; `RATED` levers are ratable; a template with responses is immutable.
   - No foreign key to `review_threads`, `reviews` or `nudges`.

**Follow-ups, not in this plan:**
- `product_prices` (Q4, its own migration if accepted).
- The ML read-only role and `ML_DATABASE_URL` (Q16; ops and env).
- `safety_acknowledgements` (Phase B).

**Code:**
- Add the new models and fields to `REQUIRED_MODELS` (`backend/src/lib/prismaClientGuard.ts`).
- Document the new env vars (`SURVEY_TOKEN_SECRET`, `SURVEY_RATE_LIMIT_MAX`, `SURVEY_NODE_HOURLY_MAX`, `SURVEY_PRODUCT_HOURLY_MAX`) in `.env.example`, CLAUDE.md and `docs/api.md`.

## Testing plan
- **Backend:** real Postgres; pure functions tested directly; one ML test.
- **Browser pass:**
  - desktop: the ranked board and the Dependencies and Safety steps;
  - desktop and 390 px: the category page's featured panel, full list and Safety section, and the public survey page (taps only).

| Rule | Test | Mutation that must fail it |
| --- | --- | --- |
| Rank integrity | Ranks stay 1..n through add, reorder, remove and retire. A direct SQL duplicate or gap fails at commit; a swap in one transaction passes. A `CANDIDATE` with a null rank is refused. | drop the deferred trigger; drop the candidate CHECK; skip the shift on remove |
| Rank under concurrency | Two transactions each append rank n+1 to one node by direct SQL: one commits, the other fails | drop the advisory lock in either trigger |
| Featured five and version | Two reorders with the same `seen`: one 200, one 409. Publish with a stale `seen`, a different set, or **the same set in another order** → 409. | skip the version check; compare sets without order |
| Badge integrity | FIT without SPEC or `fitRule`; SPEC on `RATING_ONLY`; EXPERIENCE on a lever whose definition is not ratable; empty badges: each refused by the database | drop each CHECK or trigger branch |
| Definition edits keep badges valid | Changing a definition to `RATING_ONLY` while a lever has SPEC or it has values; setting `ownerRatable` false while EXPERIENCE or a rated template uses it; flagging safety while it is ratable; inserting a value for a `RATING_ONLY` definition: each refused | drop each branch of the definitions trigger; drop the value trigger |
| Badge-dependent gate | 18 products: a featured SPEC lever at 14/18 is refused and named; 15/18 passes; a featured Experience-only lever with no values passes; a rank-6 SPEC lever at 0% passes; a featured SPEC+EXPERIENCE lever is gated | gate every featured lever; gate none; use rank ≤ 6; skip multi-badge levers |
| Publish snapshot and atomicity | An injected failure leaves the previous public state. Values of every SPEC lever are published. A re-rank after publish changes no public read. A removed published lever is retired. | read `rank` publicly; copy only featured values |
| Migration 2 | Seed a node with five approved levers, candidates and a retired lever, plus a safety-flagged definition, then migrate. It applies without error; same order; values readable; badges `["SPEC"]`; candidates ranked 6+; retired rank null; still published; the safety definition is not ratable. | backfill before dropping the old trigger; number candidates from 1; default `ownerRatable` to true |
| Fit results | No answer → `NOT_SHOWN`. Unknown, unpublished, wrong basis, unverified or stale fact, `CONTAINS` miss, "other" related product → `UNVERIFIED`. Equal → `FITS`; +0.01 → `DOES_NOT_FIT`. cm facts are converted. `ALL` over two airlines. `LINEAR_SUM_LTE`. `ALLOWANCE` never `FITS`. The filter keeps `UNVERIFIED` products. | treat unknown as fits; ignore basis; `<` for `≤`; `ANY` for `ALL`; skip conversion; read `product_lever_values` |
| Trade-off never a hidden input | Permuting a Trade-off lever's values leaves the default order and filters identical. No preference, or the neutral one → no effect. Publish refuses bad sides or keys; `match` without SPEC is refused. | default to the first side; sort by the Trade-off value |
| Dependency gates | A `PRODUCT` cycle, direct or indirect, gives a 400 and a trigger error; two concurrent edges cannot form one. `gateOrder` puts the infant seat before the stroller, with the reason. A dependency with no Fit rule gives no gate. A constrained lever on another node is refused. | drop the trigger or its lock; reverse the order; gate every product dependency |
| Option facts | A paraphrased quote gives `UNVERIFIED`; a host not on `fact_source_hosts` is not fetched; `checkedAt` is set and shown | skip the host permit; skip the quote check |
| Safety evaluation | Triggers with a power bank, or a pocket true. "May apply" with the power-bank question unanswered and pocket false, or with the pocket unknown. Hidden when both are false. Listed on the category page with no project. | treat UNKNOWN as FALSE; use `all` |
| Safety levers reviewed individually | An approved rule referencing a lever makes it `safety`; bulk accept of its values is refused (API and trigger); publish refuses a condition and `safety_rule_levers` that differ | drop the rule-lever trigger |
| Safety warning not silent (Phase B) | No ack row → the milestone is blocked. The ack records user, time and rule hash. A new rule version or changed answers trigger it again. | key the ack on the rule id only; skip `answersHash` |
| Safety source | An approved or published rule with an `UNVERIFIED` source, or a non-authority host, is refused | skip the host check; accept unverified at publish |
| Survey never reaches reviews | A prefilled submission creates no thread, review or nudge, and changes no drift, `avgRating*` or `totalReviewCount`. ML: the loader SQL names no `survey_`/`demographic_` table. | create a thread; add a survey join to the loader |
| Templates | A second `ACTIVE` template per node is refused. A template with responses cannot be edited. Activation with a non-ratable rated lever → 400 naming the lever (API). The same by direct SQL → trigger error. | drop the partial index; drop the immutability trigger; drop the API check (the trigger test holds); drop the trigger (the API test holds) |
| Demographics access | No public, user or admin response body contains a raw row (D11 definition). `/auth/me` has no `demographic_profiles` fields. A non-admin gets 403. | return a snapshot row to admins; include the profile in `/auth/me` |
| Aggregates | A cell of 9 → "fewer than 10", 10 shown; complementary suppression; quarantined rows excluded. No snapshot until 10 new responses. `submittedAt` truncated after 24 h. | `<` for `≤`; drop complementary suppression; snapshot on every response |
| Deletion | By key: all of a device's responses, with cascade and follow-ups. By receipt: one. By email: link only when a check-in matches, always 202, and confirming deletes. Unknown inputs → the same answer. Both profile deletes work. | drop a cascade; answer 404 for unknown; delete without confirming the link |
| Retention | Demographics and `moreText` are purged at 24 months, unconfirmed check-ins at 7 days, used tokens at 24 h; ratings stay | drop each purge clause |
| Logging | A survey POST with malformed JSON, one failing zod and one failing in Prisma: captured logs contain no submitted value, IP, user agent or query | log `err` (with `err.body`) in `errorHandler`; remove the morgan skip |
| Public survey route and abuse | 429 after `SURVEY_RATE_LIMIT_MAX`. A token reused, fresh or expired → 400. A filled honeypot → 400. The 101st response in an hour → quarantined, the 100th not. A prefill from another node, outside the catalog, or dry run → ignored. A POST with another node's product, more than 3 picks, an outside lever or an unknown key → 400. The same `clientSubmissionId` → one row. The same device and product, also across template versions → updated in place, same id. | allow token reuse; `>` vs `≥` in the breaker; count outside the lock; key the index on `templateId`; remove `.strict()` |
| Check-in consent | No send without `confirmedAt`; consent text stored; an over-limit address gets the same 202 and no email; address nulled 30 days after sending | send unconfirmed rows; answer 429 |
| Travel taxonomy migration | Creates the five nodes; an existing `luggage` decision node makes it raise with the slug | `DO UPDATE` on conflict |

## Out of scope
- Projects (Phase B): templates, `UserProject`, the roadmap, purchase recording, and the `safety_acknowledgements` table. Only the answer contract, `gateOrder` and the acknowledgement design are here.
- Ranking (Phase C).
- `ReviewLeverRating` and per-category check-ins.
- Run-time reading, the retro interview, "ask the owners", review imports, licensed sources and review synthesis.
- Purchase interface; automatic refresh of airline facts beyond Re-check.
- Demand-driven categories; Kids furniture; bundles.

## Open questions
1. **The recommender uses each user's demographics** (`recommender.py:43-50,286-288`; `recommendations.ts:31-41`), against the aggregate-only commitment (spec :238). **Recommended default:** before the demographics page goes live, set the demographic weight to 0, stop sending `UserDemographics` to `/recommend`, and drop it from `/auth/me`; the Best Fit ADR decides what returns. Alternative: keep it, and limit the page's commitments to survey answers.
2. **Dimension basis.** **Recommended default:** `dimensionBasis` on values (`WITH_WHEELS`/`CASE_ONLY`/`UNSTATED`), set only when the quote states it; Fit needing wheels shows Unverified otherwise. Alternative: assume wheels are included.
3. **Several verified hosts per brand** already work (`host` is unique, `brandKey` only indexed: `schema.prisma:998-1010`). One host cannot serve two brands. **Recommended default:** wait until a launch node needs it. Alternative: a brand-host join table now.
4. **List price.** **Recommended default:** a follow-up `product_prices` table (amount, currency, source on a verified brand host, verbatim quote, `observedAt`), shown "List price $X on brand.com, checked <date>", never a ranking input. Alternative: a USD measurement lever (no date, counts toward coverage).
5. **Structured warranty.** **Recommended default:** three shared definitions (term in years, airline damage, registration needed); no schema change. Alternative: a composite type.
6. **Evidence by time owned.** **Recommended default:** show owner scores split by ownership band; weighting goes to the Phase C ADR. Alternative: weight now with the stage weights.
7. **Source-quality filter.** **Recommended default:**
   - a coded domain list `generation/sources.ts` mapping a host to a `SourceClass` (`MANUFACTURER`, `EXPERT_PUBLISHER`, `FORUM`, `BLOG`, `EXCLUDED`; Reddit `EXCLUDED`);
   - a non-null `sourceClass` on every stored citation;
   - an `evidence_citations` table (`runId`, `nodeId`, `definitionId?`, `url`, `host`, `sourceClass`, `retrievedAt`), created with run-time reading after counsel signs off.
   
   Alternative: decide it then.
8. **Experience ratings before `ReviewLeverRating`.** **Recommended default:** survey ratings only, labelled; review ratings are shown separately later. Alternative: nothing until reviews carry ratings.
9. **Travel and Luggage nodes.** **Recommended default:** the `travel_taxonomy` migration. Alternative: create them in the admin UI (environments drift).
10. **The survey makes catalog content public before the first publish:** approved product names (an exception to `products.ts:16-18`), and candidate lever names and explanations not yet approved. **Recommended default:** allow brand and model names and the template's lever names and explanations only, with no links or values; the admin reviews them when activating the template. Alternative: survey only published nodes.
11. **Income bands.** **Recommended default:** under $50k, $50–100k, $100–150k, $150–200k, $200k+. Alternative: Census quintiles.
12. **ZIP.** **Recommended default:** the device keeps 5 digits; the server stores 3. Alternative: store 5.
13. **Thresholds.** **Recommended default:** demographic cells ≥ 10; node-level owner scores ≥ 5; per-product survey scores ≥ 20 plus an admin release. Alternative: 5 for all.
14. **Featured levers without SPEC.** **Recommended default:** the board warns below 3. Alternative: require 3.
15. **Fit coverage without the basis.** **Recommended default:** counts toward the gate; the card shows how many state the basis. Alternative: count only `WITH_WHEELS`.
16. **ML database access.** **Recommended default:** a follow-up giving the ML service a read-only role (`ML_DATABASE_URL`) with no grant on survey or demographic tables, before the public survey launches. Alternative: code-only isolation.
17. **Hardside or softside without SPEC.** **Recommended default:** add SPEC (CATEGORY: hardside, softside, hybrid) and keep it not ratable. Alternative: advice only.
18. **Gate-checking in the FAA rule.** **Recommended default:** assume any carry-on may be gate-checked. Alternative: a `may_be_checked` question.
19. **Minimum age.** **Recommended default:** a "16 or older" statement before submitting, pending counsel. Alternative: no gate.
20. **Derived Fit operands** (headroom = ceiling − bed − mattress, spec :72). **Recommended default:** defer to the bunk-bed node's design, adding a `difference` operand then. Alternative: add arithmetic operands now.
21. **Which product dependencies gate a project.** The spec says "every category's product dependencies become gates in its project template" (spec :284). This design gates only a product dependency whose constrained levers include a Fit rule against the related product (D6), because a gate with nothing to check blocks the buyer for no reason; the rest order the roadmap (the related product first) without blocking. **Recommended default:** as designed, and the spec wording is updated to "become ordered steps, and gates where a Fit check exists". Alternative: every product dependency blocks until its related product is chosen, even with nothing to check.
